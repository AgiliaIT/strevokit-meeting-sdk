export type MessageFamily = "participant" | "webrtc" | "media" | "meeting" | "session";
export type MessageDirection = "client_to_server" | "server_to_client" | "both";
export type ReceiveDirection = "client_to_server" | "server_to_client";

type CatalogEntry = { readonly family: MessageFamily; readonly direction: MessageDirection };

const CATALOG = {
  "participant.join": { family: "participant", direction: "client_to_server" },
  "participant.joined": { family: "participant", direction: "server_to_client" },
  "participant.leave": { family: "participant", direction: "client_to_server" },
  "participant.left": { family: "participant", direction: "server_to_client" },
  "participant.reconnected": { family: "participant", direction: "server_to_client" },
  "webrtc.offer": { family: "webrtc", direction: "both" },
  "webrtc.answer": { family: "webrtc", direction: "both" },
  "webrtc.ice_candidate": { family: "webrtc", direction: "both" },
  "webrtc.connected": { family: "webrtc", direction: "client_to_server" },
  "webrtc.disconnected": { family: "webrtc", direction: "client_to_server" },
  "webrtc.failed": { family: "webrtc", direction: "client_to_server" },
  "media.camera.started": { family: "media", direction: "both" },
  "media.camera.stopped": { family: "media", direction: "both" },
  "media.microphone.started": { family: "media", direction: "both" },
  "media.microphone.stopped": { family: "media", direction: "both" },
  "media.screen.started": { family: "media", direction: "both" },
  "media.screen.stopped": { family: "media", direction: "both" },
  "meeting.started": { family: "meeting", direction: "server_to_client" },
  "meeting.ended": { family: "meeting", direction: "server_to_client" },
  "meeting.terminated": { family: "meeting", direction: "server_to_client" },
  "session.authenticated": { family: "session", direction: "server_to_client" },
  "session.welcome": { family: "session", direction: "server_to_client" },
  "session.rejected": { family: "session", direction: "server_to_client" },
} as const satisfies Record<string, CatalogEntry>;

/** Protocol v1 message types. */
export type MessageType = keyof typeof CATALOG;

for (const entry of Object.values(CATALOG)) Object.freeze(entry);

/** Family and allowed direction for every v1 message type. */
export const MESSAGE_CATALOG: Readonly<Record<MessageType, CatalogEntry>> =
  Object.freeze(CATALOG);

/** All v1 message types, in catalog order. */
export const MESSAGE_TYPES: readonly MessageType[] = Object.freeze(
  Object.keys(CATALOG) as MessageType[],
);

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && Object.hasOwn(CATALOG, value);
}

export function isDirectionAllowed(type: MessageType, direction: ReceiveDirection): boolean {
  const allowed = MESSAGE_CATALOG[type].direction;
  return allowed === "both" || allowed === direction;
}
