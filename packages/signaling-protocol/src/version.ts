/** Protocol version stamped on every outbound message. */
export const PROTOCOL_VERSION = 1 as const;

/** Protocol versions a receiver accepts. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1] as const);

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Strict check: a JSON number that is an integer in SUPPORTED_PROTOCOL_VERSIONS (no coercion). */
export function isSupportedVersion(value: unknown): value is ProtocolVersion {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(value)
  );
}
