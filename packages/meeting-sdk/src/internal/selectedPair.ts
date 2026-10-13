import type { PeerConnectionLike, StatsReportLike } from "./env.js";

export type SelectedPair = { readonly localId: string; readonly localType: string; readonly remoteType: string };

/**
 * The candidate pair the browser is sending media over, from its stats: the transport's selected pair first, then
 * the succeeded and nominated pair for browsers without that field. Null when stats are unavailable or incomplete.
 */
export async function selectedPair(pc: PeerConnectionLike): Promise<SelectedPair | null> {
  const reports = await statsOf(pc);
  if (!reports) return null;
  const byId = new Map(reports.map((report) => [report.id, report]));
  const selectedId = reports.find((r) => r.type === "transport" && r.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair =
    (selectedId ? byId.get(selectedId) : undefined) ??
    reports.find((r) => r.type === "candidate-pair" && r.state === "succeeded" && r.nominated === true);
  if (!pair?.localCandidateId || !pair.remoteCandidateId) return null;
  const localType = byId.get(pair.localCandidateId)?.candidateType;
  const remoteType = byId.get(pair.remoteCandidateId)?.candidateType;
  if (!localType || !remoteType) return null;
  return { localId: pair.localCandidateId, localType, remoteType };
}

/** IDs of every local candidate the browser has reported so far. Null when stats are unavailable. */
export async function localCandidateIds(pc: PeerConnectionLike): Promise<Set<string> | null> {
  const reports = await statsOf(pc);
  if (!reports) return null;
  return new Set(reports.filter((r) => r.type === "local-candidate").map((r) => r.id));
}

async function statsOf(pc: PeerConnectionLike): Promise<StatsReportLike[] | null> {
  try {
    const collection = await pc.getStats();
    const reports: StatsReportLike[] = [];
    collection.forEach((report) => reports.push(report));
    return reports;
  } catch {
    return null;
  }
}

export type PathKind = "direct" | "relayed";

/**
 * How media is carried: `localPath` for this side of the selected pair, `remotePath` for the other side, and `path`
 * relayed when either side is. `remotePath` is this browser's view of the other side and may miss a remote relay.
 */
export type PathReport = { readonly path: PathKind; readonly localPath: PathKind; readonly remotePath: PathKind };

export function pathReport(pair: SelectedPair): PathReport {
  const localPath = kindOf(pair.localType);
  const remotePath = kindOf(pair.remoteType);
  return { path: localPath === "relayed" || remotePath === "relayed" ? "relayed" : "direct", localPath, remotePath };
}

export function samePath(a: PathReport, b: PathReport): boolean {
  return a.path === b.path && a.localPath === b.localPath && a.remotePath === b.remotePath;
}

function kindOf(candidateType: string): PathKind {
  return candidateType === "relay" ? "relayed" : "direct";
}
