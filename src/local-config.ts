import * as path from 'path';
import type { ScheduleEntry, StationConfig } from './config';

/**
 * Shape of the optional, gitignored `src/config.local.ts`.
 *
 * Anything machine- or network-specific (device IP, device name, cron time)
 * belongs there so the tracked `config.ts` can stay generic. See
 * `src/config.local.example.ts` for a starting point.
 */
export interface LocalConfig {
  /** Merged into the tracked stations by key — override a URL or add a station. */
  stations?: Record<string, StationConfig>;
  /** Replaces the tracked schedule entirely when present. */
  schedule?: ScheduleEntry[];
}

export interface ResolvedConfig {
  stations: Record<string, StationConfig>;
  schedule: ScheduleEntry[];
}

/**
 * Loads `<dir>/config.local` if it exists. A missing file is normal and yields
 * `{}`; any other failure (syntax error, bad import inside the file) is
 * rethrown so a broken override never silently falls back to the defaults.
 */
export function loadLocalConfig(dir: string, basename = 'config.local'): LocalConfig {
  const modulePath = path.join(dir, basename);

  // Resolve before loading: a MODULE_NOT_FOUND here can only mean the file
  // itself is absent. (Catching it around `require` instead would also
  // swallow a bad import *inside* the file — Node names the requiring file
  // in that message too.)
  let resolved: string;
  try {
    resolved = require.resolve(modulePath);
  } catch (err) {
    if (isModuleNotFound(err)) return {};
    throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(resolved) as LocalConfig;
}

function isModuleNotFound(err: unknown): boolean {
  // Duck-typed rather than `instanceof Error`: module loaders (Node's, and
  // Jest's sandbox) can throw errors from a different realm.
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'MODULE_NOT_FOUND';
}

export function mergeConfig(defaults: ResolvedConfig, local: LocalConfig): ResolvedConfig {
  return {
    stations: { ...defaults.stations, ...(local.stations ?? {}) },
    schedule: local.schedule ?? defaults.schedule,
  };
}
