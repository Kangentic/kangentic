import { app } from 'electron';

/**
 * Rewrite an in-asar path to its asar.unpacked twin when packaged. Shared by
 * every utilityProcess client that forks a worker bundled inside the asar
 * (`embed-client.ts`, `line-count-client.ts`, `dictation-client.ts`) - each
 * used to carry a byte-identical private copy of this function.
 */
export function unpacked(absolutePath: string): string {
  return app.isPackaged ? absolutePath.replace('app.asar', 'app.asar.unpacked') : absolutePath;
}
