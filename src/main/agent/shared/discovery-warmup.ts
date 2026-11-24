/**
 * Runs an adapter's capability discovery for the CLI a spawn just detected, and
 * lets the spawn wait for it.
 *
 * Some command builders read what discovery learned: Cursor turns a stored
 * model name into its `--model` id through the list it read, Ollama passes
 * `--think` only a level its help listed, and Antigravity picks its permission
 * words and `--settings` from the flags its help shows. A builder is
 * synchronous, so it reads a cache, and that cache used to be warm because
 * every launch ran every installed agent's discovery. A launch no longer does
 * (`agent-list.ts`): starting a CLI nobody is using is what held other
 * terminals' input, measured at up to 4 s per key while one slow CLI answered
 * its version. So the spawn asks instead, from `ensureTrust`, which every spawn
 * path awaits before it builds the command.
 *
 * One read per CLI path. A read that failed is asked again by the next spawn,
 * and a read still running at the bound leaves this spawn to build from what
 * the adapter has, as it did when a launch's discovery had not finished.
 */
export class DiscoveryWarmup {
  /** Each path's read, running or landed. A failed read is dropped so the next spawn asks again. */
  private readonly reads = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();

  /**
   * Start discovery for each of `cliPaths` that has none yet, then wait for
   * every read still running, `timeoutMs` at most. Never rejects.
   */
  async settle(cliPaths: readonly string[], discover: (cliPath: string) => Promise<unknown>, timeoutMs: number): Promise<void> {
    for (const cliPath of cliPaths) {
      if (this.reads.has(cliPath)) continue;
      const read: Promise<void> = discover(cliPath).then(
        () => undefined,
        () => {
          // report-ok: discovery catches its own CLI failures. One that threw anyway left nothing warm, so
          // this spawn builds from the adapter's defaults, as before this wait existed, and the next asks again.
          if (this.reads.get(cliPath) === read) this.reads.delete(cliPath);
        },
      ).finally(() => {
        this.running.delete(read);
      });
      this.reads.set(cliPath, read);
      this.running.add(read);
    }
    if (this.running.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.running),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Forget every read, so the next spawn asks again. For a detection cache that was invalidated. */
  reset(): void {
    this.reads.clear();
    this.running.clear();
  }
}

/** How long a spawn waits for its CLI's discovery before it builds the command from what the adapter has. */
export const SPAWN_DISCOVERY_SETTLE_MS = 8_000;
