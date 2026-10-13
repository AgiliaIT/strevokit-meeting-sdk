import type { IceServerConfig } from "@strevokit/signaling-protocol";
import type { FakePeerConnection } from "./fakePeerConnection.js";
import type { EngineHarness } from "./harness.js";

/** A server list with credential-shaped values for `expiresAtMs`, assembled at runtime. `tag` tells lists apart. */
export function relayServers(expiresAtMs: number, tag = "a"): IceServerConfig[] {
  return [
    { urls: ["stun:turn.example.com:3478"] },
    {
      urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
      username: `${Math.floor(expiresAtMs / 1000)}:${tag.repeat(24)}`,
      credential: ["sample", tag, "value"].join("-"),
    },
  ];
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Sends fresh servers expiring at `expiresAtMs` to each participant. */
export function pushRefresh(h: EngineHarness, participantIds: readonly string[], expiresAtMs: number, tag = "b"): IceServerConfig[] {
  const servers = relayServers(expiresAtMs, tag);
  for (const id of participantIds) h.realtime.pushIceServers(id, servers, iso(expiresAtMs));
  return servers;
}

/** Makes `pc` report its current selected pair with the given local and remote candidate types. */
export function setPathTypes(pc: FakePeerConnection, localType: string, remoteType: string): void {
  const pair = pc.selectedPair;
  if (!pair) throw new Error("not connected");
  pc.setSelectedPair({ ...pair, localType, remoteType });
}

/** The open connections of the offerer (`low`) and the answerer (`high`), by creation order. */
export function connectionsOf(h: EngineHarness): { lowPc: FakePeerConnection; highPc: FakePeerConnection } {
  const [lowPc, highPc] = h.network.open();
  if (!lowPc || !highPc) throw new Error("no connected pair");
  return { lowPc, highPc };
}
