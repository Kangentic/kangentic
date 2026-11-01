import type { HostMemorySample } from '../../../src/shared/types';

export const GIBIBYTE = 1024 * 1024 * 1024;

/**
 * A Windows memory sample with this much commit left of a 64 GB limit. On that
 * limit the low-memory pause reads pressure below 2 GB and recovery past 4 GB
 * (`memoryHeadroom`, `evaluateMemoryRelief`).
 */
export function windowsSample(remainingBytes: number, ts: string = new Date().toISOString()): HostMemorySample {
  return {
    ts,
    platform: 'win32',
    commitLimitBytes: 64 * GIBIBYTE,
    commitRemainingBytes: remainingBytes,
    physicalTotalBytes: 32 * GIBIBYTE,
    physicalFreeBytes: 4 * GIBIBYTE,
    physicalAvailableBytes: null,
  };
}
