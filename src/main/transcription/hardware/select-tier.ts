import type { DictationHardwareProfile, DictationEngineTier } from '../../../shared/types';

/**
 * Map a hardware profile to a coarse engine tier. The single heuristic;
 * `engine-selection.ts#selectEngine` consumes it (with the user's override).
 * Reliable signals only - cores, RAM, and a known GPU backend. AVX2 is NOT a
 * gate (it is undetectable on Windows/macOS and whisper.cpp works without it).
 *
 * Its own file, apart from `detect-hardware.ts`, because it is pure and that
 * module is not: detection imports `electron`, `os`, and `child_process`. Kept
 * separate, `selectEngine` imports nothing but pure modules, so the web demo's
 * sample install can resolve the settings panel's models with main's own code.
 */
export function selectTier(profile: DictationHardwareProfile): DictationEngineTier {
  // A supported GPU backend -> the accurate, punctuated path.
  if (profile.gpu === 'cuda' || profile.gpu === 'metal') return 'accurate-base';
  // Genuinely weak: very few cores or very low RAM -> streaming transducer.
  if (profile.cpuCores <= 2 || profile.totalRamGb < 4) return 'streaming-tiny';
  // Any reasonable multi-core machine with adequate RAM -> accurate path.
  if (profile.cpuCores >= 4) return 'accurate-base';
  return 'streaming-tiny';
}
