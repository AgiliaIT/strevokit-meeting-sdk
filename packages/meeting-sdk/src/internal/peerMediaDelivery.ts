import type { IceCandidate, IceServerConfig, SignalingMessage } from "@strevokit/signaling-protocol";
import { MeetingError } from "../public/errors.js";
import type { MediaConnectionStatus, MediaKind, MediaState, MeetingEventMap, RemoteMedia } from "../public/types.js";
import type { EngineEnvironment, TimerHandle } from "./env.js";
import type { Log } from "./log.js";
import type { DeliveryEventType, MediaDelivery, MediaDeliveryContext, PresentPeer } from "./mediaDelivery.js";
import { CONNECTION_TIMEOUT_MS, type LinkFailure, type LinkStatus, type LocalKind, PeerLink, roleFor } from "./peerLink.js";
import { RemoteMediaTracker, computeRemoteMedia } from "./remoteMedia.js";

/** How long frames from a participant not yet usable are kept. */
export const EARLY_FRAME_HOLD_MS = 5000;
/** Early candidates kept per participant. */
export const MAX_EARLY_CANDIDATES = 64;

const NOTHING_ANNOUNCED: MediaState = Object.freeze({ camera: false, microphone: false, screen: false });

export interface PeerMediaDeliveryOptions {
  env: EngineEnvironment;
  log: Log;
  /** Not public: tests shorten the time allowed for a first connection. */
  connectionTimeoutMs?: number;
}

type EarlyCandidates = { candidates: IceCandidate[]; timer: TimerHandle };
type HeldOffer = { from: string; sdp: string; timer: TimerHandle };

/**
 * Carries camera and microphone directly to and from exactly one other participant. Every participant applies the
 * same rule: pair only while exactly one other participant is present, keep a pair once it has connected, and
 * report the participants it does not carry with a non-fatal error.
 */
export class PeerMediaDelivery implements MediaDelivery {
  readonly #env: EngineEnvironment;
  readonly #log: Log;
  readonly #timeoutMs: number;
  #context: MediaDeliveryContext | undefined;
  /** The latest server list; links created later use it. */
  #iceServers: readonly IceServerConfig[] = [];
  /** Whether the platform relays restart requests and results (it announces credential expiry). */
  #serverSupportsRestart = false;
  #inert = false;
  #closed = false;
  readonly #present = new Map<string, MediaState>();
  #activeId: string | null = null;
  #link: PeerLink | null = null;
  readonly #status = new Map<string, MediaConnectionStatus>();
  readonly #remote = new RemoteMediaTracker();
  readonly #limitReported = new Set<string>();
  readonly #early = new Map<string, EarlyCandidates>();
  #heldOffer: HeldOffer | undefined;
  readonly #local: Record<LocalKind, MediaStreamTrack | null> = { camera: null, microphone: null };

  constructor(options: PeerMediaDeliveryOptions) {
    this.#env = options.env;
    this.#log = options.log;
    this.#timeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
  }

