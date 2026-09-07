import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import { execVersion } from './exec-version';
import { isNpmShimCandidate, missingNpmShimTarget } from './npm-shim-target';
import type { AgentInfo } from '../agent-adapter';

/**
 * How many VERSION PROBES a candidate name may spend. The realistic worst case
 * is a working-directory hit plus a PATHEXT pair plus one duplicate PATH entry;
 * the cap keeps a generic alias such as Cursor's `agent` from turning into an
 * open-ended series of 5s spawns.
 *
 * It counts probes, not matches, and that distinction is load-bearing. A dead
 * npm shim is skipped without a spawn, so it costs nothing the cap exists to
 * bound. Charging it a slot anyway would let a run of dead shims push the real
 * install out of the window and report NOT FOUND, which is the exact bug the
 * skip was added to fix.
 */
const MAX_PATH_MATCHES_PER_CANDIDATE = 4;

/** Longest slice of a probe's output or error carried into a log line. */
const PROBE_DETAIL_MAX_LENGTH = 200;

type VersionProbe =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'probe-failed' | 'unrecognized-output'; detail: string };

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
   * Additional PATH names to try, in order, when `binaryName` is absent
   * or fails its version probe. Default: none.
   *
   * This exists for CLIs that publish more than one shim and whose
   * shortest name is not theirs alone. Cursor installs BOTH `cursor-agent`
   * and `agent`; xAI's Grok CLI also installs `agent`, and on Windows its
   * `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order. Probing the
   * unambiguous name first is what stops one vendor's generic shim from
   * deciding whether another vendor's CLI is installed.
   *
   * `parseVersion` still guards every candidate, so an alias can only ever
   * resolve a binary that produces THIS agent's version format.
   */
  binaryAliases?: string[];

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
 * - PATH-based discovery via `which()`, every match in order, not only the
 *   first: `which` checks that a shim file exists, never that it works, and
 *   on Windows it searches the working directory before PATH, so a stale
 *   npm shim in a project root would otherwise hide a real install
 * - Skipping an npm shim whose target script is gone without spawning it
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
      const probe = await this.probeVersion(overridePath);
      if (probe.ok) {
        console.log(`[agent-detect] ${name}: found via override ${overridePath} (${probe.version})`);
        this.cached = { found: true, path: overridePath, version: probe.version };
        return this.cached;
      }
      console.warn(`[agent-detect] ${name}: override ${overridePath} did not produce a version (${probe.detail})`);
      this.cached = { found: false, path: overridePath, version: null };
      return this.cached;
    }

    // 2. PATH-based discovery via `which()`. Works when Electron is
    //    launched from a terminal that inherited the user's shell PATH,
    //    OR when restoreShellEnv() successfully restored it at startup.
    //    Candidates are tried in order, the unambiguous name first, and
    //    EVERY match for a name is walked in `which` order (on Windows the
    //    working directory first, then each PATH entry by PATHEXT), spending
    //    at most MAX_PATH_MATCHES_PER_CANDIDATE version probes. A match
    //    that fails its version probe does NOT stop the search: that is the
    //    shared-shim case (Grok's `agent.exe` shadowing Cursor's `agent.cmd`)
    //    and the dead-shim case (an npm `.cmd` left behind in a project root
    //    after its package was removed), where the right answer is to keep
    //    looking rather than conclude the agent is missing. A dead npm shim is
    //    recognized from its content and skipped without a spawn.
    const pathMatchSummaries: string[] = [];
    for (const candidate of [name, ...(this.config.binaryAliases ?? [])]) {
      const matches = await this.resolvePathMatches(candidate);
      let probedCount = 0;
      let skippedDeadShimCount = 0;
      let untriedCount = 0;
      for (const matchPath of matches) {
        // The cap is a PROBE budget, so a dead shim skipped below never
        // consumes it. Once the budget is gone the rest are counted, not
        // examined, so the NOT FOUND line can say how many were left.
        if (probedCount >= MAX_PATH_MATCHES_PER_CANDIDATE) {
          untriedCount += 1;
          continue;
        }
        if (isNpmShimCandidate(matchPath)) {
          const missingTarget = missingNpmShimTarget(matchPath);
          if (missingTarget !== null) {
            skippedDeadShimCount += 1;
            console.warn(
              `[agent-detect] ${name}: "${candidate}" matched ${matchPath}, an npm shim whose target `
              + `${missingTarget} does not exist; skipping it without a version probe.`,
            );
            continue;
          }
        }
        probedCount += 1;
        const probe = await this.probeVersion(matchPath);
        if (probe.ok) {
          console.log(`[agent-detect] ${name}: found via PATH at ${matchPath} (${probe.version})`);
          this.cached = { found: true, path: matchPath, version: probe.version };
          return this.cached;
        }
        console.warn(
          `[agent-detect] ${name}: "${candidate}" resolved to ${matchPath} but ${describeProbeFailure(probe)}; `
          + 'trying the next match.',
        );
      }
      if (matches.length > 0) {
        pathMatchSummaries.push(
          `${candidate}: ${matches.length} found, ${probedCount} probed, ${skippedDeadShimCount} skipped as dead npm shims`
          + (untriedCount > 0 ? `, ${untriedCount} beyond the cap of ${MAX_PATH_MATCHES_PER_CANDIDATE} not tried` : ''),
        );
      }
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
      const probe = await this.probeVersion(fallbackPath);
      if (probe.ok) {
        console.log(`[agent-detect] ${name}: found via fallback ${fallbackPath} (${probe.version})`);
        this.cached = { found: true, path: fallbackPath, version: probe.version };
        return this.cached;
      }
    }

    // Not found anywhere. Log enough to diagnose bug reports - which PATH
    // matches were tried and why each was passed over, plus which fallback
    // paths were checked, so a user who reports "still not detected" can
    // immediately see whether their install location needs to be added to
    // the fallback list or configured as cliPath.
    const pathSegmentCount = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).length;
    const missingCount = fallbackPaths.length - existingFallbacks.length;
    console.warn(
      `[agent-detect] ${name}: NOT FOUND. PATH had ${pathSegmentCount} segments; ` +
      `PATH matches tried: ${pathMatchSummaries.length > 0 ? pathMatchSummaries.join('; ') : 'none'}; ` +
      `${existingFallbacks.length}/${fallbackPaths.length} fallback paths existed but failed version probe; ` +
      `${missingCount} did not exist on disk. Configure cliPath in Settings if installed elsewhere.`,
    );
    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  /**
   * Every `which` match for `candidate`, in `which` order, de-duplicated and
   * UNCAPPED. The caller applies the probe budget, because only it knows which
   * matches actually cost a spawn.
   *
   * De-duplication is case-insensitive on Windows only, where PATHEXT is
   * expanded to both cases and a PATH entry listed at both user and machine
   * scope returns each file twice. macOS volumes are case-insensitive too, but
   * `which` does not generate case variants there the way PATHEXT expansion
   * does: it would take a PATH already carrying two case-different spellings of
   * one directory, which is a malformed PATH rather than a case this needs to
   * absorb.
   */
  private async resolvePathMatches(candidate: string): Promise<string[]> {
    let found: unknown;
    try {
      found = await which(candidate, { all: true, nothrow: true });
    } catch {
      // `nothrow` covers the real package; a test double may still reject.
      return [];
    }
    const uniqueMatches: string[] = [];
    const seenKeys = new Set<string>();
    for (const matchPath of toMatchList(found)) {
      const key = process.platform === 'win32' ? matchPath.toLowerCase() : matchPath;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      uniqueMatches.push(matchPath);
    }
    return uniqueMatches;
  }

  private async probeVersion(candidatePath: string): Promise<VersionProbe> {
    try {
      if (!fs.existsSync(candidatePath)) {
        return { ok: false, reason: 'missing', detail: 'the file does not exist on disk' };
      }
      let output: { stdout: string; stderr: string };
      try {
        output = await execVersion(candidatePath);
      } catch (error) {
        return { ok: false, reason: 'probe-failed', detail: describeProbeError(error) };
      }
      const raw = output.stdout.trim() || output.stderr.trim();
      if (!raw) return { ok: false, reason: 'unrecognized-output', detail: 'empty output' };
      const parsed = this.config.parseVersion(raw);
      return parsed && parsed.length > 0
        ? { ok: true, version: parsed }
        : { ok: false, reason: 'unrecognized-output', detail: firstLine(raw) };
    } catch (error) {
      return { ok: false, reason: 'probe-failed', detail: describeProbeError(error) };
    }
  }
}

/**
 * `which(name, { all: true, nothrow: true })` resolves `string[]` or null. A
 * plain string is accepted too: the unit suites that stub `which` resolve a
 * single path, and iterating that as an array would probe it one character
 * at a time.
 */
function toMatchList(found: unknown): string[] {
  if (Array.isArray(found)) {
    return found.filter((entry): entry is string => typeof entry === 'string');
  }
  return typeof found === 'string' ? [found] : [];
}

function describeProbeFailure(probe: Extract<VersionProbe, { ok: false }>): string {
  switch (probe.reason) {
    case 'missing':
      return 'the file does not exist on disk';
    case 'probe-failed':
      return `its --version probe failed (${probe.detail})`;
    case 'unrecognized-output':
      return 'its --version output did not match this agent (likely a different tool publishing the same name)';
  }
}

/**
 * A one-line account of why `execVersion` rejected, built from the fields
 * child_process attaches to the error: a numeric exit code with the first
 * informative stderr line (for a dead npm shim, node's "Cannot find module"),
 * a string code such as ENOENT, or the 5s timeout's signal.
 */
function describeProbeError(error: unknown): string {
  if (!(error instanceof Error)) return truncate(String(error));
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const signal: unknown = Object.getOwnPropertyDescriptor(error, 'signal')?.value;
  const killed: unknown = Object.getOwnPropertyDescriptor(error, 'killed')?.value;
  const stderr: unknown = Object.getOwnPropertyDescriptor(error, 'stderr')?.value;
  const stderrLine = typeof stderr === 'string' ? firstInformativeLine(stderr) : '';
  if (killed === true && typeof signal === 'string') return `timed out (${signal})`;
  if (typeof code === 'number') return stderrLine ? `exit code ${code}: ${stderrLine}` : `exit code ${code}`;
  if (typeof code === 'string') return stderrLine ? `${code}: ${stderrLine}` : code;
  return firstLine(error.message);
}

/** The first stderr line that names an error, else the first non-empty line. */
function firstInformativeLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const errorLine = lines.find((line) => /error/i.test(line));
  return truncate(errorLine ?? lines[0] ?? '');
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidateLine) => candidateLine.trim().length > 0) ?? '';
  return truncate(line.trim());
}

function truncate(text: string): string {
  return text.length > PROBE_DETAIL_MAX_LENGTH ? `${text.slice(0, PROBE_DETAIL_MAX_LENGTH)}...` : text;
}
