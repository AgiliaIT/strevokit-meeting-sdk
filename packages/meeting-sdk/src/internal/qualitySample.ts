import { MAX_QUALITY_CODEC_LENGTH } from "@strevokit/signaling-protocol";
import type { PeerConnectionLike, StatsReportLike } from "./env.js";
import { type PathReport, pathReport, selectedCandidatePairReport, selectedPair } from "./selectedPair.js";

/** Default interval between quality samples while a peer link is alive. */
export const QUALITY_SAMPLE_INTERVAL_MS = 5_000;

/** Bounded media-health snapshot for one peer link. Never includes SDP, IPs, or raw stats dumps. */
export type QualitySample = {
  readonly connectionState: string;
  readonly sampledAt: string;
  readonly rttMs?: number;
  readonly jitterMs?: number;
  readonly packetLossRatio?: number;
  readonly sendBitrateBps?: number;
  readonly receiveBitrateBps?: number;
  readonly iceLocalCandidateType?: string;
  readonly iceRemoteCandidateType?: string;
  readonly path?: PathReport["path"];
  readonly localPath?: PathReport["localPath"];
  readonly remotePath?: PathReport["remotePath"];
  readonly framesDropped?: number;
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly codec?: string;
  readonly incomplete?: boolean;
};

/** Byte counters from the previous sample, used to derive bitrates. */
export type QualityByteSnapshot = {
  readonly sent: number;
  readonly received: number;
  readonly atMs: number;
};

export type QualitySampleResult = {
  readonly sample: QualitySample;
  readonly bytes: QualityByteSnapshot | null;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: number | undefined): number | undefined {
  return value !== undefined && value >= 0 ? value : undefined;
}

async function collectReports(pc: PeerConnectionLike): Promise<StatsReportLike[] | null> {
  try {
    const collection = await pc.getStats();
    const reports: StatsReportLike[] = [];
    collection.forEach((report) => reports.push(report));
    return reports;
  } catch {
    return null;
  }
}

function pickRttMs(reports: StatsReportLike[]): number | undefined {
  const pair = selectedCandidatePairReport(reports);
  if (pair) {
    const seconds = finiteNumber(pair.currentRoundTripTime);
    if (seconds !== undefined) return nonNegative(seconds * 1000);
  }
  for (const report of reports) {
    if (report.type === "remote-inbound-rtp") {
      const seconds = finiteNumber(report.roundTripTime);
      if (seconds !== undefined) return nonNegative(seconds * 1000);
    }
  }
  return undefined;
}

function pickJitterMs(reports: StatsReportLike[]): number | undefined {
  for (const report of reports) {
    if (report.type === "inbound-rtp") {
      const seconds = finiteNumber(report.jitter);
      if (seconds !== undefined) return nonNegative(seconds * 1000);
    }
  }
  return undefined;
}

function pickPacketLossRatio(reports: StatsReportLike[]): number | undefined {
  let lost = 0;
  let received = 0;
  let saw = false;
  for (const report of reports) {
    if (report.type !== "inbound-rtp") continue;
    const packetsLost = finiteNumber(report.packetsLost);
    const packetsReceived = finiteNumber(report.packetsReceived);
    if (packetsLost === undefined && packetsReceived === undefined) continue;
    saw = true;
    lost += Math.max(0, packetsLost ?? 0);
    received += Math.max(0, packetsReceived ?? 0);
  }
  if (!saw) return undefined;
  const total = lost + received;
  if (total <= 0) return 0;
  return Math.min(1, lost / total);
}

function sumBytes(reports: StatsReportLike[], type: "outbound-rtp" | "inbound-rtp", key: "bytesSent" | "bytesReceived"): number | undefined {
  let total = 0;
  let saw = false;
  for (const report of reports) {
    if (report.type !== type) continue;
    const value = finiteNumber(report[key]);
    if (value === undefined) continue;
    saw = true;
    total += Math.max(0, value);
  }
  return saw ? total : undefined;
}

function bitrateBps(current: number | undefined, previous: number | undefined, elapsedMs: number): number | undefined {
  if (current === undefined || previous === undefined || elapsedMs <= 0) return undefined;
  const delta = current - previous;
  if (delta < 0) return undefined;
  return (delta * 8 * 1000) / elapsedMs;
}

function pickFrames(reports: StatsReportLike[]): {
  framesDropped?: number;
  frameWidth?: number;
  frameHeight?: number;
} {
  let framesDropped: number | undefined;
  let frameWidth: number | undefined;
  let frameHeight: number | undefined;
  for (const report of reports) {
    if (report.type !== "inbound-rtp") continue;
    const dropped = finiteNumber(report.framesDropped);
    if (dropped !== undefined && dropped >= 0) framesDropped = (framesDropped ?? 0) + dropped;
    const width = finiteNumber(report.frameWidth);
    const height = finiteNumber(report.frameHeight);
    if (width !== undefined && width > 0) frameWidth = width;
    if (height !== undefined && height > 0) frameHeight = height;
  }
  return {
    ...(framesDropped !== undefined ? { framesDropped } : {}),
    ...(frameWidth !== undefined ? { frameWidth } : {}),
    ...(frameHeight !== undefined ? { frameHeight } : {}),
  };
}

