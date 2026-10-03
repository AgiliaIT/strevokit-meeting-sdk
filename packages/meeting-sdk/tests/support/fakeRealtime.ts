/**
 * In-memory stand-in for the realtime signaling service (protocol v1). Frames are built and validated with the
 * real protocol package so the SDK is exercised against the same rules as production.
 */
import {
  type MessageType,
  type PayloadMap,
  type Role,
  type SignalingMessage,
  createSignalingMessage,
  decodeSignalingFrame,
  encodeSignalingMessage,
  isRoleAllowed,
} from "@strevokit/signaling-protocol";
import type { SocketConstructor, SocketLike } from "../../src/internal/env.js";
import type { MediaKind } from "../../src/public/types.js";

export const SIGNALING_SUBPROTOCOL = "strevokit.signaling.v1";
const TOKEN_PREFIX = "strevokit.join-token.";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let ulidCounter = 0;

/** A fresh canonical ULID, unique within the test process. */
export function testUlid(): string {
  ulidCounter += 1;
  let n = ulidCounter;
  let tail = "";
  for (let i = 0; i < 10; i++) {
    tail = CROCKFORD[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `01JQ${"0".repeat(12)}${tail}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export type TestTokenClaims = {
  meetingId: string;
  participantId: string;
  role?: Role;
  /** Seconds since the epoch. Defaults to one hour from now. */
  exp?: number;
  tenantId?: string;
  /** `"invalid"` makes the fake server reject the token with 4001. */
  signature?: string;
};

/** A well-formed but unsigned JWT with the claims the realtime service issues. */
export function makeTestToken(claims: TestTokenClaims): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      tenant_id: claims.tenantId ?? "01JQAAAAAAAAAAAAAAAAAAAAAA",
      meeting_id: claims.meetingId,
      participant_id: claims.participantId,
      role: claims.role ?? "participant",
      exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.${claims.signature ?? "test-signature"}`;
}

type DecodedToken = { meetingId: string; participantId: string; role: Role; exp: number; signature: string };

function decodeToken(token: string): DecodedToken | undefined {
  try {
    const [, payload, signature] = token.split(".");
    if (payload === undefined || signature === undefined) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof claims.meeting_id !== "string" || typeof claims.participant_id !== "string") return undefined;
    const role = claims.role === "host" ? "host" : "participant";
    return {
      meetingId: claims.meeting_id,
      participantId: claims.participant_id,
      role,
      exp: typeof claims.exp === "number" ? claims.exp : 0,
      signature,
    };
  } catch {
    return undefined;
  }
}

export type HandshakeBehaviour =
  | { kind: "close"; code: number; reason?: string }
  | { kind: "refuse" }
  | { kind: "never_open" }
  | { kind: "protocol"; protocol: string }
  | { kind: "throw" };

type MediaState = { camera: boolean; microphone: boolean; screen: boolean };

type Member = {
  participantId: string;
  role: Role;
  displayName?: string;
  media: MediaState;
  socket?: FakeWebSocket;
};

const CLOSE_REASONS: Record<number, string> = {
  1000: "left",
  1001: "shutting_down",
  4001: "invalid_join_token",
  4002: "join_token_expired",
  4003: "origin_not_allowed",
  4008: "join_timeout",
  4009: "session_replaced",
  4010: "heartbeat_timeout",
  4011: "protocol_violation",
  4029: "rate_limited",
  4503: "service_unavailable",
};

export class FakeWebSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: readonly string[];
  protocol = "";
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Raw frames the client sent, in order. */
  readonly sent: string[] = [];
  /** Server-side view of the connection. */
  token: DecodedToken | undefined;
  joined = false;
  closeCode: number | undefined;

  readonly #server: FakeRealtime;

  constructor(server: FakeRealtime, url: string, protocols: string[]) {
    this.#server = server;
    this.url = url;
    this.protocols = [...protocols];
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new DOMException("socket is not open", "InvalidStateError");
    this.sent.push(data);
    this.#server.enqueue(() => this.#server.receive(this, data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    this.#server.enqueue(() => this.#server.clientClosed(this, code, reason));
  }

  /** Sent client frames decoded, for assertions. */
  sentTypes(): string[] {
    return this.sent.map((frame) => (JSON.parse(frame) as { type: string }).type);
  }
}

