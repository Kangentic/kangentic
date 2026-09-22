import { app } from 'electron';
import type { ProcessMetrics } from '../../shared/types';

/**
 * Snapshot of per-process resource usage. Wraps `app.getAppMetrics()` and
 * adds platform + version context for bug-report reproducibility. On-demand
 * only - no install hook, no persistent storage.
 *
 * `main` is the main process's own view of itself (`process.memoryUsage()`),
 * which the per-process table cannot give: `privateBytes` and
 * `workingSetSize` fold the V8 heap, Node's external allocations, and
 * Chromium's own browser-process footprint into one number, so a main
 * process at 585 MB of commit says nothing about WHICH of those grew. The
 * only other way to read this is attaching the Node inspector to the live
 * process, which once fast-failed a dogfooding instance (#706).
 */
export function getProcessMetrics(): ProcessMetrics {
  const metrics = app.getAppMetrics();
  const mainUsage = process.memoryUsage();
  return {
    ts: new Date().toISOString(),
    uptimeSec: process.uptime(),
    platform: process.platform,
    arch: process.arch,
    versions: {
      kangentic: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    main: {
      rssBytes: mainUsage.rss,
      heapTotalBytes: mainUsage.heapTotal,
      heapUsedBytes: mainUsage.heapUsed,
      externalBytes: mainUsage.external,
      arrayBuffersBytes: mainUsage.arrayBuffers,
    },
    processes: metrics.map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      name: entry.name,
      cpu: { percentCPUUsage: entry.cpu.percentCPUUsage },
      memory: {
        workingSetSize: entry.memory.workingSetSize,
        peakWorkingSetSize: entry.memory.peakWorkingSetSize,
        privateBytes: entry.memory.privateBytes,
      },
      creationTime: entry.creationTime,
    })),
  };
}
