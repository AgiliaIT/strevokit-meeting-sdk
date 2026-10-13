/** The subset of the browser `WebSocket` the engine uses. */
export interface SocketLike {
  readonly protocol: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketConstructor = new (url: string, protocols: string[]) => SocketLike;

/** The subset of `navigator.mediaDevices` the engine uses. */
export interface MediaDevicesLike {
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia?(options?: DisplayMediaStreamOptions): Promise<MediaStream>;
}

export type TimerHandle = unknown;

/** The subset of `RTCRtpTransceiver` the engine uses. */
export interface TransceiverLike {
  direction: string;
  readonly sender: { readonly track: MediaStreamTrack | null; replaceTrack(track: MediaStreamTrack | null): Promise<void> };
  readonly receiver: { readonly track: MediaStreamTrack };
}

export type SessionDescriptionLike = { readonly type: string; readonly sdp?: string };

export type IceCandidateLike = {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
};

/** The fields of an `RTCStats` entry the engine reads; every other field is ignored. */
export type StatsReportLike = {
  readonly type: string;
  readonly id: string;
  readonly selectedCandidatePairId?: string;
  readonly localCandidateId?: string;
  readonly remoteCandidateId?: string;
  readonly candidateType?: string;
  readonly state?: string;
  readonly nominated?: boolean;
};

/** The subset of `RTCStatsReport` the engine uses. */
export interface StatsCollectionLike {
  forEach(callback: (report: StatsReportLike) => void): void;
}

export type IceServerLike = { urls: string | string[]; username?: string; credential?: string };

/** The subset of `RTCConfiguration` the engine reads and writes; other fields pass through untouched. */
export type PeerConfigurationLike = { iceServers?: IceServerLike[] };

/** The subset of `RTCPeerConnection` the engine uses. */
export interface PeerConnectionLike {
  readonly signalingState: string;
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly localDescription: SessionDescriptionLike | null;
  onicecandidate: ((event: { readonly candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  addTransceiver(kind: "audio" | "video", init: { direction: "sendrecv" }): TransceiverLike;
  getTransceivers(): TransceiverLike[];
  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  getStats(): Promise<StatsCollectionLike>;
  getConfiguration(): PeerConfigurationLike;
  setConfiguration(configuration: PeerConfigurationLike): void;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  close(): void;
}

export type PeerConnectionConstructor = new (configuration: {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
}) => PeerConnectionLike;

export type MediaStreamConstructor = new (tracks: MediaStreamTrack[]) => MediaStream;

/** Browser capabilities the engine depends on, resolved once per engine. */
export interface EngineEnvironment {
  readonly WebSocket: SocketConstructor | undefined;
  readonly mediaDevices: MediaDevicesLike | undefined;
  readonly RTCPeerConnection?: PeerConnectionConstructor | undefined;
  readonly MediaStream?: MediaStreamConstructor | undefined;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}

let override: EngineEnvironment | undefined;

export function defaultEnvironment(): EngineEnvironment {
  const scope = globalThis as {
    WebSocket?: unknown;
    RTCPeerConnection?: unknown;
    MediaStream?: unknown;
    navigator?: { mediaDevices?: MediaDevicesLike };
  };
  return {
    WebSocket: typeof scope.WebSocket === "function" ? (scope.WebSocket as SocketConstructor) : undefined,
    mediaDevices: scope.navigator?.mediaDevices,
    RTCPeerConnection:
      typeof scope.RTCPeerConnection === "function" ? (scope.RTCPeerConnection as PeerConnectionConstructor) : undefined,
    MediaStream: typeof scope.MediaStream === "function" ? (scope.MediaStream as MediaStreamConstructor) : undefined,
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    now: () => Date.now(),
  };
}

export function currentEnvironment(): EngineEnvironment {
  return override ?? defaultEnvironment();
}

/** Replaces the environment for engines created afterwards; `undefined` restores the default. */
export function __setTestEnvironment(environment: EngineEnvironment | undefined): void {
  override = environment;
}
