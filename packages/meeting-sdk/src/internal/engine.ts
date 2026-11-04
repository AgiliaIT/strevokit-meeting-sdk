import {
  type IceServerConfig,
  type MediaMode,
  ROLE_POLICY,
  type SignalingMessage,
  isRoleAllowed,
} from "@strevokit/signaling-protocol";
import { MeetingError, type MeetingErrorCode } from "../public/errors.js";
import type {
  CloseReason,
  ConnectionState,
  LocalMedia,
  MediaConnectionStatus,
  MediaDeviceOptions,
  MediaKind,
  MediaState,
  MeetingEngine,
  MeetingEventListener,
  MeetingEventMap,
  MeetingEventType,
  MeetingLogger,
  Participant,
  ParticipantRole,
  RemoteMedia,
  SelfParticipant,
} from "../public/types.js";
import { Emitter } from "./emitter.js";
import type { EngineEnvironment, TimerHandle } from "./env.js";
import { mapClose, mapLeftReason, mapRejection } from "./errorMapping.js";
import { LocalMediaController } from "./localMedia.js";
import { Log } from "./log.js";
import { type MediaDelivery, SignalingOnlyMediaDelivery } from "./mediaDelivery.js";
import {
  ReconnectController,
  type ReconnectOpenResult,
  type ReconnectReasonClass,
  type ReconnectTrigger,
} from "./reconnect/index.js";
import { Roster } from "./roster.js";
import { type OutboundType, SignalingSession } from "./signalingSession.js";
import { decodeAddressing, isJoinTokenUsable, type Addressing } from "./token.js";

const LEAVE_FALLBACK_MS = 5000;
const RESTRICTED_PENDING_MS = 2000;
const END_MEETING_TIMEOUT_MS = 10_000;

export interface EngineConfig {
  token: string;
  realtimeUrl: string;
  joinTimeoutMs: number;
  logger: MeetingLogger | undefined;
  addressing: Addressing;
  env: EngineEnvironment;
  /** Optional callback to mint a fresh join token during automatic recovery. */
  getJoinToken?: () => Promise<string>;
  /** Continuous unsuccessful recovery budget in ms. */
  reconnectWindowMs?: number;
  /** Chooses how media is carried once the welcome says how the platform routes this meeting. */
  createMediaDelivery: MediaDeliveryFactory;
}

export type MediaDeliveryFactory = (
  mediaMode: MediaMode | undefined,
  deps: { env: EngineEnvironment; log: Log },
) => MediaDelivery;

const MEDIA_KINDS: readonly MediaKind[] = ["camera", "microphone", "screen"];

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: MeetingError) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: MeetingError) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mediaFrame(type: string): { kind: MediaKind; enabled: boolean } | undefined {
  const match = /^media\.(camera|microphone|screen)\.(started|stopped)$/.exec(type);
  if (!match) return undefined;
  return { kind: match[1] as MediaKind, enabled: match[2] === "started" };
}

export class MeetingEngineImpl implements MeetingEngine {
  readonly #realtimeUrl: string;
  readonly #joinTimeoutMs: number;
  readonly #addressing: Addressing;
  readonly #env: EngineEnvironment;
  readonly #createDelivery: MediaDeliveryFactory;
  readonly #getJoinToken: (() => Promise<string>) | undefined;
  readonly #reconnectWindowMs: number;
  readonly #logger: MeetingLogger | undefined;
  #delivery: MediaDelivery = new SignalingOnlyMediaDelivery();
  readonly #log: Log;
  readonly #emitter: Emitter<MeetingEventMap>;
  readonly #roster = new Roster();
  readonly #media: LocalMediaController;

  #token: string | undefined;
  #state: ConnectionState = "idle";
  #disposed = false;
  #session: SignalingSession | undefined;
  #self: SelfParticipant | null = null;
  #role: ParticipantRole | undefined;
  #join: Deferred | undefined;
  #leave: Deferred | undefined;
  #joinTimer: TimerHandle | undefined;
  #leaveTimer: TimerHandle | undefined;
  #endMeeting: Deferred | undefined;
  #endMeetingTimer: TimerHandle | undefined;
  #pendingRestricted: { kind: MediaKind; timer: TimerHandle } | undefined;
  #reconnect: ReconnectController | undefined;
  #reconnectOpen: Deferred | undefined;
  #reconnectOutcome: ReconnectOpenResult | undefined;
  #preRecoveryParticipants: readonly Participant[] | undefined;
  #pendingAbandonReason: ReconnectReasonClass | undefined;
  #onVisibility: (() => void) | undefined;

