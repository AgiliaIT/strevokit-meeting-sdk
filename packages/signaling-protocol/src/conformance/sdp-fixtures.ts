/**
 * Synthetic SDP fixtures shaped after real Chrome and Firefox output (Unified Plan, BUNDLE,
 * full codec lists with RTX/RED/FEC, header extensions, simulcast, embedded candidates).
 * Used to prove realistic worst-case offers fit well under MAX_SDP_BYTES / MAX_MESSAGE_BYTES.
 */

const CRLF = "\r\n";

function lines(...parts: string[]): string {
  return parts.map((line) => line + CRLF).join("");
}

function session(originId: string, mids: string[], browser: "chrome" | "firefox"): string {
  return lines(
    "v=0",
    browser === "chrome"
      ? `o=- ${originId} 2 IN IP4 127.0.0.1`
      : `o=mozilla...THIS_IS_SDPARTA-99.0 ${originId} 0 IN IP4 0.0.0.0`,
    "s=-",
    "t=0 0",
    ...(browser === "firefox"
      ? ["a=fingerprint:sha-256 8C:71:B3:8D:A5:38:FD:8F:A4:2E:A2:65:6C:86:52:BC:E0:6E:94:F2:9F:7C:4D:B5:DF:AF:AA:6F:44:90:8D:F4"]
      : []),
    `a=group:BUNDLE ${mids.join(" ")}`,
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS stream0",
  );
}

function transport(mid: string, ufrag: string): string[] {
  return [
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    `a=ice-ufrag:${ufrag}`,
    "a=ice-pwd:asd88fgpdd777uzjYhagZg2vlDYYVbDb",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
    "a=setup:actpass",
    `a=mid:${mid}`,
  ];
}

function audioSection(mid: string, ufrag: string, trackId: string, ssrc: number): string {
  return lines(
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
    ...transport(mid, ufrag),
    "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
    "a=sendrecv",
    `a=msid:stream0 ${trackId}`,
    "a=rtcp-mux",
    "a=rtcp-rsize",
    "a=rtpmap:111 opus/48000/2",
    "a=rtcp-fb:111 transport-cc",
    "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "a=rtpmap:9 G722/8000",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:13 CN/8000",
    "a=rtpmap:110 telephone-event/48000",
    "a=rtpmap:126 telephone-event/8000",
    `a=ssrc:${ssrc} cname:W3dSGm7YYl5wSiZt`,
    `a=ssrc:${ssrc} msid:stream0 ${trackId}`,
  );
}