export type PresentParticipant = {
  participantId: string;
  role?: Role;
  displayName?: string;
  media?: Partial<MediaState>;
};

export class FakeRealtime {
  readonly meetingId: string;
  readonly WebSocket: SocketConstructor;
  readonly sockets: FakeWebSocket[] = [];
  /** Exceptions thrown by client callbacks. Must stay empty: the SDK never throws from socket handlers. */
  readonly handlerErrors: unknown[] = [];
  /** Client frames that failed protocol validation. */
  readonly invalidClientFrames: string[] = [];
  /** When set, `participant.join` is accepted but the snapshot and welcome are withheld. */
  holdWelcome = false;
  /** When set, `participant.leave` is ignored (no close), to exercise the leave fallback. */
  ignoreLeave = false;
  now: () => number = () => Date.now();

  readonly #members = new Map<string, Member>();
  readonly #displayNames = new Map<string, string>();
  readonly #handshakes: HandshakeBehaviour[] = [];
  readonly #rejections: string[] = [];
  readonly #heldJoins: FakeWebSocket[] = [];

  constructor(options: { meetingId?: string } = {}) {
    this.meetingId = options.meetingId ?? testUlid();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    this.WebSocket = class extends FakeWebSocket {
      constructor(url: string, protocols: string[]) {
        super(server, url, protocols);
        server.accept(this);
      }
    } as unknown as SocketConstructor;
  }

  // ---- script API -------------------------------------------------------------------------------------------

  tokenFor(participantId: string, role: Role = "participant", extra: Partial<TestTokenClaims> = {}): string {
    return makeTestToken({ meetingId: this.meetingId, participantId, role, ...extra });
  }

  setDisplayName(participantId: string, displayName: string): void {
    this.#displayNames.set(participantId, displayName);
  }

  /** The next connection attempt behaves as scripted instead of authenticating. */
  nextHandshake(behaviour: HandshakeBehaviour): void {
    this.#handshakes.push(behaviour);
  }

  /** The next media frame from any client is answered with `session.rejected { code }` instead of being relayed. */
  rejectNext(code: string): void {
    this.#rejections.push(code);
  }

  /** A participant already in the meeting, without a real connection. */
  addPresent(present: PresentParticipant): void {
    const member: Member = {
      participantId: present.participantId,
      role: present.role ?? "participant",
      media: { camera: false, microphone: false, screen: false, ...present.media },
    };
    if (present.displayName !== undefined) member.displayName = present.displayName;
    this.#members.set(present.participantId, member);
  }

  /** A participant without a real connection joins now; connected clients receive `participant.joined`. */
  virtualJoin(present: PresentParticipant): void {
    this.addPresent(present);
    const member = this.#members.get(present.participantId);
    if (!member) return;
    const payload: PayloadMap["participant.joined"] = { role: member.role };
    if (member.displayName !== undefined) payload.displayName = member.displayName;
    this.#broadcast(present.participantId, this.#frame("participant.joined", present.participantId, payload));
  }

  virtualLeave(participantId: string, reason = "left"): void {
    this.#members.delete(participantId);
    this.#broadcast(participantId, this.#frame("participant.left", participantId, { reason }));
  }

  virtualMedia(participantId: string, kind: MediaKind, enabled: boolean): void {
    const member = this.#members.get(participantId);
    if (member) member.media[kind] = enabled;
    const type = `media.${kind}.${enabled ? "started" : "stopped"}` as MessageType;
    this.#broadcast(participantId, this.#frame(type, participantId, {} as never));
  }

