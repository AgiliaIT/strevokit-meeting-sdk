/** Compile-time only: the browser's own `RTCPeerConnection` provides the stats, configuration and restart methods. */
import type { PeerConnectionLike } from "../../src/internal/env.js";

type RestartAndStats = Pick<PeerConnectionLike, "createOffer" | "getStats" | "getConfiguration" | "setConfiguration">;

export function nativeProvidesRestartAndStats(pc: RTCPeerConnection): RestartAndStats {
  return pc;
}
