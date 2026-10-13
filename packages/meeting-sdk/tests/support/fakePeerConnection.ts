/**
 * In-memory stand-in for `RTCPeerConnection`. Connections created through the same {@link FakePeerNetwork} link
 * through the descriptions they exchange: an offer names the connection that created it, so applying it on another
 * connection pairs the two. A pair connects once both sides are stable and each has applied a candidate from the
 * other, so dropped or misrouted candidates keep a pair from connecting.
 */
import type { IceCandidateLike, SessionDescriptionLike } from "../../src/internal/env.js";
import type { FakeTrack } from "./fakeMediaDevices.js";

type Kind = "audio" | "video";
type TrackLike = FakeTrack | FakeRemoteTrack;

let streamCounter = 0;

export class FakeMediaStream {
  readonly id: string;
  readonly #tracks: TrackLike[];

  constructor(tracks: unknown[] = []) {
    streamCounter += 1;
    this.id = `remote-stream-${streamCounter}`;
    this.#tracks = [...(tracks as TrackLike[])];
  }

  getTracks(): TrackLike[] {
    return [...this.#tracks];
  }

  getAudioTracks(): TrackLike[] {
    return this.#tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks(): TrackLike[] {
    return this.#tracks.filter((track) => track.kind === "video");
  }
}

/** A received track. `source` is the sender track currently feeding it from the linked connection. */
export class FakeRemoteTrack {
  readonly id: string;
  readonly kind: Kind;
  enabled = true;
  readyState: "live" | "ended" = "live";
  readonly #owner: FakePeerConnection;

  constructor(owner: FakePeerConnection, kind: Kind, index: number) {
    this.#owner = owner;
    this.kind = kind;
    this.id = `${owner.id}-receiver-${index}`;
  }

  get source(): FakeTrack | null {
    const linked = this.#owner.linked;
    if (!linked || linked.closed || this.#owner.closed) return null;
    const transceiver = linked.transceivers.find((t) => t.kind === this.kind);
    return transceiver?.sender.track ?? null;
  }

  stop(): void {
    this.readyState = "ended";
  }
}

export class FakeSender {
  track: FakeTrack | null = null;
  /** Every `replaceTrack` argument, in order. */
  readonly replaceCalls: (FakeTrack | null)[] = [];
  readonly #owner: FakePeerConnection;

  constructor(owner: FakePeerConnection) {
    this.#owner = owner;
  }

  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.#owner.consumeFailure("replaceTrack");
    this.track = track as unknown as FakeTrack | null;
    this.replaceCalls.push(this.track);
  }
}

export class FakeTransceiver {
  readonly kind: Kind;
  direction: string;
  mid: string | null = null;
  readonly sender: FakeSender;
  readonly receiver: { readonly track: FakeRemoteTrack };

