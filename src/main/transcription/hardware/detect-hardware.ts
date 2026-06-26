import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import type { DictationHardwareProfile, DictationEngineTier } from '../../../shared/types';

const execFileAsync = promisify(execFile);

/**
 * Best-effort hardware detection used to auto-pick a transcription engine and
 * model size, and to show the user what was detected. Everything degrades
 * gracefully: an unknown value pushes tier selection toward the conservative
 * (low-resource) option rather than assuming capability we cannot confirm. CPU
 * and RAM are read synchronously; the GPU is probed once via Electron's GPU
 * info and memoized for the app lifetime.
 */
export async function detectHardware(): Promise<DictationHardwareProfile> {
  const cpuCores = os.cpus()?.length ?? 1;
  const totalRamGb = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
  const gpu = await detectGpu();
  return {
    cpuModel: detectCpuModel(),
    cpuCores,
    totalRamGb,
    hasAvx2: detectAvx2(),
    gpu: gpu.kind,
    gpuDescription: gpu.description,
    platform: process.platform,
    arch: process.arch,
  };
}

/** The CPU brand string (e.g. "AMD Ryzen 9 9950X3D 16-Core Processor"), with
 *  the (R)/(TM) marks stripped. `os.cpus().length` is the logical (thread)
 *  count, which the brand string usually distinguishes from physical cores. */
function detectCpuModel(): string {
  const model = os.cpus()?.[0]?.model ?? '';
  const cleaned = model.replace(/\((?:R|TM|tm|r)\)/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Unknown CPU';
}

/**
 * AVX2 presence. Reliably readable only on Linux via `/proc/cpuinfo`; on
 * Windows and macOS Node exposes no CPU feature flags, so we report false. This
 * is informational only: tier selection does NOT gate on it (whisper.cpp
 * runtime-dispatches SIMD, so a missing-AVX2 reading must never downgrade an
 * otherwise-capable machine).
 */
function detectAvx2(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /\bavx2\b/.test(fs.readFileSync('/proc/cpuinfo', 'utf8'));
  } catch {
    return false;
  }
}

interface GpuClass {
  /** Acceleration backend our engines can use: cuda/metal, else `none` (CPU),
   *  or `unknown` when detection failed. A present-but-unaccelerated adapter
   *  (AMD/Intel in v1) is `none` with a populated `description`. */
  kind: DictationHardwareProfile['gpu'];
  /** Human-readable adapter vendor for display (independent of `kind`). */
  description?: string;
}

interface GpuDeviceInfo {
  vendorId?: number;
}

let cachedGpu: GpuClass | null = null;

/**
 * Detect the GPU: the acceleration KIND from `app.getGPUInfo` vendor ids
 * (NVIDIA -> CUDA, macOS -> Metal), and a human-readable NAME from the most
 * accurate source per platform - WMI `Win32_VideoController` on Windows (vendor
 * ids cannot name a card, and a dual-GPU machine confuses the GL renderer), the
 * GL renderer string elsewhere. Memoized for the app lifetime.
 */
async function detectGpu(): Promise<GpuClass> {
  if (cachedGpu) return cachedGpu;
  const kind = await detectGpuKind();
  let description = await detectGpuName(kind);
  if (description && kind === 'cuda' && !/cuda/i.test(description)) {
    description = `${description} (CUDA)`;
  }
  if (!description) {
    description = kind === 'cuda' ? 'NVIDIA (CUDA)' : kind === 'metal' ? 'Apple (Metal)' : undefined;
  }
  cachedGpu = { kind, description };
  return cachedGpu;
}

async function detectGpuKind(): Promise<DictationHardwareProfile['gpu']> {
  if (process.platform === 'darwin') return 'metal';
  try {
    const vendors = collectVendorIds(await app.getGPUInfo('basic'));
    if (vendors.has(0x10de)) return 'cuda';
    if ([0x1002, 0x8086, 0x1414].some((id) => vendors.has(id))) return 'none';
  } catch {
    // fall through to unknown
  }
  return 'unknown';
}

async function detectGpuName(kind: DictationHardwareProfile['gpu']): Promise<string | undefined> {
  if (process.platform === 'win32') return windowsGpuName(kind);
  return glRendererName();
}

/** All adapter names from WMI, preferring the one matching the accel backend
 *  (the NVIDIA card when CUDA was detected) over an integrated/secondary GPU. */
async function windowsGpuName(kind: DictationHardwareProfile['gpu']): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
      ],
      { timeout: 5000, windowsHide: true },
    );
    const names = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/microsoft basic|remote display|virtual/i.test(line));
    if (names.length === 0) return undefined;
    if (kind === 'cuda') {
      const nvidia = names.find((name) => /nvidia/i.test(name));
      if (nvidia) return nvidia;
    }
    return names[0];
  } catch {
    return undefined;
  }
}

/** GPU name from Electron's GL renderer string (macOS / Linux), unwrapping the
 *  ANGLE prefix and trimming driver/API suffixes. */
async function glRendererName(): Promise<string | undefined> {
  try {
    const info = (await app.getGPUInfo('complete')) as { auxAttributes?: { glRenderer?: string } };
    const raw = info?.auxAttributes?.glRenderer;
    return raw ? cleanGlRenderer(raw) : undefined;
  } catch {
    return undefined;
  }
}

function cleanGlRenderer(raw: string): string {
  let value = raw;
  const angle = value.match(/^ANGLE \(([^,]+),\s*(.+)\)$/);
  if (angle) value = angle[2];
  value = value.split(/ Direct3D| OpenGL| Vulkan| \/| \(0x| vs_/)[0];
  return value.trim();
}

function collectVendorIds(raw: unknown): Set<number> {
  const vendors = new Set<number>();
  if (typeof raw !== 'object' || raw === null) return vendors;
  const devices = (raw as { gpuDevice?: unknown }).gpuDevice;
  if (!Array.isArray(devices)) return vendors;
  for (const device of devices as GpuDeviceInfo[]) {
    if (typeof device.vendorId === 'number') vendors.add(device.vendorId);
  }
  return vendors;
}

/**
 * Map a hardware profile to a coarse engine tier. The single heuristic;
 * `engine-registry.ts#selectEngine` consumes it (with the user's override).
 * Reliable signals only - cores, RAM, and a known GPU backend. AVX2 is NOT a
 * gate (it is undetectable on Windows/macOS and whisper.cpp works without it).
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