const VIDEO_CODECS: Array<[number, string, string | null, number]> = [
  [96, "VP8/90000", null, 97],
  [98, "VP9/90000", "profile-id=0", 99],
  [100, "VP9/90000", "profile-id=2", 101],
  [102, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", 103],
  [104, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f", 105],
  [106, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", 107],
  [108, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f", 109],
  [112, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f", 113],
  [114, "H264/90000", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f", 115],
  [35, "AV1/90000", "level-idx=5;profile=0;tier=0", 36],
];

function videoSection(
  mid: string,
  ufrag: string,
  trackId: string,
  baseSsrc: number,
  simulcast: boolean,
): string {
  const payloadTypes = VIDEO_CODECS.flatMap(([pt, , , rtx]) => [pt, rtx]).concat([116, 117, 118]);
  const codecLines = VIDEO_CODECS.flatMap(([pt, codec, fmtp, rtx]) => [
    `a=rtpmap:${pt} ${codec}`,
    `a=rtcp-fb:${pt} goog-remb`,
    `a=rtcp-fb:${pt} transport-cc`,
    `a=rtcp-fb:${pt} ccm fir`,
    `a=rtcp-fb:${pt} nack`,
    `a=rtcp-fb:${pt} nack pli`,
    ...(fmtp ? [`a=fmtp:${pt} ${fmtp}`] : []),
    `a=rtpmap:${rtx} rtx/90000`,
    `a=fmtp:${rtx} apt=${pt}`,
  ]);
  const simulcastLines = simulcast
    ? [
        "a=rid:q send",
        "a=rid:h send",
        "a=rid:f send",
        "a=simulcast:send q;h;f",
      ]
    : [
        `a=ssrc-group:FID ${baseSsrc} ${baseSsrc + 1}`,
        `a=ssrc:${baseSsrc} cname:W3dSGm7YYl5wSiZt`,
        `a=ssrc:${baseSsrc} msid:stream0 ${trackId}`,
        `a=ssrc:${baseSsrc + 1} cname:W3dSGm7YYl5wSiZt`,
        `a=ssrc:${baseSsrc + 1} msid:stream0 ${trackId}`,
      ];
  return lines(
    `m=video 9 UDP/TLS/RTP/SAVPF ${payloadTypes.join(" ")}`,
    ...transport(mid, ufrag),
    "a=extmap:14 urn:ietf:params:rtp-hdrext:toffset",
    "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    "a=extmap:13 urn:3gpp:video-orientation",
    "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    "a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
    "a=extmap:6 http://www.webrtc.org/experiments/rtp-hdrext/video-content-type",
    "a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/video-timing",
    "a=extmap:8 http://www.webrtc.org/experiments/rtp-hdrext/color-space",
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
    "a=extmap:10 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
    "a=extmap:11 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
    "a=sendrecv",
    `a=msid:stream0 ${trackId}`,
    "a=rtcp-mux",
    "a=rtcp-rsize",
    ...codecLines,
    "a=rtpmap:116 red/90000",
    "a=rtpmap:117 rtx/90000",
    "a=fmtp:117 apt=116",
    "a=rtpmap:118 ulpfec/90000",
    ...simulcastLines,
  );
}

function candidates(count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const component = (i % 2) + 1;
    const port = 50000 + i * 7;
    switch (i % 4) {
      case 0:
        out.push(`a=candidate:${1467250027 + i} ${component} udp 2122260223 192.168.1.${10 + (i % 200)} ${port} typ host generation 0 network-id 1 network-cost 10`);
        break;
      case 1:
        out.push(`a=candidate:${2190034266 + i} ${component} udp 2122262783 2001:db8:85a3::8a2e:370:${(7334 + i).toString(16)} ${port} typ host generation 0 network-id 2 network-cost 10`);
        break;
      case 2:
        out.push(`a=candidate:${842163049 + i} ${component} udp 1686052607 203.0.113.${7 + (i % 200)} ${port} typ srflx raddr 192.168.1.10 rport ${port} generation 0 network-id 1 network-cost 10`);
        break;
      default:
        out.push(`a=candidate:${3528925834 + i} ${component} udp 41885439 198.51.100.${20 + (i % 200)} ${port} typ relay raddr 203.0.113.7 rport ${port} generation 0 network-id 1 network-cost 10`);
    }
  }
  out.push("a=end-of-candidates");
  return lines(...out);
}

const chromeAudioVideoScreenSimulcast =
  session("4611731400430051336", ["0", "1", "2", "3"], "chrome") +
  audioSection("0", "EsEl", "a1b2c3d4-audio", 1001) +
  videoSection("1", "EsEl", "a1b2c3d4-camera", 2001, true) +
  videoSection("2", "EsEl", "a1b2c3d4-screen", 3001, false) +
  audioSection("3", "EsEl", "a1b2c3d4-screen-audio", 4001);

const firefoxAudioVideoScreen =
  session("7895132546121894658", ["0", "1", "2"], "firefox") +
  audioSection("0", "9c1f63d0", "{f3a5c7d9-audio}", 5001) +
  videoSection("1", "9c1f63d0", "{f3a5c7d9-camera}", 6001, false) +
  videoSection("2", "9c1f63d0", "{f3a5c7d9-screen}", 7001, false);

const chromeWithEmbeddedCandidates =
  session("1928374655647382910", ["0", "1", "2"], "chrome") +
  audioSection("0", "Qx7p", "e5f6-audio", 8001) +
  candidates(24) +
  videoSection("1", "Qx7p", "e5f6-camera", 9001, true) +
  candidates(24) +
  videoSection("2", "Qx7p", "e5f6-screen", 10001, false);

const worstCaseP2P =
  session("5647382910192837465", ["0", "1", "2", "3"], "chrome") +
  audioSection("0", "Wc9z", "w0-audio", 11001) +
  candidates(24) +
  videoSection("1", "Wc9z", "w0-camera", 12001, true) +
  candidates(24) +
  videoSection("2", "Wc9z", "w0-screen", 13001, false) +
  candidates(24) +
  audioSection("3", "Wc9z", "w0-screen-audio", 14001) +
  candidates(24);

/** Large realistic SDPs, keyed by scenario. `worstCaseP2P` is the upper bound for P2P offers. */
export const SDP_FIXTURES: Readonly<Record<string, string>> = Object.freeze({
  chromeAudioVideoScreenSimulcast,
  firefoxAudioVideoScreen,
  chromeWithEmbeddedCandidates,
  worstCaseP2P,
});