  constructor(owner: FakePeerConnection, kind: Kind, direction: string, index: number) {
    this.kind = kind;
    this.direction = direction;
    this.sender = new FakeSender(owner);
    this.receiver = { track: new FakeRemoteTrack(owner, kind, index) };
  }
}

export type FakeFailurePoint =
  | "construct"
  | "createOffer"
  | "createAnswer"
  | "setLocalDescription"
  | "setRemoteDescription"
  | "addIceCandidate"
  | "replaceTrack";

export type FakeConfiguration = {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  [field: string]: unknown;
};

/** The selected candidate pair as the browser's stats would report it. */
export type FakeCandidatePair = { localId: string; localType: string; remoteId: string; remoteType: string };

type StateListener = ((event: unknown) => void) | null;

const SDP_PREFIX = "v=0\r\no=fake-session ";
const RESTART_LINE = "a=fake-ice-restart";

function encodeSdp(owner: string, kinds: { kind: Kind; direction: string }[], restart = false): string {
  const marker = restart ? `${RESTART_LINE}\r\n` : "";
  return `${SDP_PREFIX}${owner}\r\n${marker}${kinds.map((k) => `m=${k.kind}\r\na=${k.direction}\r\n`).join("")}`;
}

function decodeSdp(sdp: string): { owner: string; restart: boolean; kinds: { kind: Kind; direction: string }[] } | undefined {
  if (!sdp.startsWith(SDP_PREFIX)) return undefined;
  const lines = sdp.split("\r\n");
  const owner = (lines[1] ?? "").slice("o=fake-session ".length);
  const kinds: { kind: Kind; direction: string }[] = [];
  for (let i = 2; i < lines.length; i++) {
    const match = /^m=(audio|video)$/.exec(lines[i] ?? "");
    if (match) kinds.push({ kind: match[1] as Kind, direction: (lines[i + 1] ?? "").slice(2) });
  }
  return { owner, restart: lines.includes(RESTART_LINE), kinds };
}

/** Browser-managed configuration fields the engine must carry over when it replaces the server list. */
const BROWSER_DEFAULTS = { bundlePolicy: "balanced", rtcpMuxPolicy: "require", iceCandidatePoolSize: 0 };

export class FakePeerConnection {
  readonly id: string;
  /** The current configuration's server list (updated by `setConfiguration`). */
  configuration: FakeConfiguration;
  /** Every `setConfiguration` argument, in order. */
  readonly configurationCalls: FakeConfiguration[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  /** Candidates applied with `addIceCandidate`, in order. */
  readonly addedCandidates: IceCandidateLike[] = [];
  /** Whether the most recent `createOffer` asked for an ICE restart. */
  lastOfferWasRestart = false;
  /** Restart offers created so far. */
  restartOffers = 0;
  /** Restarts that took effect on this connection (local restart offer, or answer to a remote one). */
  restarts = 0;
  /** `getStats()` rejects, as a browser without stats would. */
  statsUnavailable = false;
  /** Stats omit the transport report, so the selected pair must be found from the candidate pairs. */
  statsWithoutTransport = false;
  /** What happens to the selected pair after a restart: a fresh local candidate (`auto`) or nothing (`never`). */
  restartBehaviour: "auto" | "never" = "auto";
  signalingState = "stable";
  iceConnectionState = "new";
  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;
  linked: FakePeerConnection | undefined;
  closed = false;
  onicecandidate: ((event: { readonly candidate: IceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: StateListener = null;
  oniceconnectionstatechange: StateListener = null;
  ontrack: StateListener = null;

  readonly #network: FakePeerNetwork;
  #connectionState = "new";
  #candidateSent = false;
  readonly #localCandidates = new Map<string, string>();
  readonly #remoteCandidates = new Map<string, string>();
  #selected: FakeCandidatePair | null = null;
  readonly #scheduledPairs: { delayMs: number; pair: FakeCandidatePair }[] = [];
  #restartPending = false;
  #candidateCounter = 0;

  constructor(network: FakePeerNetwork, configuration: FakeConfiguration) {
    network.consumeFailure("construct");
    this.#network = network;
    this.id = `pc-${network.connections.length + 1}`;
    this.configuration = structuredClone(configuration);
    network.connections.push(this);
  }

  /** The pair the browser currently reports as selected, or null before the first connection. */
  get selectedPair(): FakeCandidatePair | null {
    return this.#selected ? { ...this.#selected } : null;
  }

  setSelectedPair(pair: FakeCandidatePair): void {
    this.#localCandidates.set(pair.localId, pair.localType);
    this.#remoteCandidates.set(pair.remoteId, pair.remoteType);
    this.#selected = { ...pair };
  }

  addLocalCandidate(id: string, type: string): void {
    this.#localCandidates.set(id, type);
  }

  /** The next restart on this connection selects `pair` after `delayMs` instead of the automatic fresh pair. */
  scheduleNewPairAfterRestart(delayMs: number, pair: FakeCandidatePair): void {
    this.#scheduledPairs.push({ delayMs, pair });
  }

  /** Plays connection states in order; each step waits `afterMs` after the previous one. */
  playStates(steps: readonly { state: string; afterMs: number }[]): void {
    let at = 0;
    for (const step of steps) {
      at += step.afterMs;
      setTimeout(() => this.setConnectionState(step.state), at);
    }
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    if (this.statsUnavailable) throw new DOMException("stats unavailable", "InvalidStateError");
    const reports = new Map<string, Record<string, unknown>>();
    for (const [id, candidateType] of this.#localCandidates) reports.set(id, { id, type: "local-candidate", candidateType });
    for (const [id, candidateType] of this.#remoteCandidates) reports.set(id, { id, type: "remote-candidate", candidateType });
    const selected = this.#selected;
    if (selected) {
      const pairId = `pair-${selected.localId}-${selected.remoteId}`;
      reports.set(`${pairId}-stale`, {
        id: `${pairId}-stale`,
        type: "candidate-pair",
        localCandidateId: "stale-local",
        remoteCandidateId: selected.remoteId,
        state: "failed",
        nominated: false,
      });
      reports.set(pairId, {
        id: pairId,
        type: "candidate-pair",
        localCandidateId: selected.localId,
        remoteCandidateId: selected.remoteId,
        state: "succeeded",
        nominated: true,
      });
      if (!this.statsWithoutTransport) {
        reports.set("transport-0", { id: "transport-0", type: "transport", selectedCandidatePairId: pairId });
      }
    }
    return reports;
  }

  getConfiguration(): FakeConfiguration {
    return { ...BROWSER_DEFAULTS, ...structuredClone(this.configuration) };
  }

  setConfiguration(configuration: FakeConfiguration): void {
    const copy = structuredClone(configuration);
    this.configurationCalls.push(copy);
    this.configuration = { iceServers: copy.iceServers ?? [] };
  }

  /** Undefined when the network models a browser without `connectionState`. */
  get connectionState(): string | undefined {
    return this.#network.withoutConnectionState ? undefined : this.#connectionState;
  }

  get remoteCandidatesApplied(): number {
    return this.addedCandidates.filter((c) => c.candidate !== "").length;
  }

  addTransceiver(kind: Kind, init: { direction: "sendrecv" }): FakeTransceiver {
    const transceiver = new FakeTransceiver(this, kind, init.direction, this.transceivers.length);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.transceivers];
  }

  async createOffer(options: { iceRestart?: boolean } = {}): Promise<SessionDescriptionLike> {
    this.consumeFailure("createOffer");
    const restart = options.iceRestart === true;
    this.lastOfferWasRestart = restart;
    if (restart) this.restartOffers += 1;
    return { type: "offer", sdp: encodeSdp(this.id, this.transceivers, restart) };
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    this.consumeFailure("createAnswer");
    if (this.signalingState !== "have-remote-offer") throw new DOMException("no remote offer", "InvalidStateError");
    return { type: "answer", sdp: encodeSdp(this.id, this.transceivers) };
  }

  async setLocalDescription(description: SessionDescriptionLike): Promise<void> {
    this.consumeFailure("setLocalDescription");
    this.#assertOpen();
    if (description.type === "offer") {
      if (this.signalingState !== "stable") throw new DOMException("not stable", "InvalidStateError");
      this.signalingState = "have-local-offer";
      this.transceivers.forEach((t, i) => {
        t.mid = String(i);
      });
    } else {
      if (this.signalingState !== "have-remote-offer") throw new DOMException("no remote offer", "InvalidStateError");
      this.signalingState = "stable";
    }
    this.localDescription = { type: description.type, sdp: description.sdp ?? "" };
    const restart =
      description.type === "offer" ? decodeSdp(description.sdp ?? "")?.restart === true : this.#restartPending;
    if (restart) this.#beginRestart();
    this.#emitCandidates();
    this.#network.evaluate(this);
  }

  async setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    this.consumeFailure("setRemoteDescription");
    this.#assertOpen();
    const decoded = decodeSdp(description.sdp);
    if (!decoded) throw new DOMException("unparsable description", "OperationError");
    if (description.type === "offer") {
      if (this.signalingState !== "stable") throw new DOMException("not stable", "InvalidStateError");
      this.signalingState = "have-remote-offer";
      this.#restartPending = decoded.restart;
      decoded.kinds.forEach((k, i) => {
        if (!this.transceivers[i]) this.addTransceiver(k.kind, { direction: "recvonly" as "sendrecv" });
        const transceiver = this.transceivers[i];
        if (transceiver) transceiver.mid = String(i);
      });
    } else {
      if (this.signalingState !== "have-local-offer") throw new DOMException("no local offer", "InvalidStateError");
      this.signalingState = "stable";
    }
    this.remoteDescription = { type: description.type, sdp: description.sdp };
    this.linked = this.#network.connections.find((pc) => pc.id === decoded.owner);
    this.#network.evaluate(this);
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    this.consumeFailure("addIceCandidate");
    this.#assertOpen();
    if (!this.remoteDescription) throw new DOMException("no remote description", "InvalidStateError");
    this.addedCandidates.push({ ...candidate });
    this.#network.evaluate(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signalingState = "closed";
    this.#connectionState = "closed";
    this.iceConnectionState = "closed";
    for (const transceiver of this.transceivers) transceiver.receiver.track.stop();
  }

  /** Scripted state change, as the browser would report it. */
  setConnectionState(state: string): void {
    if (this.closed) return;
    if (state === "connected" && !this.#selected) {
      const { local, remote } = this.#network.defaultCandidateTypes;
      this.setSelectedPair({
        localId: this.#nextLocalId(),
        localType: local,
        remoteId: `${this.id}-remote-1`,
        remoteType: remote,
      });
    }
    this.#connectionState = state;
    this.iceConnectionState = state === "connecting" ? "checking" : state;
    if (this.#network.withoutConnectionState) this.oniceconnectionstatechange?.({});
    else this.onconnectionstatechange?.({});
  }

  consumeFailure(point: FakeFailurePoint): void {
    this.#network.consumeFailure(point);
  }

  #assertOpen(): void {
    if (this.closed) throw new DOMException("connection closed", "InvalidStateError");
  }

  #nextLocalId(): string {
    this.#candidateCounter += 1;
    return `${this.id}-local-${this.#candidateCounter}`;
  }

  /** New credentials, new candidates: gathering starts again and a fresh local candidate is selected later. */
  #beginRestart(): void {
    this.#restartPending = false;
    this.#candidateSent = false;
    this.restarts += 1;
    const scheduled = this.#scheduledPairs.shift();
    if (scheduled) {
      setTimeout(() => {
        if (!this.closed) this.setSelectedPair(scheduled.pair);
      }, scheduled.delayMs);
      return;
    }
    if (this.restartBehaviour === "never") return;
    const previous = this.#selected;
    queueMicrotask(() => {
      if (this.closed || !previous) return;
      this.setSelectedPair({ ...previous, localId: this.#nextLocalId() });
    });
  }

  #emitCandidates(): void {
    if (this.#candidateSent) return;
    this.#candidateSent = true;
    queueMicrotask(() => {
      if (this.closed) return;
      const candidate: IceCandidateLike = {
        candidate: `candidate:1 1 udp 2122260223 192.0.2.${this.#network.connections.indexOf(this) + 1} 50000 typ host`,
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "frag",
      };
      this.onicecandidate?.({ candidate });
      this.onicecandidate?.({ candidate: null });
    });
  }
}

export class FakePeerNetwork {
  readonly connections: FakePeerConnection[] = [];
  /** Failure points consumed by the next matching call on any connection. */
  readonly failures: FakeFailurePoint[] = [];
  /** When false, linked pairs never connect on their own (connection timeouts, scripted states). */
  autoConnect = true;
  /** Models a browser that reports only `iceConnectionState`. */
  withoutConnectionState = false;
  /** Candidate types of the pair selected when a connection first connects. */
  defaultCandidateTypes: { local: string; remote: string } = { local: "host", remote: "host" };
  readonly RTCPeerConnection: new (configuration: FakeConfiguration) => FakePeerConnection;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const network = this;
    this.RTCPeerConnection = class extends FakePeerConnection {
      constructor(configuration: FakeConfiguration) {
        super(network, configuration);
      }
    };
  }

  failNext(point: FakeFailurePoint): void {
    this.failures.push(point);
  }

  consumeFailure(point: FakeFailurePoint): void {
    const index = this.failures.indexOf(point);
    if (index === -1) return;
    this.failures.splice(index, 1);
    throw new DOMException(`fake ${point} failure`, "OperationError");
  }

  open(): FakePeerConnection[] {
    return this.connections.filter((pc) => !pc.closed);
  }

  /** Connects a linked pair once both sides are stable and each applied a candidate from the other. */
  evaluate(pc: FakePeerConnection): void {
    if (!this.autoConnect) return;
    const other = pc.linked;
    if (!other || other.linked !== pc) return;
    for (const side of [pc, other]) {
      if (side.closed || side.signalingState !== "stable" || !side.remoteDescription) return;
      if (side.remoteCandidatesApplied === 0) return;
      if (side.connectionState === "connected" || side.iceConnectionState === "connected") return;
    }
    queueMicrotask(() => {
      for (const side of [pc, other]) side.setConnectionState("connecting");
      for (const side of [pc, other]) side.setConnectionState("connected");
    });
  }
}
