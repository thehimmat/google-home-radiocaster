import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Archives finalized HLS segments to Cloudflare R2 for the future time-shift
// feature. Key schema (locked decision): {station}/{utc_iso8601}.ts with the
// timestamp taken at upload, not the FFmpeg sequence number. Cleanup is an R2
// lifecycle rule (24h TTL), not code here.
//
// Wholly fault-isolated from the streaming path: any error is logged and the
// segment is retried on the next scan. Segments rotate out of the playlist
// after ~90s, so retries are naturally bounded.

export interface ArchiverEnv {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Returns null unless all R2_* vars are present — archiving is opt-in. */
export function archiverEnvFromProcess(env: NodeJS.ProcessEnv = process.env): ArchiverEnv | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  };
}

export interface SegmentUploader {
  upload(key: string, body: Buffer): Promise<void>;
}

export function createR2Uploader(env: ArchiverEnv): SegmentUploader {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
  return {
    async upload(key, body) {
      await client.send(new PutObjectCommand({
        Bucket: env.bucket,
        Key: key,
        Body: body,
        ContentType: 'video/MP2T',
      }));
    },
  };
}

/** Segment filenames referenced by an HLS playlist, in order. */
function segmentsInPlaylist(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^seg\d+\.ts$/.test(line));
}

export interface ArchiverOpts {
  pollMs?: number;
  now?: () => Date;
}

/**
 * Polls a station's playlist and uploads every newly-referenced segment.
 * A segment appearing in the playlist is the signal that FFmpeg finalized it
 * (the playlist is rewritten only after the segment file is complete).
 *
 * Known cold-start quirk: on server restart the uploaded-set is empty, so the
 * current playlist window (≤15 segments) is re-uploaded under fresh
 * timestamps. The 24h lifecycle rule absorbs the duplicates.
 */
export class StationArchiver {
  private readonly opts: Required<ArchiverOpts>;
  private uploaded = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private lastMtimeMs = 0;

  constructor(
    private readonly station: string,
    private readonly stationHlsDir: string,
    private readonly uploader: SegmentUploader,
    opts: ArchiverOpts = {},
  ) {
    this.opts = { pollMs: opts.pollMs ?? 2_000, now: opts.now ?? (() => new Date()) };
  }

  start(): void {
    this.timer = setInterval(() => void this.scanOnce(), this.opts.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle — public so tests can drive it without timers. */
  async scanOnce(): Promise<void> {
    if (this.scanning) return; // a slow upload batch must not overlap the next poll
    this.scanning = true;
    try {
      const playlistFile = path.join(this.stationHlsDir, 'stream.m3u8');
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(playlistFile).mtimeMs;
      } catch {
        return; // playlist not created yet — FFmpeg still starting
      }
      if (mtimeMs === this.lastMtimeMs) return;
      this.lastMtimeMs = mtimeMs;

      const segments = segmentsInPlaylist(fs.readFileSync(playlistFile, 'utf8'));

      for (const segment of segments) {
        if (this.uploaded.has(segment)) continue;
        try {
          const body = fs.readFileSync(path.join(this.stationHlsDir, segment));
          const key = `${this.station}/${this.opts.now().toISOString()}.ts`;
          await this.uploader.upload(key, body);
          this.uploaded.add(segment);
        } catch (err) {
          // Leave it out of the uploaded-set: the next scan retries it until
          // the segment rotates out of the playlist.
          console.warn(`[archiver:${this.station}] upload failed for ${segment}: ${(err as Error).message}`);
          this.lastMtimeMs = 0; // force a re-scan even if the playlist hasn't changed
        }
      }

      // Names never repeat (sequence numbers only grow), so dropping entries
      // that left the playlist keeps the set bounded without re-upload risk.
      this.uploaded = new Set(segments.filter((s) => this.uploaded.has(s)));
    } finally {
      this.scanning = false;
    }
  }
}