/** Mirrors signaling-protocol optionalShortToken rules so invalid codecs are omitted, not sent. */
function isQualityCodecToken(value: string): boolean {
  if (value.length === 0 || value.length > MAX_QUALITY_CODEC_LENGTH) return false;
  if (value.includes("\r\n") || value.includes("\n")) return false;
  if (/^v=0/i.test(value) || /^candidate:/i.test(value) || /\bIN IP[46]\b/i.test(value)) return false;
  return /^[a-zA-Z0-9._+/-]+$/.test(value);
}

function pickCodec(reports: StatsReportLike[]): string | undefined {
  const byId = new Map(reports.map((report) => [report.id, report]));
  for (const report of reports) {
    if (report.type !== "inbound-rtp" && report.type !== "outbound-rtp") continue;
    const codecId = report.codecId;
    if (!codecId) continue;
    const mime = byId.get(codecId)?.mimeType;
    if (typeof mime === "string" && isQualityCodecToken(mime)) return mime;
  }
  for (const report of reports) {
    if (report.type === "codec" && typeof report.mimeType === "string" && isQualityCodecToken(report.mimeType)) {
      return report.mimeType;
    }
  }
  return undefined;
}

/**
 * Builds one quality sample from `getStats`. Never throws: missing or failing stats yield an incomplete sample.
 */
export async function buildQualitySample(
  pc: PeerConnectionLike,
  options: {
    connectionState: string;
    nowMs: number;
    previous?: QualityByteSnapshot | null;
  },
): Promise<QualitySampleResult> {
  const sampledAt = new Date(options.nowMs).toISOString();
  const base: QualitySample = {
    connectionState: options.connectionState,
    sampledAt,
  };

  const reports = await collectReports(pc);
  if (!reports) {
    return { sample: { ...base, incomplete: true }, bytes: options.previous ?? null };
  }

  const rttMs = pickRttMs(reports);
  const jitterMs = pickJitterMs(reports);
  const packetLossRatio = pickPacketLossRatio(reports);
  const bytesSent = sumBytes(reports, "outbound-rtp", "bytesSent");
  const bytesReceived = sumBytes(reports, "inbound-rtp", "bytesReceived");
  const elapsedMs = options.previous ? Math.max(0, options.nowMs - options.previous.atMs) : 0;
  const sendBitrateBps = bitrateBps(bytesSent, options.previous?.sent, elapsedMs);
  const receiveBitrateBps = bitrateBps(bytesReceived, options.previous?.received, elapsedMs);
  const frames = pickFrames(reports);
  const codec = pickCodec(reports);

  let iceLocalCandidateType: string | undefined;
  let iceRemoteCandidateType: string | undefined;
  let pathFields: Partial<PathReport> = {};
  try {
    const pair = await selectedPair(pc);
    if (pair) {
      iceLocalCandidateType = pair.localType;
      iceRemoteCandidateType = pair.remoteType;
      pathFields = pathReport(pair);
    }
  } catch {
    // Path helpers must not fail the sample.
  }

  const hasCore =
    rttMs !== undefined &&
    jitterMs !== undefined &&
    packetLossRatio !== undefined &&
    sendBitrateBps !== undefined &&
    receiveBitrateBps !== undefined &&
    iceLocalCandidateType !== undefined;

  const sample: QualitySample = {
    ...base,
    ...(rttMs !== undefined ? { rttMs } : {}),
    ...(jitterMs !== undefined ? { jitterMs } : {}),
    ...(packetLossRatio !== undefined ? { packetLossRatio } : {}),
    ...(sendBitrateBps !== undefined ? { sendBitrateBps } : {}),
    ...(receiveBitrateBps !== undefined ? { receiveBitrateBps } : {}),
    ...(iceLocalCandidateType ? { iceLocalCandidateType } : {}),
    ...(iceRemoteCandidateType ? { iceRemoteCandidateType } : {}),
    ...pathFields,
    ...frames,
    ...(codec ? { codec } : {}),
    ...(!hasCore ? { incomplete: true } : {}),
  };

  const bytes: QualityByteSnapshot | null =
    bytesSent !== undefined || bytesReceived !== undefined
      ? {
          sent: bytesSent ?? options.previous?.sent ?? 0,
          received: bytesReceived ?? options.previous?.received ?? 0,
          atMs: options.nowMs,
        }
      : (options.previous ?? null);

  return { sample, bytes };
}