  /** Close a connection from the server with `code` (default: the most recent connection). */
  closeWith(code: number, participantId?: string): void {
    const socket = this.socketFor(participantId);
    this.enqueue(() => this.#serverClose(socket, code));
  }

  /** Deliver a raw frame to a connection (default: the most recent connection). */
  send(frame: string, participantId?: string): void {
    const socket = this.socketFor(participantId);
    this.enqueue(() => this.#deliver(socket, frame));
  }

  /** Deliver a valid server message to a connection. */
  sendMessage<T extends MessageType>(type: T, payload: PayloadMap[T], fromParticipantId: string, to?: string): void {
    this.send(this.#frame(type, fromParticipantId, payload), to);
  }

  /** Every joined connection receives `meeting.ended` (or `meeting.terminated`). */
  endMeeting(kind: "ended" | "terminated" = "ended"): void {
    const at = new Date(this.now()).toISOString();
    for (const socket of this.#joinedSockets()) {
      const frame =
        kind === "ended"
          ? this.#frame("meeting.ended", this.#participantOf(socket), { endedAt: at })
          : this.#frame("meeting.terminated", this.#participantOf(socket), { terminatedAt: at, reason: "admin_action" });
      this.enqueue(() => this.#deliver(socket, frame));
    }
  }

  /** The connection disappears without a close handshake (close code 1006). */
  dropWithoutClose(participantId?: string): void {
    const socket = this.socketFor(participantId);
    this.enqueue(() => this.#finishAbnormally(socket));
  }

  /** Send the withheld snapshot and welcome to every connection held by `holdWelcome`. */
  releaseWelcome(): void {
    this.holdWelcome = false;
    for (const socket of this.#heldJoins.splice(0)) this.enqueue(() => this.#completeJoin(socket));
  }

  socketFor(participantId?: string): FakeWebSocket {
    const socket =
      participantId === undefined
        ? this.sockets[this.sockets.length - 1]
        : [...this.sockets].reverse().find((s) => s.token?.participantId === participantId);
    if (!socket) throw new Error("no such connection");
    return socket;
  }

  /** Participant IDs currently joined, in join order. */
  presentIds(): string[] {
    return [...this.#members.keys()];
  }

  memberMedia(participantId: string): MediaState | undefined {
    const media = this.#members.get(participantId)?.media;
    return media ? { ...media } : undefined;
  }

  // ---- server behaviour -------------------------------------------------------------------------------------

  enqueue(task: () => void): void {
    queueMicrotask(task);
  }

  accept(socket: FakeWebSocket): void {
    const behaviour = this.#handshakes.shift();
    if (behaviour?.kind === "throw") throw new DOMException("invalid url", "SyntaxError");
    this.sockets.push(socket);
    this.enqueue(() => this.#handshake(socket, behaviour));
  }

  #handshake(socket: FakeWebSocket, behaviour: HandshakeBehaviour | undefined): void {
    const tokens = socket.protocols.filter((p) => p.startsWith(TOKEN_PREFIX));
    const pathOk = /^wss?:\/\/[^/]+\/v1\/meetings\/[0-9A-HJKMNP-TV-Z]{26}\/signaling$/.test(socket.url);
    if (!socket.protocols.includes(SIGNALING_SUBPROTOCOL) || tokens.length !== 1 || !pathOk) {
      this.#refuse(socket);
      return;
    }
    if (behaviour?.kind === "refuse") {
      this.#refuse(socket);
      return;
    }
    if (behaviour?.kind === "never_open") return;

    const token = decodeToken((tokens[0] ?? "").slice(TOKEN_PREFIX.length));
    const pathMeeting = socket.url.split("/")[5];
    this.#open(socket, behaviour?.kind === "protocol" ? behaviour.protocol : SIGNALING_SUBPROTOCOL);
    if (!token || token.signature === "invalid" || token.meetingId !== pathMeeting) {
      this.#serverClose(socket, 4001);
      return;
    }
    if (token.exp <= Math.floor(this.now() / 1000)) {
      this.#serverClose(socket, 4002);
      return;
    }
    if (behaviour?.kind === "close") {
      this.#serverClose(socket, behaviour.code, behaviour.reason);
      return;
    }
    socket.token = token;
    this.#deliver(socket, this.#frame("session.authenticated", token.participantId, { role: token.role }));
  }

  #open(socket: FakeWebSocket, protocol: string): void {
    socket.readyState = FakeWebSocket.OPEN;
    socket.protocol = protocol;
    this.#invoke(() => socket.onopen?.({}));
  }

  #refuse(socket: FakeWebSocket): void {
    socket.readyState = FakeWebSocket.CLOSED;
    socket.closeCode = 1006;
    this.#invoke(() => socket.onerror?.({}));
    this.#invoke(() => socket.onclose?.({ code: 1006, reason: "" }));
  }

  receive(socket: FakeWebSocket, data: string): void {
    if (socket.readyState !== FakeWebSocket.OPEN && socket.readyState !== FakeWebSocket.CLOSING) return;
    const token = socket.token;
    const decoded = decodeSignalingFrame(data, { direction: "client_to_server" });
    if (!decoded.ok) {
      this.invalidClientFrames.push(data);
      this.#reject(socket, decoded.error.code);
      return;
    }
    const message = decoded.message;
    if (!token) return;
    if (message.meetingId !== token.meetingId || message.participantId !== token.participantId) {
      this.#reject(socket, "identity_mismatch");
      return;
    }
    switch (message.type) {
      case "participant.join":
        if (socket.joined) {
          this.#reject(socket, "already_joined");
          return;
        }
        socket.joined = true;
        if (this.holdWelcome) this.#heldJoins.push(socket);
        else this.#completeJoin(socket);
        return;
      case "participant.leave":
        if (this.ignoreLeave) return;
        if (socket.joined) this.#removeMember(socket, "left");
        this.#finish(socket, 1000, "left");
        return;
      case "media.camera.started":
      case "media.camera.stopped":
      case "media.microphone.started":
      case "media.microphone.stopped":
      case "media.screen.started":
      case "media.screen.stopped": {
        if (!socket.joined) {
          this.#reject(socket, "not_joined");
          return;
        }
        const rejection = this.#rejections.shift();
        if (rejection !== undefined) {
          this.#reject(socket, rejection);
          return;
        }
        if (!isRoleAllowed(message.type, token.role)) {
          this.#reject(socket, "role_not_allowed");
          return;
        }
        const [, kind, action] = message.type.split(".") as [string, MediaKind, string];
        const member = this.#members.get(token.participantId);
        if (member) member.media[kind] = action === "started";
        this.#broadcast(token.participantId, data);
        return;
      }
      default:
        return;
    }
  }

  #completeJoin(socket: FakeWebSocket): void {
    const token = socket.token;
    if (!token || socket.readyState !== FakeWebSocket.OPEN) return;
    const previous = this.#members.get(token.participantId);
    const replaced = previous?.socket !== undefined && previous.socket !== socket;
    if (replaced && previous?.socket) this.#finish(previous.socket, 4009, "session_replaced");

    for (const other of this.#members.values()) {
      if (other.participantId === token.participantId) continue;
      const payload: PayloadMap["participant.joined"] = { role: other.role };
      if (other.displayName !== undefined) payload.displayName = other.displayName;
      this.#deliver(socket, this.#frame("participant.joined", other.participantId, payload));
      for (const kind of ["camera", "microphone", "screen"] as const) {
        if (other.media[kind]) {
          this.#deliver(socket, this.#frame(`media.${kind}.started` as MessageType, other.participantId, {} as never));
        }
      }
    }

    const displayName = this.#displayNames.get(token.participantId);
    const member: Member = {
      participantId: token.participantId,
      role: token.role,
      media: { camera: false, microphone: false, screen: false },
      socket,
    };
    if (displayName !== undefined) member.displayName = displayName;
    this.#members.set(token.participantId, member);

    const welcome: PayloadMap["session.welcome"] = {
      role: token.role,
      joinedAt: new Date(this.now()).toISOString(),
    };
    if (displayName !== undefined) welcome.displayName = displayName;
    this.#deliver(socket, this.#frame("session.welcome", token.participantId, welcome));

    if (replaced) {
      this.#broadcast(token.participantId, this.#frame("participant.reconnected", token.participantId, {}));
    } else {
      const payload: PayloadMap["participant.joined"] = { role: token.role };
      if (displayName !== undefined) payload.displayName = displayName;
      this.#broadcast(token.participantId, this.#frame("participant.joined", token.participantId, payload));
    }
  }

  clientClosed(socket: FakeWebSocket, code: number, reason: string): void {
    if (socket.readyState === FakeWebSocket.CLOSED) return;
    if (socket.joined) this.#removeMember(socket, "disconnected");
    this.#finish(socket, code, reason);
  }

  #serverClose(socket: FakeWebSocket, code: number, reason?: string): void {
    if (socket.readyState === FakeWebSocket.CLOSED) return;
    if (socket.joined && code !== 4009) this.#removeMember(socket, "disconnected");
    this.#finish(socket, code, reason ?? CLOSE_REASONS[code] ?? "");
  }

  #finishAbnormally(socket: FakeWebSocket): void {
    if (socket.readyState === FakeWebSocket.CLOSED) return;
    if (socket.joined) this.#removeMember(socket, "disconnected");
    this.#finish(socket, 1006, "");
  }

  #finish(socket: FakeWebSocket, code: number, reason: string): void {
    if (socket.readyState === FakeWebSocket.CLOSED) return;
    socket.readyState = FakeWebSocket.CLOSED;
    socket.closeCode = code;
    this.#heldJoins.splice(0, this.#heldJoins.length, ...this.#heldJoins.filter((s) => s !== socket));
    this.#invoke(() => socket.onclose?.({ code, reason }));
  }

  #removeMember(socket: FakeWebSocket, reason: string): void {
    const participantId = socket.token?.participantId;
    socket.joined = false;
    if (!participantId) return;
    const member = this.#members.get(participantId);
    if (member?.socket !== socket) return;
    this.#members.delete(participantId);
    this.#broadcast(participantId, this.#frame("participant.left", participantId, { reason }));
  }

