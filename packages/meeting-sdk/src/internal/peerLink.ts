import type { IceCandidate, IceServerConfig, PayloadMap } from "@strevokit/signaling-protocol";
import type { EngineEnvironment, IceCandidateLike, PeerConnectionLike, TimerHandle, TransceiverLike } from "./env.js";
import type { Log } from "./log.js";
import { localCandidateIds, type PathReport, pathReport, samePath, selectedPair } from "./selectedPair.js";

/** Remote candidates kept until the remote description is set. */
export const MAX_QUEUED_CANDIDATES = 64;
/** Time allowed from link creation to the first `connected`. */
export const CONNECTION_TIMEOUT_MS = 30_000;
/** Time allowed for one switch attempt to select a fresh local candidate. */
export const SWITCH_ATTEMPT_TIMEOUT_MS = 15_000;
/** Delays before retrying a failed switch attempt; the last one repeats. */
export const SWITCH_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000];
/** No switch attempt starts closer than this to the expiry of the credentials in use. */
export const SWITCH_DEADLINE_MARGIN_MS = 5_000;
/** How often a switch attempt checks the selected candidate pair. */
export const SWITCH_POLL_MS = 1_000;
/** How long a drop during a switch is held back before it is reported as an interruption. */
export const SWITCH_INTERRUPTION_HOLD_MS = 5_000;
/** How long an interruption must last before an offerer restarts the connection; shorter drops often heal alone. */
export const INTERRUPTION_RESTART_HOLD_MS = 3_000;
/** Times after each path report at which the path is read again; after the last, every `PATH_RECHECK_INTERVAL_MS`. */
export const PATH_RECHECK_DELAYS_MS: readonly number[] = [2_000, 10_000];
export const PATH_RECHECK_INTERVAL_MS = 30_000;

export type LinkRole = "offerer" | "answerer";
export type LinkStatus = "connecting" | "connected" | "interrupted" | "failed";
export type LinkFailure = "connection_failed" | "connection_timeout" | "negotiation_failed";
export type LocalKind = "camera" | "microphone" | "screen";
export type SwitchOutcome = "completed" | "failed";
export type RestartReason = "refresh" | "peer_request" | "interruption" | "network";
/** What started an attempt to restore media that dropped while the meeting connection stayed up. */
export type RecoveryTrigger = "media" | "network";
export interface PeerLinkCallbacks {
  sendOffer(payload: PayloadMap["webrtc.offer"]): void;
  sendAnswer(payload: PayloadMap["webrtc.answer"]): void;
  sendCandidate(payload: PayloadMap["webrtc.ice_candidate"]): void;
  /** Called on every status transition after `connecting`. `reason` is set for `failed`. */
  statusChanged(status: LinkStatus, reason?: LinkFailure): void;
  /**
   * How media is carried on each side, after each move to `connected` and after each completed switch. Null when the
   * browser reports no stats.
   */
  connected(report: PathReport | null): void;
  /** Answerer: asks the other side to restart. False when it cannot be asked, which ends the switch. */
  requestRestart(): boolean;
  /** The outcome of one switch attempt. */
  switchResult(outcome: SwitchOutcome): void;
  /** An offerer started a restart because the connection was interrupted. */
  recoveryStarted(trigger: RecoveryTrigger): void;
}

/** A planned move to fresh candidates before the credentials in use expire. */
type SwitchState = {
  deadline: number;
  attempt: number;
  /** Local candidate IDs known before the current attempt; the attempt completes on a pair outside this set. */
  known: ReadonlySet<string>;
  attemptTimer: TimerHandle | undefined;
  pollTimer: TimerHandle | undefined;
  retryTimer: TimerHandle | undefined;
};

function copyServers(iceServers: readonly IceServerConfig[]): { urls: string[]; username?: string; credential?: string }[] {
  return iceServers.map((server) => {
    const copy: { urls: string[]; username?: string; credential?: string } = { urls: [...server.urls] };
    if (server.username !== undefined) copy.username = server.username;
    if (server.credential !== undefined) copy.credential = server.credential;
    return copy;
  });
}

