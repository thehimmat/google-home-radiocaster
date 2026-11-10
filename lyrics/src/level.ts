/** Floor for digital silence, so levels stay finite JSON numbers. */
export const SILENT_DB = -120;

/** RMS level of a chunk of float samples (full scale = 1), in dB. */
export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return SILENT_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const power = sum / samples.length;
  return power > 0 ? Math.max(SILENT_DB, 10 * Math.log10(power)) : SILENT_DB;
}
