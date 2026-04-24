import fs from 'node:fs';
import which from 'which';
import { execVersion } from './exec-version';
import type { AgentInfo } from '../agent-adapter';

/**
 * Configuration for a per-agent detector. Each CLI has a different
 * binary name, version-string format, and (for some) well-known
 * fallback install locations - but the detection pipeline itself is
 * identical across all agents.
 */
export interface AgentDetectorConfig {
  /**
   * Binary name passed to `which()`. Must match what the agent
   * publishes on PATH (e.g. "claude", "codex", "gemini", "aider").
   */
  binaryName: string;

  /**
   * Additional absolute paths to check when the user has not
   * configured an override and PATH-based `which()` lookup fails.
   * Needed for the macOS GUI launch case where Electron launched
   * from Finder/Dock doesn't inherit the user's shell PATH.
   * Default: empty (no fallbacks checked).
   */
  fallbackPaths?: string[];

  /**
   * Given raw `<binary> --version` stdout (whitespace-trimmed),
   * return the extracted version string with any product-name
   * prefix/suffix stripped, or null if unparseable.
   *
   * Examples per agent:
   * - Claude: strip `(Claude Code)` suffix
   * - Codex:  strip `codex-cli ` prefix
   * - Aider:  strip `aider ` prefix
   * - Gemini: identity (raw output already is the version)
   */
  parseVersion(raw: string): string | null;
}

/**
 * Shared CLI detector used by every agent adapter. Handles:
 * - Promise caching + in-flight dedup
 * - User-configured override path with failure reporting
 * - PATH-based discovery via `which()`
 * - Well-known fallback paths (macOS GUI launch case)
 * - Graceful null return on all errors
 *
 * Per-agent detectors (ClaudeDetector, CodexDetector, GeminiDetector,
 * and Aider's inlined detection) all extend or compose this class
 * with a 5-line config, eliminating ~60 lines of duplicated
 * boilerplate across four files.
 *
 * Override semantics: when the user supplies an override path and it
 * fails (binary missing, --version returns nothing), we report
 * `{found: false, path: overridePath, version: null}` WITHOUT falling
 * through to PATH lookup. This preserves the user's explicit choice -
 * masking it by silently using PATH would hide the misconfiguration.
 *
 * Cross-platform: uses `which()` (handles Windows .exe/.cmd/.bat
 * extensions), `fs.existsSync()` (identical on all three platforms),
 * and `path.join()` implicitly via the shared `execVersion()` helper.
 */
export class AgentDetector {
  private cached: AgentInfo | null = null;
  private inflight: Promise<AgentInfo> | null = null;

  constructor(private readonly config: AgentDetectorConfig) {}

  /**
   * Resolve the CLI's path and version. Results are cached per
   * instance; call `invalidateCache()` to force a re-check. Concurrent
   * calls during an in-flight detection share the same promise so
   * the CLI is only inspected once.
   */
  async detect(overridePath?: string | null): Promise<AgentInfo> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.performDetection(overridePath);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Return the cached CLI version string, or null if detection has
   * not run yet or if the CLI was not found. Does not trigger a new
   * detection.
   */
  getCachedVersion(): string | null {
    return this.cached?.version ?? null;
  }

  /** Clear cached detection results so the next `detect()` call re-runs. */
  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    const name = this.config.binaryName;

    // 1. User-configured override path wins. On failure we report the
    //    configured path with `found: false` rather than falling through
    //    to PATH lookup - that would mask the user's explicit choice.
    if (overridePath) {
      const version = await this.extractVersion(overridePath);
      if (version !== null) {
        console.log(`[agent-detect] ${name}: found via override ${overridePath} (${version})`);
        this.cached = { found: true, path: overridePath, version };
        return this.cached;
      }
      console.warn(`[agent-detect] ${name}: override ${overridePath} did not produce a version`);
      this.cached = { found: false, path: overridePath, version: null };
      return this.cached;
    }

    // 2. PATH-based discovery via `which()`. Works when Electron is
    //    launched from a terminal that inherited the user's shell PATH,
    //    OR when restoreShellEnv() successfully restored it at startup.
    try {
      const whichPath = await which(name);
      const version = await this.extractVersion(whichPath);
      if (version !== null) {
        console.log(`[agent-detect] ${name}: found via PATH at ${whichPath} (${version})`);
        this.cached = { found: true, path: whichPath, version };
        return this.cached;
      }
    } catch {
      // Binary not on PATH - continue to fallback paths.
    }

    // 3. Well-known fallback locations. Needed when Electron is launched
    //    from Finder/Dock on macOS and does not inherit the shell PATH
    //    AND restoreShellEnv() failed. Homebrew installs live at
    //    /opt/homebrew/bin or /usr/local/bin, Claude's official installer
    //    at ~/.claude/local/claude, etc.
    const fallbackPaths = this.config.fallbackPaths ?? [];
    const existingFallbacks: string[] = [];
    for (const fallbackPath of fallbackPaths) {
      if (!fs.existsSync(fallbackPath)) continue;
      existingFallbacks.push(fallbackPath);
      const version = await this.extractVersion(fallbackPath);
      if (version !== null) {
        console.log(`[agent-detect] ${name}: found via fallback ${fallbackPath} (${version})`);
        this.cached = { found: true, path: fallbackPath, version };
        return this.cached;
      }
    }

    // Not found anywhere. Log enough to diagnose bug reports - including
    // which fallback paths were checked, so a user who reports "still
    // not detected" can immediately see whether their install location
    // needs to be added to the fallback list or configured as cliPath.
    const pathSegmentCount = (process.env.PATH ?? '').split(':').filter(Boolean).length;
    const missingCount = fallbackPaths.length - existingFallbacks.length;
    console.warn(
      `[agent-detect] ${name}: NOT FOUND. PATH had ${pathSegmentCount} segments; ` +
      `${existingFallbacks.length}/${fallbackPaths.length} fallback paths existed but failed version probe; ` +
      `${missingCount} did not exist on disk. Configure cliPath in Settings if installed elsewhere.`,
    );
    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execVersion(candidatePath);
      const raw = stdout.trim() || stderr.trim() || null;
      if (!raw) return null;
      const parsed = this.config.parseVersion(raw);
      return parsed && parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }
}