  attach(context: MediaDeliveryContext): void {
    if (this.#closed || this.#context) return;
    this.#context = context;
    this.#iceServers = context.iceServers;
    this.#serverSupportsRestart = context.iceServersExpireAt !== null;
    if (!this.#env.RTCPeerConnection || !this.#env.MediaStream) {
      this.#inert = true;
      this.#log.warn("media connections unsupported");
      this.#emit("error", { error: new MeetingError("unsupported_environment") });
    }
  }

  peersPresent(entries: readonly PresentPeer[]): void {
    if (!this.#active()) return;
    for (const { id, media } of entries) {
      this.#present.set(id, { ...media });
      this.#limitReported.delete(id);
    }
    this.#evaluate();
    const held = this.#heldOffer;
    if (held && entries.some((entry) => entry.id === held.from)) {
      this.#dropHeldOffer();
      if (held.from === this.#activeId) this.#handleOffer(held.from, held.sdp);
    }
  }

  peerPresent(participantId: string, media: MediaState): void {
    this.peersPresent([{ id: participantId, media }]);
  }

  peerMediaChanged(participantId: string, kind: MediaKind, enabled: boolean): void {
    const announced = this.#present.get(participantId);
    if (!this.#active() || !announced) return;
    this.#present.set(participantId, { ...announced, [kind]: enabled });
    this.#refreshRemote(participantId);
  }

  peerLeft(participantId: string): void {
    if (!this.#active()) return;
    this.#present.delete(participantId);
    this.#limitReported.delete(participantId);
    this.#dropEarly(participantId);
    if (this.#heldOffer?.from === participantId) this.#dropHeldOffer();
    if (participantId === this.#activeId) {
      this.#closeLink();
      this.#activeId = null;
    }
    this.#setStatus(participantId, null);
    this.#evaluate();
  }

  peerReconnected(participantId: string): void {
    if (!this.#active() || participantId !== this.#activeId) return;
    this.#dropEarly(participantId);
    this.#closeLink();
    this.#setStatus(participantId, null);
    this.#startPairing();
  }

  onPeerFrame(message: SignalingMessage): void {
    if (!this.#active()) return;
    const from = message.participantId;
    if (!this.#present.has(from)) {
      this.#holdEarly(message);
      return;
    }
    if (from !== this.#activeId) {
      this.#log.debug("frame ignored", { messageType: message.type, reason: "not_paired" });
      return;
    }
    switch (message.type) {
      case "webrtc.offer":
        this.#handleOffer(from, message.payload.sdp);
        return;
      case "webrtc.answer":
        if (this.#link) this.#link.acceptAnswer(message.payload.sdp);
        else this.#log.debug("frame ignored", { messageType: message.type, reason: "no_connection" });
        return;
      case "webrtc.ice_candidate":
        if (this.#link) this.#link.addRemoteCandidate(message.payload.candidate);
        else this.#addEarlyCandidate(from, message.payload.candidate);
        return;
      case "webrtc.ice_restart":
        if (this.#link?.role === "offerer") this.#link.restart("peer_request");
        else this.#log.debug("frame ignored", { messageType: message.type, reason: this.#link ? "answerer" : "no_connection" });
        return;
      default:
        return;
    }
  }

  iceServersUpdated(iceServers: readonly IceServerConfig[], expiresAt: number): void {
    if (!this.#active()) return;
    this.#iceServers = iceServers;
    const link = this.#link;
    if (!link) return;
    link.updateIceServers(iceServers);
    link.planSwitch(expiresAt);
  }

  localMediaChanged(kind: MediaKind, stream: MediaStream | null): void {
    if (kind === "screen" || this.#closed) return;
    const track = (kind === "camera" ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0]) ?? null;
    // A muted microphone keeps its disabled track on the connection, so it sends silence.
    if (kind === "microphone" && track === null) return;
    this.#local[kind] = track;
    this.#link?.attachLocal(kind, track);
  }

  remoteMedia(participantId: string): RemoteMedia {
    return this.#remote.get(participantId);
  }

  connectionStatus(participantId: string): MediaConnectionStatus | null {
    return this.#status.get(participantId) ?? null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const link = this.#link;
    this.#link = null;
    link?.close();
    for (const participantId of [...this.#early.keys()]) this.#dropEarly(participantId);
    this.#dropHeldOffer();
    this.#present.clear();
    this.#status.clear();
    this.#remote.clear();
    this.#activeId = null;
  }

  #active(): boolean {
    return this.#context !== undefined && !this.#inert && !this.#closed;
  }

  /** The single-peer rule, applied after every presence change. */
  #evaluate(): void {
    const others = this.#present.size;
    if (this.#activeId !== null && others >= 2 && !this.#keepsPair()) {
      const abandoned = this.#activeId;
      this.#closeLink();
      this.#activeId = null;
      this.#setStatus(abandoned, null);
      this.#log.debug("media connection abandoned", { participantId: abandoned });
    }
    if (this.#activeId === null && others === 1) {
      const [only] = this.#present.keys();
      if (only !== undefined) {
        this.#activeId = only;
        this.#startPairing();
      }
    }
    if (others >= 2) {
      for (const participantId of this.#present.keys()) {
        if (participantId === this.#activeId && this.#keepsPair()) continue;
        if (this.#limitReported.has(participantId)) continue;
        this.#limitReported.add(participantId);
        this.#log.info("media not carried", { participantId, code: "media_participant_limit" });
        this.#emit("error", { error: new MeetingError("media_participant_limit") });
      }
    }
  }

  /** A pair is kept once its link has connected, until the peer leaves, reconnects, or the link fails. */
  #keepsPair(): boolean {
    return this.#link !== null && this.#link.everConnected && this.#link.status !== "failed";
  }

  #startPairing(): void {
    const peerId = this.#activeId;
    const self = this.#context?.participantId;
    if (peerId === null || self === undefined) return;
    if (roleFor(self, peerId) !== "offerer") return;
    this.#createLink(peerId)?.start();
  }

  #handleOffer(from: string, sdp: string): void {
    const self = this.#context?.participantId;
    if (self === undefined) return;
    if (roleFor(self, from) === "offerer") {
      this.#log.debug("frame ignored", { messageType: "webrtc.offer", reason: "offerer" });
      return;
    }
    const link = this.#link ?? this.#createLink(from);
    link?.acceptOffer(sdp);
  }

  #createLink(peerId: string): PeerLink | null {
    const context = this.#context;
    if (!context) return null;
    let link: PeerLink;
    try {
      link = new PeerLink({
        env: this.#env,
        log: this.#log,
        selfId: context.participantId,
        peerId,
        iceServers: this.#iceServers,
        timeoutMs: this.#timeoutMs,
        local: this.#local,
        callbacks: {
          sendOffer: (payload) => {
            if (this.#link === link) context.send("webrtc.offer", payload);
          },
          sendAnswer: (payload) => {
            if (this.#link === link) context.send("webrtc.answer", payload);
          },
          sendCandidate: (payload) => {
            if (this.#link === link) context.send("webrtc.ice_candidate", payload);
          },
          statusChanged: (status, reason) => {
            if (this.#link === link) this.#onLinkStatus(link, status, reason);
          },
          connected: (report) => {
            if (this.#link === link) context.send("webrtc.connected", { peerParticipantId: peerId, ...report });
          },
          requestRestart: () =>
            this.#link === link &&
            this.#serverSupportsRestart &&
            context.send("webrtc.ice_restart", { targetParticipantId: peerId }),
          switchResult: (outcome) => {
            if (this.#link === link && this.#serverSupportsRestart) {
              context.send("webrtc.ice_restart_result", { peerParticipantId: peerId, outcome });
            }
          },
        },
      });
    } catch {
      this.#log.debug("negotiation step failed", { participantId: peerId, reason: "create" });
      this.#reportFailure(peerId, "negotiation_failed");
      return null;
    }
    this.#link = link;
    this.#setStatus(peerId, "connecting");
    const early = this.#early.get(peerId);
    if (early) {
      this.#dropEarly(peerId);
      for (const candidate of early.candidates) link.addRemoteCandidate(candidate);
    }
    return link;
  }

  #onLinkStatus(link: PeerLink, status: LinkStatus, reason: LinkFailure | undefined): void {
    const peerParticipantId = link.peerId;
    switch (status) {
      case "connected":
        this.#setStatus(peerParticipantId, "connected");
        this.#refreshRemote(peerParticipantId);
        return;
      case "interrupted":
        this.#context?.send("webrtc.disconnected", { peerParticipantId });
        this.#setStatus(peerParticipantId, "interrupted");
        return;
      case "failed":
        this.#link = null;
        link.close();
        this.#reportFailure(peerParticipantId, reason ?? "connection_failed");
        return;
      default:
        return;
    }
  }

  /** Reports a failed link. The pair stays as it is; nothing is retried until the peer reconnects or rejoins. */
  #reportFailure(peerParticipantId: string, reason: LinkFailure): void {
    this.#log.warn("media connection failed", { participantId: peerParticipantId, reason });
    this.#context?.send("webrtc.failed", { peerParticipantId, reason });
    this.#setStatus(peerParticipantId, "failed");
    this.#refreshRemote(peerParticipantId);
    this.#emit("error", { error: new MeetingError("media_connection_failed") });
  }

  /** Closes the current link without reporting a failure, and reports its remote media as gone. */
  #closeLink(): void {
    const link = this.#link;
    if (!link) return;
    this.#link = null;
    link.close();
    this.#refreshRemote(link.peerId);
  }

  #refreshRemote(participantId: string): void {
    const link = this.#link;
    const active = participantId === this.#activeId && link !== null && link.peerId === participantId;
    const next = computeRemoteMedia({
      active,
      usable: active && link.usable,
      announced: this.#present.get(participantId) ?? NOTHING_ANNOUNCED,
      streams: { camera: link?.remoteStream("camera") ?? null, microphone: link?.remoteStream("microphone") ?? null },
    });
    this.#remote.update(participantId, next, (event) => this.#emit("remote_media_changed", event));
  }

  #setStatus(participantId: string, status: MediaConnectionStatus | null): void {
    const previous = this.#status.get(participantId) ?? null;
    if (previous === status) return;
    if (status === null) this.#status.delete(participantId);
    else this.#status.set(participantId, status);
    this.#emit("media_connection_changed", { participantId, status });
  }

  #holdEarly(message: SignalingMessage): void {
    switch (message.type) {
      case "webrtc.offer": {
        this.#dropHeldOffer();
        const from = message.participantId;
        this.#heldOffer = {
          from,
          sdp: message.payload.sdp,
          timer: this.#env.setTimeout(() => {
            if (this.#heldOffer?.from === from) this.#heldOffer = undefined;
          }, EARLY_FRAME_HOLD_MS),
        };
        return;
      }
      case "webrtc.ice_candidate":
        this.#addEarlyCandidate(message.participantId, message.payload.candidate);
        return;
      default:
        this.#log.debug("frame ignored", { messageType: message.type, reason: "unknown_participant" });
    }
  }

  #addEarlyCandidate(participantId: string, candidate: IceCandidate): void {
    let early = this.#early.get(participantId);
    if (!early) {
      early = {
        candidates: [],
        timer: this.#env.setTimeout(() => this.#early.delete(participantId), EARLY_FRAME_HOLD_MS),
      };
      this.#early.set(participantId, early);
    }
    if (early.candidates.length >= MAX_EARLY_CANDIDATES) {
      this.#log.debug("late candidate dropped", { participantId, reason: "queue_full" });
      return;
    }
    early.candidates.push(candidate);
  }

  #dropEarly(participantId: string): void {
    const early = this.#early.get(participantId);
    if (!early) return;
    this.#env.clearTimeout(early.timer);
    this.#early.delete(participantId);
  }

  #dropHeldOffer(): void {
    if (this.#heldOffer) this.#env.clearTimeout(this.#heldOffer.timer);
    this.#heldOffer = undefined;
  }

  #emit<K extends DeliveryEventType>(type: K, event: MeetingEventMap[K]): void {
    if (!this.#closed) this.#context?.emit(type, event);
  }
}
