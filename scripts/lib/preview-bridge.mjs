/**
 * Drive a running `/preview` through its inspection bridge: the port the preview announces in
 * `.kangentic/preview.lock`, and `/eval`, which runs an expression in the preview's renderer and
 * awaits a promise it returns. For the scripts that measure or capture what the shipped app does by
 * driving it rather than importing main's pipeline (scripts/capture-demo-knowledge-graph.mjs, the
 * Ask eval harness).
 */
import fs from 'node:fs';
import path from 'node:path';

/** The inspection port the preview of the checkout at `repoRoot` announced. */
export function readPreviewPort(repoRoot) {
  const lockPath = path.join(repoRoot, '.kangentic', 'preview.lock');
  if (!fs.existsSync(lockPath)) {
    throw new Error(`No preview is running for this worktree (${lockPath} is missing). Start one with /preview first, then re-run.`);
  }
  const record = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  if (!record.port) throw new Error('The preview lockfile carries no port.');
  return record.port;
}

/**
 * Evaluate an expression in the preview's renderer and return its value.
 *
 * The bridge sets no deadline of its own, since it awaits the promise for as long as the renderer
 * takes, and fetch has none either, so `timeoutMs` is what stops one wedged call from hanging the
 * whole run. Thirty seconds unless said. Needs Settings > Developer > Allow Unsafe Operations,
 * which is reported plainly rather than as a bare 403.
 */
export async function evaluateInPreview(port, expression, timeoutMs = 30_000) {
  const response = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expression }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // The bridge answers `{ ok: false, error: { kind, detail } }`. Reading `kind` and `detail` off
    // the top level, where no response has them, once dropped the renderer's own error text from
    // every failure and printed only the bare status line.
    const failure = payload?.error ?? payload ?? {};
    const detail = failure.detail ?? failure.kind ?? response.statusText;
    if (failure.kind === 'eval-disabled') {
      throw new Error('Turn on Settings > Developer > Allow Unsafe Operations in the preview, then re-run.');
    }
    throw new Error(`Preview rejected the call (${failure.kind ?? response.status}): ${detail}`);
  }
  return payload?.value;
}
