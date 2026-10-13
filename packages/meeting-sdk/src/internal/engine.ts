import {
  type IceServerConfig,
  type MediaMode,
  ROLE_POLICY,
  type SignalingMessage,
  isRoleAllowed,
} from "@strevokit/signaling-protocol";
import { MeetingError } from "../public/errors.js";
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
import { Roster } from "./roster.js";
import { type OutboundType, SignalingSession } from "./signalingSession.js";
import type { Addressing } from "./token.js";

const LEAVE_FALLBACK_MS = 5000;
const RESTRICTED_PENDING_MS = 2000;

export interface EngineConfig {
  token: string;
  realtimeUrl: string;
  joinTimeoutMs: number;
  logger: MeetingLogger | undefined;
  addressing: Addressing;
  env: EngineEnvironment;
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
  #pendingRestricted: { kind: MediaKind; timer: TimerHandle } | undefined;

  constructor(config: EngineConfig) {
    this.#token = config.token;
    this.#realtimeUrl = config.realtimeUrl;
    this.#joinTimeoutMs = config.joinTimeoutMs;
    this.#addressing = config.addressing;
    this.#env = config.env;
    this.#createDelivery = config.createMediaDelivery;
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
    this.#token = undefined;
    if (!this.#env.WebSocket || token === undefined) return Promise.reject(new MeetingError("unsupported_environment"));

    const join = deferred();
    this.#join = join;
    this.#setState("connecting");
    if (!this.#is("connecting")) return join.promise;

    this.#joinTimer = this.#env.setTimeout(() => this.#failJoin(new MeetingError("join_timeout")), this.#joinTimeoutMs);
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
    this.#emitter.clear();
    this.#teardown();
    this.#state = "closed";
    const join = this.#join;
    this.#join = undefined;
    if (join) {
      join.promise.catch(() => undefined);
      join.reject(new MeetingError("join_cancelled"));
    }
    this.#leave?.resolve();
  }

  #mediaCall(kind: MediaKind, enabled: boolean, deviceId?: string): Promise<void> {
    if (this.#state !== "joined") return Promise.reject(new MeetingError("not_joined"));
    if (kind === "screen") {
      const type = enabled ? "media.screen.started" : "media.screen.stopped";
      if (this.#role === undefined || !isRoleAllowed(type, this.#role)) {
        return Promise.reject(new MeetingError("not_permitted"));
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
        if (state !== "connecting") return;
        this.#role = message.payload.role;
        this.#setState("joining");
        if (!this.#is("joining")) return;
        if (!this.#session?.send("participant.join")) this.#failJoin(new MeetingError("connection_failed"));
        return;
      }
      case "session.welcome": {
        if (state !== "joining") return;
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
        const participant = this.#roster.get(from);
        if (result === "added" && participant) {
          this.#emit("participant_joined", { participant });
          const present = this.#roster.committed && this.#is("joined") ? this.#roster.get(from) : undefined;
          if (present) this.#delivery.peerPresent(from, present.media);
        }
        return;
      }
      case "participant.left": {
        if (isSelf || state === "connecting") return;
        if (this.#roster.remove(from) && this.#roster.committed) {
          this.#delivery.peerLeft(from);
          this.#emit("participant_left", { participantId: from, reason: mapLeftReason(message.payload.reason) });
        }
        return;
      }
      case "participant.reconnected": {
        if (isSelf || !this.#roster.committed) return;
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
        else this.#finish("meeting_ended");
        return;
      }
      case "session.rejected": {
        this.#onRejected(message.payload.code);
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
        this.#finish(reason, error);
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
    this.#teardown();
    this.#setState("closed");
    this.#emit("closed", error ? { reason, error } : { reason });
    this.#leave?.resolve();
  }

  #teardown(): void {
    this.#clearTimer("join");
    this.#clearTimer("leave");
    this.#clearPendingRestricted();
    this.#media.releaseAll();
    this.#delivery.close();
    const session = this.#session;
    this.#session = undefined;
    session?.close();
    this.#roster.clear();
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