  #reject(socket: FakeWebSocket, code: string): void {
    this.#deliver(socket, this.#frame("session.rejected", this.#participantOf(socket), { code }));
  }

  #broadcast(fromParticipantId: string, frame: string): void {
    for (const socket of this.#joinedSockets()) {
      if (socket.token?.participantId === fromParticipantId) continue;
      this.#deliver(socket, frame);
    }
  }

  #joinedSockets(): FakeWebSocket[] {
    const sockets: FakeWebSocket[] = [];
    for (const member of this.#members.values()) {
      if (member.socket && member.socket.readyState === FakeWebSocket.OPEN) sockets.push(member.socket);
    }
    return sockets;
  }

  #deliver(socket: FakeWebSocket, frame: string): void {
    if (socket.readyState !== FakeWebSocket.OPEN) return;
    this.#invoke(() => socket.onmessage?.({ data: frame }));
  }

  #invoke(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.handlerErrors.push(error);
    }
  }

  #participantOf(socket: FakeWebSocket): string {
    return socket.token?.participantId ?? "01JQ0000000000000000000000";
  }

  #frame<T extends MessageType>(type: T, participantId: string, payload: PayloadMap[T]): string {
    return encodeSignalingMessage(
      createSignalingMessage(type, { meetingId: this.meetingId, participantId, payload }) as SignalingMessage,
    );
  }
}

/** Let queued fake-server work and promise continuations run. */
export async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
