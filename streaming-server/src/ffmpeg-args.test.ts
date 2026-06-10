import { buildAdtsArgs, buildHlsArgs, upstreamInputArgs, aacEncodeArgs } from './ffmpeg-args';

const URL = 'https://example.com/upstream';

describe('ffmpeg-args', () => {
  it('HLS and ADTS builds share identical input and encode flags', () => {
    const prefix = [...upstreamInputArgs(URL), ...aacEncodeArgs()];
    expect(buildHlsArgs(URL, { listSize: 15, startNumber: 0 }).slice(0, prefix.length)).toEqual(prefix);
    expect(buildAdtsArgs(URL).slice(0, prefix.length)).toEqual(prefix);
  });

  it('input args keep the hard-won upstream quirks', () => {
    const args = upstreamInputArgs(URL);
    // Shoutcast servers send HTML without a media-player user-agent.
    expect(args).toContain('WinampMPEG/5.0');
    // SGPC uses a self-signed cert.
    expect(args.join(' ')).toContain('-tls_verify 0');
    // Survive upstream drops.
    expect(args.join(' ')).toContain('-reconnect 1');
    expect(args[args.length - 1]).toBe(URL);
  });

  it('encodes to plain AAC (Cast rejects audio/aacp)', () => {
    expect(aacEncodeArgs().join(' ')).toBe('-c:a aac -b:a 128k -ac 2');
  });

  it('HLS build uses bare segment filenames and honors list size and start number', () => {
    const joined = buildHlsArgs(URL, { listSize: 15, startNumber: 42 }).join(' ');
    expect(joined).toContain('-hls_list_size 15');
    expect(joined).toContain('-start_number 42');
    expect(joined).toContain('-hls_segment_filename seg%05d.ts');
    expect(joined).toContain('delete_segments+omit_endlist');
    expect(joined.endsWith('stream.m3u8')).toBe(true);
  });

  it('ADTS build writes an adts stream to stdout', () => {
    const args = buildAdtsArgs(URL);
    expect(args.join(' ')).toContain('-f adts');
    expect(args[args.length - 1]).toBe('pipe:1');
  });
});
