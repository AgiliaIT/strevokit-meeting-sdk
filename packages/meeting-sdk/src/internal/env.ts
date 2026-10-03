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

/** Browser capabilities the engine depends on, resolved once per engine. */
export interface EngineEnvironment {
  readonly WebSocket: SocketConstructor | undefined;
  readonly mediaDevices: MediaDevicesLike | undefined;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}

let override: EngineEnvironment | undefined;

export function defaultEnvironment(): EngineEnvironment {
  const scope = globalThis as {
    WebSocket?: unknown;
    navigator?: { mediaDevices?: MediaDevicesLike };
  };
  return {
    WebSocket: typeof scope.WebSocket === "function" ? (scope.WebSocket as SocketConstructor) : undefined,
    mediaDevices: scope.navigator?.mediaDevices,
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
