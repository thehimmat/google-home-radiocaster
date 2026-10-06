import * as fs from 'fs';
import * as path from 'path';

/**
 * Reclaims space on the HLS volume. FFmpeg's delete_segments only deletes
 * segments it listed in the current playlist, so every restart (crash loops on
 * a dead source, watchdog kills) strands the previous run's segments forever.
 * On 2026-10-06 that filled the 1 GB volume and the server crashed on boot.
 *
 * For each configured station, deletes .ts files the playlist doesn't
 * reference; removes directories of stations no longer configured. Files at
 * the root (status history, lost+found) are left alone. Returns the number of
 * segment files deleted.
 */
export function cleanupHlsRoot(hlsRoot: string, stations: string[]): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(hlsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const configured = new Set(stations);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'lost+found') continue;
    const dir = path.join(hlsRoot, entry.name);

    if (!configured.has(entry.name)) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }

    let live: Set<string>;
    try {
      const playlist = fs.readFileSync(path.join(dir, 'stream.m3u8'), 'utf8');
      live = new Set(playlist.split(/\r?\n/).filter((l) => l.endsWith('.ts')));
    } catch {
      live = new Set();
    }
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.ts') && !live.has(file)) {
        fs.rmSync(path.join(dir, file), { force: true });
        removed++;
      }
    }
  }
  return removed;
}
