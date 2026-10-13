import {
  type MessageType,
  type PayloadMap,
  type SignalingMessage,
  createSignalingMessage,
  decodeSignalingFrame,
  encodeSignalingMessage,
} from "@strevokit/signaling-protocol";
import type { EngineEnvironment, SocketLike } from "./env.js";
import type { Log } from "./log.js";
import type { Addressing } from "./token.js";

export const SIGNALING_SUBPROTOCOL = "strevokit.signaling.v1";
const TOKEN_SUBPROTOCOL_PREFIX = "strevokit.join-token.";
/** Close code reported when the connection could not be established or was lost without a close frame. */
export const ABNORMAL_CLOSE = 1006;

/** Every frame type the engine sends; all have an empty payload. */
export const OUTBOUND_TYPES = Object.freeze([
  "participant.join",
  "participant.leave",
  "media.camera.started",
  "media.camera.stopped",
  "media.microphone.started",
  "media.microphone.stopped",
  "media.screen.started",
  "media.screen.stopped",
] as const satisfies readonly MessageType[]);

export type OutboundType = (typeof OUTBOUND_TYPES)[number];

/** Media-negotiation and connection-report frames, sent on behalf of the media delivery. */
export const PEER_OUTBOUND_TYPES = Object.freeze([
  "webrtc.offer",
  "webrtc.answer",
  "webrtc.ice_candidate",
  "webrtc.connected",
  "webrtc.disconnected",
  "webrtc.failed",
  "webrtc.ice_restart",
  "webrtc.ice_restart_result",
] as const satisfies readonly MessageType[]);

export type PeerOutboundType = (typeof PEER_OUTBOUND_TYPES)[number];

export interface SessionCallbacks {
  onMessage(message: SignalingMessage): void;
  onProtocolError(): void;
  /** `opened` is false when the connection never reached the open state. Called at most once. */
  onClose(code: number, reason: string, opened: boolean): void;
}

export interface SessionOptions {
  env: EngineEnvironment;
  realtimeUrl: string;
  token: string;
  addressing: Addressing;
  log: Log;
  callbacks: SessionCallbacks;
}

/** One signaling connection: handshake, frame encoding and decoding, and close reporting. */
export class SignalingSession {
  readonly #env: EngineEnvironment;
  readonly #url: string;
  readonly #addressing: Addressing;
  readonly #log: Log;
  #token: string | undefined;
  #callbacks: SessionCallbacks | undefined;
  #socket: SocketLike | undefined;
  #opened = false;

  constructor(options: SessionOptions) {
    this.#env = options.env;
    this.#url = `${options.realtimeUrl}/v1/meetings/${options.addressing.meetingId}/signaling`;
    this.#addressing = options.addressing;
    this.#log = options.log;
    this.#token = options.token;
    this.#callbacks = options.callbacks;
  }

  open(): void {
    const token = this.#token;
    this.#token = undefined;
    const Socket = this.#env.WebSocket;
    if (!Socket || token === undefined) {
      this.#fail();
      return;
    }
    let socket: SocketLike;
    try {
      socket = new Socket(this.#url, [SIGNALING_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`]);
    } catch {
      this.#log.warn("connection could not be created");
      this.#fail();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => this.#handleOpen();
    socket.onmessage = (event) => this.#handleFrame(event.data);
    socket.onclose = (event) => this.#handleClose(event.code, event.reason);
    socket.onerror = () => undefined;
  }

  /** Sends an empty-payload frame. Returns false when the connection is not open or the frame cannot be built. */
  send(type: OutboundType): boolean {
    const socket = this.#socket;
    if (!socket || !this.#opened || !this.#callbacks) return false;
    try {
      const message = createSignalingMessage(type, {
        meetingId: this.#addressing.meetingId,
        participantId: this.#addressing.participantId,
        payload: {},
      });
      socket.send(encodeSignalingMessage(message));
      return true;
    } catch {
      this.#log.warn("frame could not be sent", { messageType: type });
      return false;
    }
  }

  /**
   * Sends a media frame. Returns false when the connection is not open or the frame fails validation. The payload
   * is never logged.
   */
  sendPeer<T extends PeerOutboundType>(type: T, payload: PayloadMap[T]): boolean {
    const socket = this.#socket;
    if (!socket || !this.#opened || !this.#callbacks) return false;
    try {
      const message = createSignalingMessage(type, {
        meetingId: this.#addressing.meetingId,
        participantId: this.#addressing.participantId,
        payload,
      });
      socket.send(encodeSignalingMessage(message as SignalingMessage));
      return true;
    } catch {
      this.#log.debug("frame could not be sent", { messageType: type });
      return false;
    }
  }

  /** Closes the connection. No further callbacks are made. */
  close(code = 1000): void {
    this.#callbacks = undefined;
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.close(code);
    } catch {
      // Already closing or closed.
    }
  }

  #handleOpen(): void {
    if (!this.#callbacks) return;
    if (this.#socket?.protocol !== SIGNALING_SUBPROTOCOL) {
      this.#log.warn("unexpected subprotocol negotiated");
      const socket = this.#socket;
      this.#fail();
      try {
        socket?.close(1000);
      } catch {
        // Ignore: the connection is being abandoned.
      }
      return;
    }
    this.#opened = true;
  }

  #handleFrame(data: unknown): void {
    const callbacks = this.#callbacks;
    if (!callbacks) return;
    const result = decodeSignalingFrame(data, { direction: "server_to_client" });
    try {
      if (result.ok) callbacks.onMessage(result.message);
      else {
        this.#log.debug("invalid frame received", { code: result.error.code });
        callbacks.onProtocolError();
      }
    } catch {
      this.#log.error("frame handling failed");
    }
  }

  #handleClose(code: number, reason: string): void {
    const callbacks = this.#callbacks;
    this.#callbacks = undefined;
    if (!callbacks) return;
    try {
      callbacks.onClose(typeof code === "number" ? code : ABNORMAL_CLOSE, typeof reason === "string" ? reason : "", this.#opened);
    } catch {
      this.#log.error("close handling failed");
    }
  }

  #fail(): void {
    const callbacks = this.#callbacks;
    this.#callbacks = undefined;
    if (!callbacks) return;
    try {
      callbacks.onClose(ABNORMAL_CLOSE, "", false);
    } catch {
      this.#log.error("close handling failed");
    }
  }
}
