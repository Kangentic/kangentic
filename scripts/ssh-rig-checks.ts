/**
 * What the #913 rig clients share (`ssh-mcp-rig`, `ssh-removal-rig`, `ssh-quit-rig`): one list of named checks, the
 * wait they poll on, and the result `ssh-link-rig.mjs` reads from stdout. A client is bundled alone, so this is an
 * import, never a file copied beside it.
 *
 * Not product code, and `tsconfig.json` covers `src/` only, so `npm run typecheck` does not see it.
 */

const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];

export function check(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  process.stderr.write(`[${passed ? 'ok' : 'FAILED'}] ${name}${detail ? `: ${detail}` : ''}\n`);
}

export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitFor(description: string, condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await sleep(50);
  }
}

/** Print what the driver reads, and exit with whether every check passed. */
export function finishChecks(): never {
  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`${JSON.stringify({ allPassed: failed.length === 0, passed: checks.length - failed.length, of: checks.length, failed }, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}