  constructor(config: EngineConfig) {
    this.#token = config.token;
    this.#realtimeUrl = config.realtimeUrl;
    this.#joinTimeoutMs = config.joinTimeoutMs;
    this.#addressing = config.addressing;
    this.#env = config.env;
    this.#createDelivery = config.createMediaDelivery;
    this.#getJoinToken = config.getJoinToken;
    this.#reconnectWindowMs = config.reconnectWindowMs ?? 120_000;
    this.#logger = config.logger;
    this.#log = new Log(config.logger);
    this.#emitter = new Emitter(this.#log);
    this.#media = new LocalMediaController(
      config.env,
      {
        announce: (kind, enabled) => this.#announce(kind, enabled),
        changed: (kind, enabled, stream) => {
          this.#emit("local_media_changed", { kind, enabled, stream });
          this.#delivery.localMediaChanged(kind, stream);
        },
      },
      this.#log,
    );
    this.#installVisibilityListener();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get self(): SelfParticipant | null {
    return this.#self;
  }

  get participants(): readonly Participant[] {
    return this.#roster.list();
  }

  get localMediaState(): MediaState {
    return this.#media.state;
  }

  get localMedia(): LocalMedia {
    return this.#media.streams;
  }

  remoteMedia(participantId: string): RemoteMedia {
    return this.#delivery.remoteMedia(participantId);
  }

  mediaConnectionStatus(participantId: string): MediaConnectionStatus | null {
    return this.#delivery.connectionStatus(participantId);
  }

  join(): Promise<void> {
    if (this.#state === "closed") return Promise.reject(new MeetingError("engine_closed"));
    if (this.#state !== "idle") return Promise.reject(new MeetingError("already_joined"));
    const token = this.#token;
    if (!this.#env.WebSocket || token === undefined) return Promise.reject(new MeetingError("unsupported_environment"));

    const join = deferred();
    this.#join = join;
    this.#setState("connecting");
    if (!this.#is("connecting")) return join.promise;

    this.#joinTimer = this.#env.setTimeout(() => this.#failJoin(new MeetingError("join_timeout")), this.#joinTimeoutMs);
    this.#openSession(token);
    return join.promise;
  }

  leave(): Promise<void> {
    switch (this.#state) {
      case "idle":
      case "closed":
        return Promise.resolve();
      case "leaving":
        return this.#leave?.promise ?? Promise.resolve();
      case "connecting":
      case "joining":
        this.#failJoin(new MeetingError("join_cancelled"));
        return Promise.resolve();
      case "reconnecting":
        this.#cancelReconnect("left");
        this.#finish("left");
        return Promise.resolve();
      case "joined":
        break;
    }
    const leave = deferred();
    this.#leave = leave;
    this.#media.releaseAll();
    this.#releaseRemoteMedia();
    this.#setState("leaving");
    if (!this.#is("leaving")) return leave.promise;
    if (!this.#session?.send("participant.leave")) {
      this.#finish("left");
      return leave.promise;
    }
    this.#leaveTimer = this.#env.setTimeout(() => this.#finish("left"), LEAVE_FALLBACK_MS);
    return leave.promise;
  }

  endMeeting(): Promise<void> {
    if (this.#state !== "joined") return Promise.reject(new MeetingError("not_joined"));
    if (this.#role !== "host") return Promise.reject(new MeetingError("not_permitted"));
    if (this.#endMeeting) return this.#endMeeting.promise;

    const pending = deferred();
    this.#endMeeting = pending;
    if (!this.#session?.send("meeting.end")) {
      this.#endMeeting = undefined;
      return Promise.reject(new MeetingError("service_unavailable"));
    }
    this.#endMeetingTimer = this.#env.setTimeout(() => {
      const p = this.#endMeeting;
      this.#endMeeting = undefined;
      this.#endMeetingTimer = undefined;
      p?.reject(new MeetingError("service_unavailable"));
    }, END_MEETING_TIMEOUT_MS);
    return pending.promise;
  }

  enableCamera(options?: MediaDeviceOptions): Promise<void> {
    return this.#mediaCall("camera", true, options?.deviceId);
  }

  disableCamera(): Promise<void> {
    return this.#mediaCall("camera", false);
  }

  mute(): Promise<void> {
    return this.#mediaCall("microphone", false);
  }

  unmute(options?: MediaDeviceOptions): Promise<void> {
    return this.#mediaCall("microphone", true, options?.deviceId);
  }

  startScreenShare(): Promise<void> {
    return this.#mediaCall("screen", true);
  }

  stopScreenShare(): Promise<void> {
    return this.#mediaCall("screen", false);
  }

  on<K extends MeetingEventType>(type: K, listener: MeetingEventListener<K>): () => void {
    if (this.#disposed) return () => undefined;
    return this.#emitter.on(type, listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeVisibilityListener();
    this.#emitter.clear();
    const end = this.#endMeeting;
    this.#endMeeting = undefined;
    this.#cancelReconnect("hard_failure");
    this.#teardown();
    this.#state = "closed";
    const join = this.#join;
    this.#join = undefined;
    if (join) {
      join.promise.catch(() => undefined);
      join.reject(new MeetingError("join_cancelled"));
    }
    this.#leave?.resolve();
    end?.reject(new MeetingError("engine_closed"));
  }

  #mediaCall(kind: MediaKind, enabled: boolean, deviceId?: string): Promise<void> {
    if (this.#state !== "joined") return Promise.reject(new MeetingError("not_joined"));
    if (kind === "screen") {
      const type = enabled ? "media.screen.started" : "media.screen.stopped";
      if (this.#role === undefined || !isRoleAllowed(type, this.#role)) {
        return Promise.reject(new MeetingError("not_permitted"));
      }
      // Refuse before getDisplayMedia when this meeting cannot deliver screen bits to peers.
      if (enabled && !this.#delivery.supportsScreenShare()) {
        return Promise.reject(new MeetingError("unsupported_environment"));
      }
    }
    return this.#media.set(kind, enabled, typeof deviceId === "string" && deviceId !== "" ? deviceId : undefined);
  }

  #announce(kind: MediaKind, enabled: boolean): boolean {
    if (this.#state !== "joined") return false;
    const type = `media.${kind}.${enabled ? "started" : "stopped"}` as OutboundType;
    if (!this.#session?.send(type)) return false;
    if (this.#pendingRestricted?.kind === kind) this.#clearPendingRestricted();
    if (ROLE_POLICY[type]) {
      this.#pendingRestricted = {
        kind,
        timer: this.#env.setTimeout(() => {
          this.#pendingRestricted = undefined;
        }, RESTRICTED_PENDING_MS),
      };
    }
    return true;
  }

  #clearPendingRestricted(): void {
    if (this.#pendingRestricted) this.#env.clearTimeout(this.#pendingRestricted.timer);
    this.#pendingRestricted = undefined;
  }

  #onMessage(message: SignalingMessage): void {
    const state = this.#state;
    if (state === "closed" || state === "idle") return;
    const from = message.participantId;
    const isSelf = from === this.#addressing.participantId;

    switch (message.type) {
      case "session.authenticated": {
        if (state === "connecting") {
          this.#role = message.payload.role;
          this.#setState("joining");
          if (!this.#is("joining")) return;
          if (!this.#session?.send("participant.join")) this.#failJoin(new MeetingError("connection_failed"));
          return;
        }
        if (state === "reconnecting") {
          this.#role = message.payload.role;
          if (!this.#session?.send("participant.join")) this.#failReconnectOpen(new MeetingError("connection_failed"));
        }
        return;
      }
      case "session.welcome": {
        if (state === "joining") {
          this.#clearTimer("join");
          this.#roster.commit();
          const payload = message.payload;
          const self: { id: string; role: ParticipantRole; joinedAt: string; displayName?: string } = {
            id: this.#addressing.participantId,
            role: payload.role,
            joinedAt: payload.joinedAt,
          };
          if (payload.displayName !== undefined) self.displayName = payload.displayName;
          this.#self = Object.freeze(self);
          this.#role = payload.role;
          const join = this.#join;
          this.#join = undefined;
          this.#setState("joined");
          this.#emit("joined", { self: this.#self, participants: this.#roster.list() });
          join?.resolve();
          if (this.#is("joined")) {
            const expiresAt = payload.iceServersExpireAt !== undefined ? Date.parse(payload.iceServersExpireAt) : NaN;
            this.#startDelivery(payload.mediaMode, payload.iceServers ?? [], Number.isFinite(expiresAt) ? expiresAt : null);
          }
          return;
        }
        if (state === "reconnecting") {
          this.#completeReconnectWelcome(message);
        }
        return;
      }
      case "session.ice_servers": {
        if (!this.#is("joined")) {
          this.#log.debug("frame ignored", { messageType: message.type, state });
          return;
        }
        const expiresAt = Date.parse(message.payload.expiresAt);
        if (Number.isFinite(expiresAt)) this.#delivery.iceServersUpdated(message.payload.iceServers, expiresAt);
        return;
      }
      case "participant.joined": {
        if (isSelf || state === "connecting") return;
        const result = this.#roster.upsertJoined(from, message.payload.role, message.payload.displayName);
        // During recovery, snapshot frames rebuild the roster quietly (no leave/join flash).
        if (state === "reconnecting") return;
        const participant = this.#roster.get(from);
        if (result === "added" && participant) {
          this.#emit("participant_joined", { participant });
          const present = this.#roster.committed && this.#is("joined") ? this.#roster.get(from) : undefined;
          if (present) this.#delivery.peerPresent(from, present.media);
        }
        return;
      }
      case "participant.left": {
        if (isSelf || state === "connecting" || state === "reconnecting") return;
        if (this.#roster.remove(from) && this.#roster.committed) {
          this.#delivery.peerLeft(from);
          this.#emit("participant_left", { participantId: from, reason: mapLeftReason(message.payload.reason) });
        }
        return;
      }
      case "participant.reconnected": {
        if (isSelf || !this.#roster.committed) return;
        // Presence may have removed the peer briefly before the supersede frame arrives — restore one entry.
        if (!this.#roster.get(from)) {
          this.#roster.upsertJoined(from, "participant");
          const restored = this.#roster.get(from);
          // Do not emit participant_joined: reconnect frames lack authoritative role/displayName.
          if (restored && this.#is("joined")) this.#delivery.peerPresent(from, restored.media);
        }
        this.#delivery.peerReconnected(from);
        this.#emit("participant_reconnected", { participantId: from });
        return;
      }
      case "media.camera.started":
      case "media.camera.stopped":
      case "media.microphone.started":
      case "media.microphone.stopped":
      case "media.screen.started":
      case "media.screen.stopped": {
        const change = mediaFrame(message.type);
        if (isSelf || state === "connecting" || !change) return;
        if (this.#roster.setMedia(from, change.kind, change.enabled) && this.#roster.committed) {
          this.#emit("participant_media_changed", { participantId: from, kind: change.kind, enabled: change.enabled });
          this.#delivery.peerMediaChanged(from, change.kind, change.enabled);
        }
        return;
      }
      case "meeting.ended":
      case "meeting.terminated": {
        this.#log.info("meeting ended", { messageType: message.type });
        if (state === "connecting" || state === "joining") this.#failJoin(new MeetingError("meeting_ended"));
        else {
          this.#cancelReconnect("meeting_ended");
          this.#finish("meeting_ended");
        }
        return;
      }
      case "session.rejected": {
        const payload = message.payload as { code: string; detail?: string; ref_type?: string; refType?: string };
        const isEndMeetingRejection =
          payload.ref_type === "meeting.end" || payload.refType === "meeting.end" || this.#endMeeting !== undefined;
        if (this.#endMeeting && isEndMeetingRejection) {
          const pending = this.#endMeeting;
          this.#clearEndMeetingTimer();
          this.#endMeeting = undefined;
          let mappedCode: MeetingErrorCode = "service_unavailable";
          if (payload.code === "role_not_allowed") mappedCode = "not_permitted";
          else if (payload.code === "rate_limited") mappedCode = "rate_limited";
          pending.reject(new MeetingError(mappedCode));
          return;
        }
        this.#onRejected(payload.code);
        return;
      }
      case "webrtc.offer":
      case "webrtc.answer":
      case "webrtc.ice_candidate":
      case "webrtc.ice_restart":
        this.#delivery.onPeerFrame(message);
        return;
      default:
        this.#log.debug("frame ignored", { messageType: message.type });
    }
  }

  #startDelivery(
    mediaMode: MediaMode | undefined,
    iceServers: readonly IceServerConfig[],
    iceServersExpireAt: number | null,
  ): void {
    const delivery = this.#createDelivery(mediaMode, { env: this.#env, log: this.#log });
    this.#delivery = delivery;
    delivery.attach({
      participantId: this.#addressing.participantId,
      iceServers,
      iceServersExpireAt,
      send: (type, payload) => this.#delivery === delivery && (this.#session?.sendPeer(type, payload) ?? false),
      emit: (type, event) => {
        if (this.#delivery === delivery) this.#emit(type, event);
      },
    });
    const local = this.#media.streams;
    for (const kind of MEDIA_KINDS) {
      const stream = local[kind];
      if (stream) delivery.localMediaChanged(kind, stream);
    }
    if (this.#delivery !== delivery || !this.#is("joined")) return;
    delivery.peersPresent(this.#roster.list().map((participant) => ({ id: participant.id, media: participant.media })));
  }

  /** Reports every remote media and connection status as gone, then closes the delivery. */
  #releaseRemoteMedia(): void {
    const delivery = this.#delivery;
    for (const participant of this.#roster.list()) {
      const media = delivery.remoteMedia(participant.id);
      for (const kind of MEDIA_KINDS) {
        if (media[kind]) this.#emit("remote_media_changed", { participantId: participant.id, kind, stream: null });
      }
      if (delivery.connectionStatus(participant.id) !== null) {
        this.#emit("media_connection_changed", { participantId: participant.id, status: null });
      }
    }
    delivery.close();
  }

  #onRejected(code: string): void {
    const error = mapRejection(code);
    if (this.#state === "connecting" || this.#state === "joining") {
      this.#failJoin(error);
      return;
    }
    if (this.#state === "reconnecting" && this.#reconnectOpen) {
      const session = this.#session;
      this.#session = undefined;
      session?.close();
      this.#failReconnectOpen(error, error.retryable);
      return;
    }
    if (code === "role_not_allowed") {
      const pending = this.#pendingRestricted;
      this.#clearPendingRestricted();
      if (pending) this.#media.rollback(pending.kind);
    }
    this.#log.warn("request rejected", { code: error.code });
    this.#emit("error", { error });
  }

  #onProtocolError(): void {
    if (this.#state === "closed") return;
    this.#emit("error", { error: new MeetingError("protocol_error") });
  }

  #onClose(session: SignalingSession, code: number): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    this.#log.info("connection closed", { closeCode: code });
    switch (this.#state) {
      case "connecting":
      case "joining": {
        const { error } = mapClose(code, "before_joined");
        this.#failJoin(error ?? new MeetingError("connection_failed"));
        return;
      }
      case "joined": {
        const { reason, error } = mapClose(code, "after_joined");
        if (reason === "left" || reason === "meeting_ended" || reason === "session_replaced") {
          this.#finish(reason, error);
          return;
        }
        if (this.#isRecoverableClose(reason, error)) {
          this.#beginRecovery("meeting_service");
          return;
        }
        this.#finish(reason, error);
        return;
      }
      case "reconnecting": {
        const { reason, error } = mapClose(code, "after_joined");
        if (reason === "meeting_ended" || reason === "session_replaced") {
          this.#cancelReconnect(reason === "meeting_ended" ? "meeting_ended" : "session_replaced");
          this.#finish(reason, error);
          return;
        }
        if (reason === "left") {
          this.#cancelReconnect("left");
          this.#finish("left");
          return;
        }
        // Token failures clear the in-memory token so the next attempt can call getJoinToken.
        const tokenFailure = error?.code === "join_token_expired" || error?.code === "join_token_invalid";
        if (tokenFailure) this.#token = undefined;
        const retry = tokenFailure || this.#isRecoverableClose(reason, error);
        this.#failReconnectOpen(error ?? new MeetingError("connection_lost"), retry);
        return;
      }
      case "leaving":
        this.#finish("left");
        return;
      default:
        return;
    }
  }

  #failJoin(error: MeetingError): void {
    if (this.#state !== "connecting" && this.#state !== "joining") return;
    const join = this.#join;
    this.#join = undefined;
    this.#teardown();
    this.#log.warn("join failed", { code: error.code });
    this.#setState("closed");
    this.#emit("closed", { reason: "join_failed", error });
    join?.reject(error);
  }

  #finish(reason: CloseReason, error?: MeetingError): void {
    if (this.#state === "closed") return;
    const end = this.#endMeeting;
    this.#endMeeting = undefined;
    this.#cancelReconnect(
      reason === "meeting_ended"
        ? "meeting_ended"
        : reason === "session_replaced"
          ? "session_replaced"
          : reason === "left"
            ? "left"
            : "hard_failure",
    );
    this.#teardown();
    this.#setState("closed");
    this.#emit("closed", error ? { reason, error } : { reason });
    this.#leave?.resolve();
    if (end) {
      if (reason === "meeting_ended") end.resolve();
      else end.reject(error ?? new MeetingError("engine_closed"));
    }
  }

  #teardown(): void {
    this.#clearTimer("join");
    this.#clearTimer("leave");
    this.#clearEndMeetingTimer();
    this.#clearPendingRestricted();
    this.#media.releaseAll();
    this.#delivery.close();
    const session = this.#session;
    this.#session = undefined;
    session?.close();
    this.#roster.clear();
    this.#reconnectOpen = undefined;
    this.#reconnectOutcome = undefined;
    this.#preRecoveryParticipants = undefined;
  }

  #isRecoverableClose(reason: CloseReason, error: MeetingError | undefined): boolean {
    if (reason === "connection_lost") return true;
    if (reason === "error" && error?.code === "service_unavailable") return true;
    return false;
  }

  #beginRecovery(trigger: ReconnectTrigger): void {
    if (this.#state !== "joined" && this.#state !== "reconnecting") return;
    if (this.#endMeeting) {
      const end = this.#endMeeting;
      this.#endMeeting = undefined;
      this.#clearEndMeetingTimer();
      end.reject(new MeetingError("connection_lost"));
    }
    // Capture once before the first reset so later attempts do not overwrite with an empty roster.
    if (this.#state === "joined") this.#preRecoveryParticipants = this.#roster.list();
    this.#pauseDeliveryForRecovery();
    this.#setState("reconnecting");
    if (!this.#is("reconnecting")) return;
    if (!this.#reconnect) {
      this.#reconnect = new ReconnectController({
        env: this.#env,
        logger: this.#logger,
        windowMs: this.#reconnectWindowMs,
        open: () => this.#reconnectOpenAttempt(),
        onAbandoned: (reason) => this.#onReconnectAbandoned(reason),
      });
    }
    this.#reconnect.start(trigger);
  }

  #pauseDeliveryForRecovery(): void {
    const delivery = this.#delivery;
    for (const participant of this.#roster.list()) {
      const media = delivery.remoteMedia(participant.id);
      for (const kind of MEDIA_KINDS) {
        if (media[kind]) this.#emit("remote_media_changed", { participantId: participant.id, kind, stream: null });
      }
      if (delivery.connectionStatus(participant.id) !== null) {
        this.#emit("media_connection_changed", { participantId: participant.id, status: null });
      }
    }
    delivery.close();
    this.#delivery = new SignalingOnlyMediaDelivery();
  }

  async #reconnectOpenAttempt(): Promise<ReconnectOpenResult> {
    if (this.#state !== "reconnecting" || this.#disposed) return "cancelled";
    let token: string;
    try {
      token = await this.#resolveReconnectToken();
    } catch (error) {
      const meetingError = error instanceof MeetingError ? error : new MeetingError("join_token_invalid");
      this.#log.warn("reconnect token refresh failed", { code: meetingError.code });
      this.#pendingAbandonReason = "token_refresh_failed";
      return "failed";
    }
    this.#roster.reset();
    this.#reconnectOutcome = undefined;
    const open = deferred();
    this.#reconnectOpen = open;
    const attemptTimer = this.#env.setTimeout(() => {
      if (this.#reconnectOpen !== open) return;
      const session = this.#session;
      this.#session = undefined;
      session?.close();
      this.#failReconnectOpen(new MeetingError("join_timeout"), true);
    }, this.#joinTimeoutMs);
    this.#openSession(token);
    try {
      await open.promise;
    } catch {
      // Outcome recorded below.
    } finally {
      this.#env.clearTimeout(attemptTimer);
    }
    if (this.#state !== "reconnecting" && this.#state !== "joined") {
      return this.#reconnectOutcome ?? "cancelled";
    }
    return this.#reconnectOutcome ?? "failed";
  }

  async #resolveReconnectToken(): Promise<string> {
    const current = this.#token;
    if (current !== undefined && isJoinTokenUsable(current, this.#env.now())) return current;
    const refresh = this.#getJoinToken;
    if (!refresh) throw new MeetingError("join_token_expired");
    const next = await refresh();
    if (typeof next !== "string" || next.length === 0) throw new MeetingError("join_token_invalid");
    const addressing = decodeAddressing(next);
    if (
      addressing.meetingId !== this.#addressing.meetingId ||
      addressing.participantId !== this.#addressing.participantId
    ) {
      throw new MeetingError("join_token_invalid");
    }
    this.#token = next;
    return next;
  }

  #openSession(token: string): void {
    const session = new SignalingSession({
      env: this.#env,
      realtimeUrl: this.#realtimeUrl,
      token,
      addressing: this.#addressing,
      log: this.#log,
      callbacks: {
        onMessage: (message) => this.#onMessage(message),
        onProtocolError: () => this.#onProtocolError(),
        onClose: (code) => this.#onClose(session, code),
      },
    });
    this.#session = session;
    session.open();
  }

  #completeReconnectWelcome(message: SignalingMessage & { type: "session.welcome" }): void {
    const payload = message.payload;
    if (message.participantId !== this.#addressing.participantId) {
      this.#failReconnectOpen(new MeetingError("protocol_error"));
      return;
    }
    // Snapshot peers arrived as participant.joined frames while reconnecting; commit, join, then emit ID diffs.
    this.#roster.commit();
    const self: { id: string; role: ParticipantRole; joinedAt: string; displayName?: string } = {
      id: this.#addressing.participantId,
      role: payload.role,
      joinedAt: payload.joinedAt,
    };
    if (payload.displayName !== undefined) self.displayName = payload.displayName;
    this.#self = Object.freeze(self);
    this.#role = payload.role;
    this.#reconnectOutcome = "recovered";
    const open = this.#reconnectOpen;
    this.#reconnectOpen = undefined;
    this.#setState("joined");
    open?.resolve();
    // Listeners on state_changed / later roster events may leave(); never resume a closed engine.
    if (!this.#is("joined")) {
      this.#preRecoveryParticipants = undefined;
      return;
    }
    this.#emitRecoveryRosterDiff();
    if (!this.#is("joined")) return;
    const expiresAt = payload.iceServersExpireAt !== undefined ? Date.parse(payload.iceServersExpireAt) : NaN;
    this.#startDelivery(payload.mediaMode, payload.iceServers ?? [], Number.isFinite(expiresAt) ? expiresAt : null);
  }

  /** Announce peers who joined or left during the outage; leave survivors quiet (no join/leave flash). */
  #emitRecoveryRosterDiff(): void {
    const previous = this.#preRecoveryParticipants ?? [];
    this.#preRecoveryParticipants = undefined;
    const previousIds = new Set(previous.map((participant) => participant.id));
    const next = this.#roster.list();
    const nextIds = new Set(next.map((participant) => participant.id));
    for (const id of previousIds) {
      if (!nextIds.has(id)) this.#emit("participant_left", { participantId: id, reason: "disconnected" });
    }
    for (const participant of next) {
      if (!previousIds.has(participant.id)) this.#emit("participant_joined", { participant });
    }
  }

  #failReconnectOpen(error: MeetingError, retry = false): void {
    const open = this.#reconnectOpen;
    if (!open) return;
    this.#reconnectOpen = undefined;
    this.#reconnectOutcome = retry ? "retry" : "failed";
    if (!retry) this.#log.warn("reconnect open failed", { code: error.code });
    open.resolve();
  }

  #onReconnectAbandoned(reason: ReconnectReasonClass): void {
    if (this.#state === "closed") return;
    const actual = this.#pendingAbandonReason ?? reason;
    this.#pendingAbandonReason = undefined;
    this.#preRecoveryParticipants = undefined;
    this.#reconnect = undefined;
    if (actual === "meeting_ended") {
      this.#finish("meeting_ended");
      return;
    }
    if (actual === "session_replaced") {
      this.#finish("session_replaced", new MeetingError("session_replaced"));
      return;
    }
    if (actual === "left") {
      this.#finish("left");
      return;
    }
    const error =
      actual === "token_refresh_failed"
        ? new MeetingError("join_token_expired")
        : new MeetingError("connection_lost");
    this.#finish("connection_lost", error);
  }

  #cancelReconnect(reason: ReconnectReasonClass): void {
    const controller = this.#reconnect;
    this.#reconnect = undefined;
    this.#preRecoveryParticipants = undefined;
    if (this.#reconnectOpen) {
      this.#reconnectOutcome = "cancelled";
      const open = this.#reconnectOpen;
      this.#reconnectOpen = undefined;
      open.resolve();
    }
    controller?.cancel(reason);
  }

  #installVisibilityListener(): void {
    const doc = (globalThis as { document?: { visibilityState?: string; addEventListener?: typeof document.addEventListener } })
      .document;
    if (!doc || typeof doc.addEventListener !== "function") return;
    this.#onVisibility = () => {
      if (doc.visibilityState !== "visible" || this.#disposed) return;
      if (this.#state === "reconnecting") {
        // Continue or restart the recovery chain with a visibility trigger.
        if (this.#reconnect && !this.#reconnect.active) this.#reconnect.start("visibility");
        return;
      }
      if (this.#state === "joined" && this.#session === undefined) {
        this.#beginRecovery("visibility");
      }
    };
    doc.addEventListener("visibilitychange", this.#onVisibility);
  }

  #removeVisibilityListener(): void {
    const doc = (globalThis as { document?: { removeEventListener?: typeof document.removeEventListener } }).document;
    const handler = this.#onVisibility;
    this.#onVisibility = undefined;
    if (doc && handler && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("visibilitychange", handler);
    }
  }

  #clearEndMeetingTimer(): void {
    if (this.#endMeetingTimer !== undefined) this.#env.clearTimeout(this.#endMeetingTimer);
    this.#endMeetingTimer = undefined;
  }

  #clearTimer(which: "join" | "leave"): void {
    const handle = which === "join" ? this.#joinTimer : this.#leaveTimer;
    if (handle !== undefined) this.#env.clearTimeout(handle);
    if (which === "join") this.#joinTimer = undefined;
    else this.#leaveTimer = undefined;
  }

  /** Re-reads the state after emitting, since listeners may have changed it. */
  #is(state: ConnectionState): boolean {
    return this.#state === state;
  }

  #setState(next: ConnectionState): void {
    const previous = this.#state;
    if (previous === next) return;
    this.#state = next;
    this.#log.info("state changed", { state: next });
    this.#emit("state_changed", { state: next, previous });
  }

  #emit<K extends MeetingEventType>(type: K, event: MeetingEventMap[K]): void {
    if (!this.#disposed) this.#emitter.emit(type, event);
  }
}