export interface PeerLinkOptions {
  env: EngineEnvironment;
  log: Log;
  selfId: string;
  peerId: string;
  iceServers: readonly IceServerConfig[];
  timeoutMs: number;
  local: Readonly<Record<LocalKind, MediaStreamTrack | null>>;
  callbacks: PeerLinkCallbacks;
}

export function roleFor(selfId: string, peerId: string): LinkRole {
  return selfId < peerId ? "offerer" : "answerer";
}

/** Maps `connectionState`, or `iceConnectionState` where the former is unavailable, to a coarse state. */
function coarseState(pc: PeerConnectionLike): "connecting" | "connected" | "disconnected" | "failed" | "closed" {
  const state = typeof pc.connectionState === "string" ? pc.connectionState : pc.iceConnectionState;
  switch (state) {
    case "connected":
    case "completed":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "connecting";
  }
}

/** One media connection to one other participant, with fixed audio, camera, and screen transceivers. */
export class PeerLink {
  readonly peerId: string;
  readonly role: LinkRole;
  #status: LinkStatus = "connecting";
  #everConnected = false;
  #closed = false;
  readonly #pc: PeerConnectionLike;
  readonly #env: EngineEnvironment;
  readonly #log: Log;
  readonly #callbacks: PeerLinkCallbacks;
  readonly #local: Record<LocalKind, MediaStreamTrack | null>;
  readonly #queued: IceCandidateLike[] = [];
  #remoteDescriptionSet = false;
  #offerHandled = false;
  #audio: TransceiverLike | undefined;
  #video: TransceiverLike | undefined;
  #screen: TransceiverLike | undefined;
  #streams: Record<LocalKind, MediaStream | null> = { camera: null, microphone: null, screen: null };
  #timer: TimerHandle | undefined;
  #chain: Promise<void> = Promise.resolve();
  #switch: SwitchState | null = null;
  #restarting = false;
  #interruptionHold: TimerHandle | undefined;
  #restartHold: TimerHandle | undefined;
  /** Local candidates gathered while an offer is being created; sent after it so the other side sees it first. */
  #heldLocal: IceCandidate[] | null = null;
  #remoteOrigin: string | undefined;
  #lastReport: PathReport | null = null;
  #recheckTimer: TimerHandle | undefined;

