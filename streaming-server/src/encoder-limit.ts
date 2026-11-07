/**
 * Most HLS encodes allowed at once (see EncoderSlots). Golden Temple always
 * gets one, so newer stations can't lock it out. On Fly's shared vCPU, 4
 * encodes ran every pipeline below real time (pipelineRatio 0.70-0.88 on
 * 2026-10-18), which listeners hear as choppy audio, hence the default of 3.
 * Hosts with more CPU raise it with the MAX_ENCODERS environment variable.
 */
export const DEFAULT_MAX_ENCODERS = 3;

export function maxEncodersFromEnv(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_ENCODERS;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`MAX_ENCODERS must be a positive integer, got "${raw}"`);
  }
  return Number(value);
}
