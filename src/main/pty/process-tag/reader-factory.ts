import { DarwinTaggedProcessReader } from './darwin-reader';
import { LinuxTaggedProcessReader } from './linux-reader';
import type { TaggedProcessReader, ToolRunner } from './process-scan';
import { Win32TaggedProcessReader } from './win32-reader';

export interface TaggedProcessReaderOptions {
  /** macOS: how the reader runs `lsappinfo` (`DarwinReaderOptions.runTool`). */
  runTool?: ToolRunner;
}

/** The reader for this platform, or null where none exists (the reap no-ops). */
export function createTaggedProcessReader(
  platform: NodeJS.Platform = process.platform,
  options: TaggedProcessReaderOptions = {},
): TaggedProcessReader | null {
  if (platform === 'win32') return new Win32TaggedProcessReader();
  if (platform === 'linux') return new LinuxTaggedProcessReader();
  if (platform === 'darwin') return new DarwinTaggedProcessReader({ runTool: options.runTool });
  return null;
}