  /** Throws when the connection cannot be created; the owner treats that as a negotiation failure. */
  constructor(options: PeerLinkOptions) {
    this.peerId = options.peerId;
    this.role = roleFor(options.selfId, options.peerId);
    this.#env = options.env;
    this.#log = options.log;
    this.#callbacks = options.callbacks;
    const { local } = options;
    this.#local = { ...local };
    const PeerConnection = options.env.RTCPeerConnection;
    if (!PeerConnection) throw new Error("peer connections unavailable");
    this.#pc = new PeerConnection({ iceServers: copyServers(options.iceServers) });
    this.#pc.onicecandidate = (event) => this.#onLocalCandidate(event.candidate);
    this.#pc.onconnectionstatechange = () => this.#onStateChange();
    this.#pc.oniceconnectionstatechange = () => {
      if (typeof this.#pc.connectionState !== "string") this.#onStateChange();
    };
    this.#timer = this.#env.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#everConnected) this.#fail("connection_timeout");
    }, options.timeoutMs);
    this.#log.debug("media connection created", { participantId: this.peerId });
  }

  get status(): LinkStatus {
    return this.#status;
  }

  get everConnected(): boolean {
    return this.#everConnected;
  }

  /** Usable for rendering: connected at least once, and neither failed nor closed. */
  get usable(): boolean {
    return this.#everConnected && !this.#closed && this.#status !== "failed";
  }

  /** The stable stream holding the received track of `kind`, once the transceivers exist. */
  remoteStream(kind: LocalKind): MediaStream | null {
    return this.#streams[kind];
  }

  /** Offerer: adds the transceivers (audio → camera → screen) and sends the offer. */
  start(): void {
    if (this.role !== "offerer" || this.#audio) return;
    this.#run(async () => {
      this.#audio = this.#pc.addTransceiver("audio", { direction: "sendrecv" });
      this.#video = this.#pc.addTransceiver("video", { direction: "sendrecv" });
      this.#screen = this.#pc.addTransceiver("video", { direction: "sendrecv" });
      this.#bindStreams();
      await this.#attachAll();
      const offer = await this.#pc.createOffer();
      this.#heldLocal = [];
      await this.#pc.setLocalDescription(offer);
      if (this.#closed) return;
      this.#sendOffer(this.#pc.localDescription?.sdp ?? offer.sdp ?? "");
    });
  }

  /**
   * Answerer: applies the offer and sends the answer. A later offer (a restart) is answered when no other
   * negotiation is in progress, keeping the transceivers and received streams; otherwise it is ignored.
   */
  acceptOffer(sdp: string): void {
    if (this.role !== "answerer") {
      this.#log.debug("frame ignored", { messageType: "webrtc.offer", reason: "offerer" });
      return;
    }
    if (this.#offerHandled) {
      this.#acceptReoffer(sdp);
      return;
    }
    this.#offerHandled = true;
    this.#remoteOrigin = sessionOrigin(sdp);
    this.#run(async () => {
      await this.#pc.setRemoteDescription({ type: "offer", sdp });
      this.#remoteDescriptionSet = true;
      // Bind by index: two video m-lines cannot be told apart by track.kind alone.
      const transceivers = this.#pc.getTransceivers();
      this.#audio = transceivers[0];
      this.#video = transceivers[1];
      this.#screen = transceivers[2];
      for (const transceiver of [this.#audio, this.#video, this.#screen]) {
        if (transceiver) transceiver.direction = "sendrecv";
      }
      this.#bindStreams();
      await this.#attachAll();
      const answer = await this.#pc.createAnswer();
      await this.#pc.setLocalDescription(answer);
      if (this.#closed) return;
      const answerSdp = this.#pc.localDescription?.sdp ?? answer.sdp ?? "";
      this.#callbacks.sendAnswer({ targetParticipantId: this.peerId, sdp: answerSdp });
      await this.#flushCandidates();
    });
  }

  /**
   * Answerer: whether `sdp` comes from a different connection than the one this link answered first, as when the
   * other side replaced its connection. Such an offer needs a fresh link; a restart keeps the same origin.
   */
  startsNewSession(sdp: string): boolean {
    const origin = sessionOrigin(sdp);
    return this.#offerHandled && this.#remoteOrigin !== undefined && origin !== undefined && origin !== this.#remoteOrigin;
  }

  /** Offerer: applies the answer while an offer is outstanding; otherwise ignored. */
  acceptAnswer(sdp: string): void {
    if (this.role !== "offerer") {
      this.#log.debug("frame ignored", { messageType: "webrtc.answer", reason: "answerer" });
      return;
    }
    this.#run(async () => {
      if (this.#pc.signalingState !== "have-local-offer") {
        this.#log.debug("frame ignored", { messageType: "webrtc.answer", state: this.#pc.signalingState });
        return;
      }
      if (!this.#restarting) {
        await this.#pc.setRemoteDescription({ type: "answer", sdp });
        this.#remoteDescriptionSet = true;
        await this.#flushCandidates();
        return;
      }
      this.#restarting = false;
      try {
        await this.#pc.setRemoteDescription({ type: "answer", sdp });
      } catch {
        this.#restartFailed();
        this.#rescheduleInterruptionRestartIfNeeded();
        return;
      }
      await this.#flushCandidates();
      this.#rescheduleInterruptionRestartIfNeeded();
    });
  }

  /** Replaces the server list for future candidate gathering. The current connection is untouched. */
  updateIceServers(iceServers: readonly IceServerConfig[]): void {
    if (this.#closed) return;
    try {
      this.#pc.setConfiguration({ ...this.#pc.getConfiguration(), iceServers: copyServers(iceServers) });
    } catch {
      this.#log.debug("negotiation step failed", { participantId: this.peerId, reason: "configuration" });
    }
  }

  /**
   * Moves to fresh candidates before `deadlineMs` when this side sends through a relay, whose allocation is tied to
   * the credentials about to expire. Direct paths and links that are not connected are left alone.
   */
  planSwitch(deadlineMs: number): void {
    if (this.#closed || this.#status !== "connected") return;
    const active = this.#switch;
    if (active) {
      active.deadline = deadlineMs;
      return;
    }
    void selectedPair(this.#pc).then((pair) => {
      if (this.#closed || this.#switch || this.#status !== "connected" || pair?.localType !== "relay") return;
      const started: SwitchState = {
        deadline: deadlineMs,
        attempt: 0,
        known: new Set(),
        attemptTimer: undefined,
        pollTimer: undefined,
        retryTimer: undefined,
      };
      this.#switch = started;
      this.#log.debug("media path switch started", { participantId: this.peerId });
      void this.#beginAttempt(started);
    });
  }

  /**
   * Offerer: renegotiates with fresh candidates. Joins a restart whose answer is still outstanding instead of starting
   * another; a restart that already finished may predate the other side's fresh servers, so it does not count.
   */
  restart(reason: RestartReason): boolean {
    if (this.role !== "offerer" || this.#closed || this.#restarting) return false;
    this.#restarting = true;
    this.#log.debug("media connection restart", { participantId: this.peerId, reason });
    this.#chain = this.#chain.then(async () => {
      if (this.#closed) return;
      try {
        const offer = await this.#pc.createOffer({ iceRestart: true });
        this.#heldLocal = [];
        await this.#pc.setLocalDescription(offer);
        if (this.#closed) return;
        this.#sendOffer(this.#pc.localDescription?.sdp ?? offer.sdp ?? "");
      } catch {
        this.#heldLocal = null;
        this.#restarting = false;
        this.#restartFailed();
        this.#rescheduleInterruptionRestartIfNeeded();
      }
    });
    return true;
  }

  /** The browser regained connectivity or changed networks: an offerer restarts an interrupted connection now. */
  networkChanged(): void {
    if (this.#closed || this.#status !== "interrupted" || this.role !== "offerer") return;
    this.#clearRestartHold();
    if (this.restart("network")) this.#callbacks.recoveryStarted("network");
    else this.#scheduleInterruptionRestart();
  }

  addRemoteCandidate(candidate: IceCandidate): void {
    if (this.#closed) return;
    const copy: IceCandidateLike = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      ...(candidate.usernameFragment !== undefined ? { usernameFragment: candidate.usernameFragment } : {}),
    };
    if (!this.#remoteDescriptionSet) {
      if (this.#queued.length >= MAX_QUEUED_CANDIDATES) {
        this.#log.debug("late candidate dropped", { participantId: this.peerId, reason: "queue_full" });
        return;
      }
      this.#queued.push(copy);
      return;
    }
    void this.#applyCandidate(copy);
  }

  /** Sends `track` for `kind` (or nothing for `null`). Skipped when that track is already being sent. */
  attachLocal(kind: LocalKind, track: MediaStreamTrack | null): void {
    this.#local[kind] = track;
    if (this.#closed) return;
    const sender =
      (kind === "camera" ? this.#video : kind === "screen" ? this.#screen : this.#audio)?.sender;
    if (!sender || sender.track === track) return;
    sender.replaceTrack(track).catch(() => {
      this.#log.debug("negotiation step failed", { participantId: this.peerId, kind, reason: "replace_track" });
    });
  }

  /** Closes the connection and stops received tracks. Reports nothing. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    this.#endSwitch();
    this.#clearInterruptionHold();
    this.#clearRestartHold();
    this.#clearRecheck();
    this.#pc.onicecandidate = null;
    this.#pc.onconnectionstatechange = null;
    this.#pc.oniceconnectionstatechange = null;
    for (const stream of Object.values(this.#streams)) {
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          // Already stopped.
        }
      }
    }
    try {
      this.#pc.close();
    } catch {
      // Already closed.
    }
  }

  #run(step: () => Promise<void>): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#closed) return;
      try {
        await step();
      } catch {
        if (this.#closed) return;
        this.#log.debug("negotiation step failed", { participantId: this.peerId });
        this.#fail("negotiation_failed");
      }
    });
  }

  #acceptReoffer(sdp: string): void {
    this.#run(async () => {
      if (this.#pc.signalingState !== "stable") {
        this.#log.debug("frame ignored", { messageType: "webrtc.offer", reason: "busy" });
        return;
      }
      try {
        await this.#pc.setRemoteDescription({ type: "offer", sdp });
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        if (this.#closed) return;
        const answerSdp = this.#pc.localDescription?.sdp ?? answer.sdp ?? "";
        this.#callbacks.sendAnswer({ targetParticipantId: this.peerId, sdp: answerSdp });
      } catch {
        this.#restartFailed();
        return;
      }
      await this.#flushCandidates();
    });
  }

  /** A restart negotiation step failed: the connection stays as it is and the current attempt, if any, fails. */
  #restartFailed(): void {
    if (this.#closed) return;
    this.#log.debug("negotiation step failed", { participantId: this.peerId, reason: "restart" });
    const current = this.#switch;
    if (current?.attemptTimer !== undefined) this.#attemptFailed(current);
  }

  async #beginAttempt(current: SwitchState): Promise<void> {
    current.attempt += 1;
    const known = await localCandidateIds(this.#pc);
    if (this.#switch !== current || this.#closed) return;
    current.known = known ?? new Set();
    current.attemptTimer = this.#env.setTimeout(() => this.#attemptFailed(current), SWITCH_ATTEMPT_TIMEOUT_MS);
    if (this.role === "offerer") {
      this.restart("refresh");
    } else if (!this.#callbacks.requestRestart()) {
      this.#endSwitch();
      return;
    }
    this.#schedulePoll(current);
  }

  #schedulePoll(current: SwitchState): void {
    current.pollTimer = this.#env.setTimeout(() => {
      current.pollTimer = undefined;
      void this.#checkSwitch(current);
    }, SWITCH_POLL_MS);
  }

  async #checkSwitch(current: SwitchState): Promise<void> {
    if (this.#switch !== current || current.attemptTimer === undefined) return;
    const pair = coarseState(this.#pc) === "connected" ? await selectedPair(this.#pc) : null;
    if (this.#switch !== current || current.attemptTimer === undefined) return;
    if (!pair || current.known.has(pair.localId)) {
      this.#schedulePoll(current);
      return;
    }
    this.#endSwitch();
    const report = pathReport(pair);
    this.#log.debug("media path switch completed", { participantId: this.peerId, attempt: current.attempt, ...report });
    this.#sendPath(report);
    this.#callbacks.switchResult("completed");
  }

  #attemptFailed(current: SwitchState): void {
    if (this.#switch !== current || this.#closed) return;
    this.#clearSwitchTimers(current);
    this.#restarting = false;
    this.#rescheduleInterruptionRestartIfNeeded();
    this.#log.debug("media path switch attempt failed", { participantId: this.peerId, attempt: current.attempt });
    this.#callbacks.switchResult("failed");
    if (this.#switch !== current || this.#closed) return;
    const delay = SWITCH_RETRY_DELAYS_MS[Math.min(current.attempt, SWITCH_RETRY_DELAYS_MS.length) - 1] ?? 0;
    if (this.#env.now() + delay >= current.deadline - SWITCH_DEADLINE_MARGIN_MS) {
      this.#endSwitch();
      this.#log.debug("media path switch stopped", { participantId: this.peerId, attempt: current.attempt });
      return;
    }
    current.retryTimer = this.#env.setTimeout(() => {
      current.retryTimer = undefined;
      if (this.#switch === current && !this.#closed) void this.#beginAttempt(current);
    }, delay);
  }

  #endSwitch(): void {
    const current = this.#switch;
    if (!current) return;
    this.#switch = null;
    this.#clearSwitchTimers(current);
  }

  #clearSwitchTimers(current: SwitchState): void {
    for (const timer of [current.attemptTimer, current.pollTimer, current.retryTimer]) {
      if (timer !== undefined) this.#env.clearTimeout(timer);
    }
    current.attemptTimer = undefined;
    current.pollTimer = undefined;
    current.retryTimer = undefined;
  }

  #clearInterruptionHold(): void {
    if (this.#interruptionHold !== undefined) this.#env.clearTimeout(this.#interruptionHold);
    this.#interruptionHold = undefined;
  }

  #clearRestartHold(): void {
    if (this.#restartHold !== undefined) this.#env.clearTimeout(this.#restartHold);
    this.#restartHold = undefined;
  }

  /** When a concurrent restart ends and the link is still interrupted, arm another recovery. */
  #rescheduleInterruptionRestartIfNeeded(): void {
    if (this.#closed || this.#status !== "interrupted") return;
    this.#scheduleInterruptionRestart();
  }

  /** Offerer: restarts the connection when an interruption outlasts the hold, without waiting for it to fail. */
  #scheduleInterruptionRestart(): void {
    if (this.role !== "offerer" || this.#restartHold !== undefined) return;
    this.#restartHold = this.#env.setTimeout(() => {
      this.#restartHold = undefined;
      if (this.#closed || this.#status !== "interrupted" || coarseState(this.#pc) === "connected") return;
      if (this.restart("interruption")) this.#callbacks.recoveryStarted("media");
      else this.#scheduleInterruptionRestart();
    }, INTERRUPTION_RESTART_HOLD_MS);
  }

  #bindStreams(): void {
    const Stream = this.#env.MediaStream;
    if (!Stream) return;
    if (this.#audio && !this.#streams.microphone) this.#streams.microphone = new Stream([this.#audio.receiver.track]);
    if (this.#video && !this.#streams.camera) this.#streams.camera = new Stream([this.#video.receiver.track]);
    if (this.#screen && !this.#streams.screen) this.#streams.screen = new Stream([this.#screen.receiver.track]);
  }

  async #attachAll(): Promise<void> {
    const pairs: [TransceiverLike | undefined, MediaStreamTrack | null][] = [
      [this.#audio, this.#local.microphone],
      [this.#video, this.#local.camera],
      [this.#screen, this.#local.screen],
    ];
    for (const [transceiver, track] of pairs) {
      if (transceiver && track && transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
    }
  }

  async #flushCandidates(): Promise<void> {
    for (const candidate of this.#queued.splice(0)) await this.#applyCandidate(candidate);
  }

  async #applyCandidate(candidate: IceCandidateLike): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch {
      this.#log.debug("late candidate dropped", { participantId: this.peerId, reason: "rejected" });
    }
  }

  /** Sends the offer, then the candidates gathered while it was being created. */
  #sendOffer(sdp: string): void {
    this.#callbacks.sendOffer({ targetParticipantId: this.peerId, sdp });
    const held = this.#heldLocal;
    this.#heldLocal = null;
    for (const candidate of held ?? []) this.#callbacks.sendCandidate({ targetParticipantId: this.peerId, candidate });
  }

  #onLocalCandidate(candidate: IceCandidateLike | null): void {
    if (this.#closed || !candidate || candidate.candidate === "") return;
    const payload: IceCandidate = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    };
    if (typeof candidate.usernameFragment === "string") payload.usernameFragment = candidate.usernameFragment;
    if (this.#heldLocal) this.#heldLocal.push(payload);
    else this.#callbacks.sendCandidate({ targetParticipantId: this.peerId, candidate: payload });
  }

  #onStateChange(): void {
    if (this.#closed || this.#status === "failed") return;
    const state = coarseState(this.#pc);
    this.#log.debug("media connection state", { participantId: this.peerId, state });
    switch (state) {
      case "connected":
        this.#everConnected = true;
        this.#clearTimer();
        this.#clearInterruptionHold();
        if (this.#setStatus("connected")) void this.#reportPath();
        return;
      case "disconnected":
        if (!this.#everConnected) return;
        if (this.#switch && this.#status === "connected") {
          // Moving to fresh candidates can drop the connection briefly; report it only if it lasts.
          this.#interruptionHold ??= this.#env.setTimeout(() => {
            this.#interruptionHold = undefined;
            if (!this.#closed && coarseState(this.#pc) !== "connected") this.#setStatus("interrupted");
          }, SWITCH_INTERRUPTION_HOLD_MS);
          return;
        }
        this.#setStatus("interrupted");
        return;
      case "failed":
        this.#fail("connection_failed");
        return;
      default:
        return;
    }
  }

  /** True when the status changed. */
  #setStatus(status: LinkStatus, reason?: LinkFailure): boolean {
    if (this.#status === status) return false;
    this.#status = status;
    if (status === "interrupted") this.#scheduleInterruptionRestart();
    else this.#clearRestartHold();
    this.#callbacks.statusChanged(status, reason);
    return true;
  }

  async #reportPath(): Promise<void> {
    const pair = await selectedPair(this.#pc);
    if (this.#closed || this.#status !== "connected") return;
    this.#sendPath(pair ? pathReport(pair) : null);
  }

  /** Reports the path and reads it again on the recheck schedule, starting over from the first delay. */
  #sendPath(report: PathReport | null): void {
    this.#lastReport = report;
    this.#callbacks.connected(report);
    this.#scheduleRecheck(0);
  }

  #scheduleRecheck(step: number): void {
    this.#clearRecheck();
    const at = PATH_RECHECK_DELAYS_MS[step];
    const delay = at === undefined ? PATH_RECHECK_INTERVAL_MS : at - (PATH_RECHECK_DELAYS_MS[step - 1] ?? 0);
    this.#recheckTimer = this.#env.setTimeout(() => {
      this.#recheckTimer = undefined;
      void this.#recheckPath(step);
    }, delay);
  }

  /**
   * The browser can settle on the path after the first report, for example when the other side's relay address was
   * first seen as peer-reflexive. A changed path is reported again; an unchanged one sends nothing.
   */
  async #recheckPath(step: number): Promise<void> {
    if (this.#closed) return;
    const idle = () => this.#status !== "connected" || this.#switch !== null;
    const pair = idle() ? null : await selectedPair(this.#pc);
    if (this.#closed || this.#recheckTimer !== undefined) return;
    const report = pair && !idle() ? pathReport(pair) : null;
    if (report && !(this.#lastReport && samePath(report, this.#lastReport))) {
      this.#log.debug("media path updated", { participantId: this.peerId, ...report });
      this.#sendPath(report);
      return;
    }
    this.#scheduleRecheck(step + 1);
  }

  #clearRecheck(): void {
    if (this.#recheckTimer !== undefined) this.#env.clearTimeout(this.#recheckTimer);
    this.#recheckTimer = undefined;
  }

  #fail(reason: LinkFailure): void {
    if (this.#closed || this.#status === "failed") return;
    this.#clearTimer();
    this.#setStatus("failed", reason);
    this.close();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#env.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/** The connection identifier on the origin line of a session description; it stays the same across restarts. */
function sessionOrigin(sdp: string): string | undefined {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("o=")) return line.split(" ")[1];
  }
  return undefined;
}
