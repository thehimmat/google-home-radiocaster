// Shared FFmpeg argument builders.
//
// The HLS pipeline (server.ts) and the raw ADTS stream endpoint (app.ts) must
// use identical upstream-input and AAC-encode flags — these helpers are the
// single source of truth for them. If a station needs a new input quirk
// (user-agent, TLS, reconnect tuning), change it here and both paths get it.

/** Segment length in seconds for the HLS pipeline. */
export const HLS_SEGMENT_SECONDS = 4;

/**
 * Input-side flags: keep the upstream connection alive through drops, present
 * a media-player user-agent (some Shoutcast servers send an HTML page
 * otherwise), and skip TLS verification (SGPC's live.sgpc.net:8443 uses a
 * self-signed cert).
 */
export function upstreamInputArgs(upstreamUrl: string): string[] {
  return [
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',
    '-user_agent', 'WinampMPEG/5.0',
    '-tls_verify', '0',
    '-i', upstreamUrl,
  ];
}

/**
 * Re-encode to stereo 128k AAC. The Cast Default Media Receiver rejects
 * audio/aacp, so upstream audio is always normalized to plain AAC.
 */
export function aacEncodeArgs(): string[] {
  return ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
}

/**
 * Full argument list for the HLS pipeline. Output filenames are bare (relative)
 * on purpose — the caller must spawn FFmpeg with cwd set to the station's HLS
 * directory so the M3U8 references segments as plain "seg00000.ts".
 */
export function buildHlsArgs(
  upstreamUrl: string,
  opts: { listSize: number; startNumber: number; segmentSeconds?: number },
): string[] {
  return [
    ...upstreamInputArgs(upstreamUrl),
    ...aacEncodeArgs(),
    '-f', 'hls',
    '-hls_time', String(opts.segmentSeconds ?? HLS_SEGMENT_SECONDS),
    '-hls_list_size', String(opts.listSize),
    '-hls_flags', 'delete_segments+omit_endlist',
    '-start_number', String(opts.startNumber),
    '-hls_segment_filename', 'seg%05d.ts',
    'stream.m3u8',
  ];
}

/**
 * Full argument list for the raw audio/aac HTTP endpoint: an ADTS-framed AAC
 * byte stream on stdout (ADTS is the correct framing for a bare audio/aac
 * response, and is self-synchronizing for clients that join mid-stream).
 */
export function buildAdtsArgs(upstreamUrl: string): string[] {
  return [
    ...upstreamInputArgs(upstreamUrl),
    ...aacEncodeArgs(),
    '-f', 'adts',
    'pipe:1',
  ];
}
