import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import { execVersion } from './exec-version';
import { isNpmShimCandidate, missingNpmShimTarget } from './npm-shim-target';
import { cliInvocationForTarget, parseWslCliPath, type CliTarget } from './cli-target';
import { describeWslFailure, resolveWslDistroFacts, type WslDistroFacts } from './wsl-distro';
import { execFileAsync, type ExecOutput, type OffMainExecOptions } from '../../utility-process/off-main-exec';
import { PtyHostExitedError, PtyHostTimeoutError } from '../../pty/host/pty-host-request-errors';
import { childProcessEnv } from '../../shared/child-env';
import type { AgentInfo } from '../agent-adapter';
import type { StoredCliTarget } from '../../../shared/types';

/** Long enough for a probe that boots the WSL VM after a reboot. */
const WSL_PROBE_TIMEOUT_MS = 30_000;

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

/**
 * A failed probe is `transient` when it says nothing about whether the CLI is
 * installed: it exited 0 having printed nothing, or the pty host never answered
 * the exec. A NOT FOUND built on one is answered but never cached, so the next
 * detection probes again (docs/platforms/shells-and-paths.md has the boot race
 * that showed both).
 */
type VersionProbe =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'probe-failed' | 'empty-output' | 'unrecognized-output'; detail: string; transient: boolean };

/** Appended to a NOT FOUND line that rests on a transient probe failure. */
const NOT_CACHED_NOTE = 'A probe failed for a reason that says nothing about the install, so this result is not kept and the next detection probes again.';

/** Whether the probe never reached the CLI: the pty host timed out or was gone. */
function isHostUnanswered(error: unknown): boolean {
  return error instanceof PtyHostTimeoutError || error instanceof PtyHostExitedError;
}

/** The failure for a `--version` exec that rejected. */
function probeFailed(error: unknown): Extract<VersionProbe, { ok: false }> {
  return { ok: false, reason: 'probe-failed', detail: describeProbeError(error), transient: isHostUnanswered(error) };
}

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

  /**
   * The words that make the CLI print its version, for a CLI with no
   * `--version` (Oz prints it from `dump-debug-info`). Fixed words, never user
   * input: on Windows they join a shell command line. Default `--version`.
   */
  versionArgs?: readonly string[];

  /**
   * True when the adapter runs a CLI installed inside a WSL distro (its
   * `supportsWslCli`). A configured `\\wsl.localhost\...` path is then probed
   * inside the distro; without it the path is reported unsupported.
   */
  supportsWslCli?: boolean;
}

/** Seams for the WSL probe, so its logic runs on every OS under test. */
export interface AgentDetectorDependencies {
  platform?: NodeJS.Platform;
  resolveFacts?: (distro: string) => Promise<WslDistroFacts>;
  runWsl?: (file: string, args: readonly string[], options: OffMainExecOptions) => Promise<ExecOutput>;
}

/**
 * Shared CLI detector used by every agent adapter. Handles:
 * - Promise caching + in-flight dedup, per override path
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
  /** Completed detections, keyed by the override they were asked about ('' for none). */
  private readonly cached = new Map<string, AgentInfo>();
  /** Detections still running, keyed the same way. */
  private readonly inflight = new Map<string, Promise<AgentInfo>>();
  /** The detection that filled the cache most recently, for callers holding no path. */
  private latest: AgentInfo | null = null;
  /** Bumped by `invalidateCache`, so a detection that was running then caches nothing. */
  private generation = 0;
  /**
   * Results `detect()` answers with but never caches: a WSL distro whose facts
   * could not be read, and a NOT FOUND that rests on a transient probe failure
   * (`VersionProbe`).
   */
  private readonly uncacheable = new WeakSet<AgentInfo>();
  private readonly platform: NodeJS.Platform;
  private readonly resolveFacts: (distro: string) => Promise<WslDistroFacts>;
  private readonly runWsl: (file: string, args: readonly string[], options: OffMainExecOptions) => Promise<ExecOutput>;

  constructor(private readonly config: AgentDetectorConfig, dependencies: AgentDetectorDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.resolveFacts = dependencies.resolveFacts ?? ((distro) => resolveWslDistroFacts(distro));
    this.runWsl = dependencies.runWsl ?? execFileAsync;
  }

  /**
   * Resolve the CLI's path and version. Results are cached per override
   * path, so two projects whose CLI paths differ each get their own CLI;
   * call `invalidateCache()` to force a re-check. Concurrent calls for the
   * same override during an in-flight detection share the same promise so
   * the CLI is only inspected once.
   *
   * A detection still running when the cache is invalidated answers its own
   * callers but never fills the cache: it was asked about the old override.
   * Before this, a CLI path saved while startup detection ran was overwritten
   * by the old path, and every spawn after it started the old CLI.
   */
  async detect(overridePath?: string | null): Promise<AgentInfo> {
    const key = overridePath || '';
    const cachedResult = this.cached.get(key);
    if (cachedResult) return cachedResult;
    const running = this.inflight.get(key);
    if (running) return running;

    const generation = this.generation;
    const detection = this.performDetection(overridePath);
    this.inflight.set(key, detection);
    try {
      const result = await detection;
      if (generation === this.generation && !this.uncacheable.has(result)) {
        this.cached.set(key, result);
        this.latest = result;
      }
      return result;
    } finally {
      if (this.inflight.get(key) === detection) this.inflight.delete(key);
    }
  }

  /**
   * Return the cached CLI version string, or null if detection has
   * not run yet or if the CLI was not found. Does not trigger a new
   * detection. With `cliPath`, the version of the detection that found that
   * path; without one, or when no detection found it (a shim swap can hand
   * the builder a sibling path), the most recent detection's.
   */
  getCachedVersion(cliPath?: string | null): string | null {
    if (cliPath) {
      for (const result of this.cached.values()) {
        if (result.path === cliPath) return result.version ?? null;
      }
    }
    return this.latest?.version ?? null;
  }

  /** Clear cached detection results so the next `detect()` call re-runs. */
  invalidateCache(): void {
    this.generation += 1;
    this.cached.clear();
    this.inflight.clear();
    this.latest = null;
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    const name = this.config.binaryName;

    // 1. User-configured override path wins. On failure we report the
    //    configured path with `found: false` rather than falling through
    //    to PATH lookup - that would mask the user's explicit choice.
    if (overridePath) {
      const wslCli = parseWslCliPath(overridePath, this.platform);
      if (wslCli) return this.detectWslOverride(overridePath, wslCli);
      const probe = await this.probeVersion(overridePath);
      if (probe.ok) {
        console.log(`[agent-detect] ${name}: found via override ${overridePath} (${probe.version})`);
        return { found: true, path: overridePath, version: probe.version };
      }
      console.warn(
        `[agent-detect] ${name}: override ${overridePath} did not produce a version (${probe.detail})`
        + (probe.transient ? `. ${NOT_CACHED_NOTE}` : ''),
      );
      const result: AgentInfo = { found: false, path: overridePath, version: null, detectionError: probe.detail };
      if (probe.transient) this.uncacheable.add(result);
      return result;
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
    let sawTransientFailure = false;
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
          return { found: true, path: matchPath, version: probe.version };
        }
        if (probe.transient) sawTransientFailure = true;
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
        return { found: true, path: fallbackPath, version: probe.version };
      }
      if (probe.transient) sawTransientFailure = true;
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
      `${missingCount} did not exist on disk. Configure cliPath in Settings if installed elsewhere.` +
      (sawTransientFailure ? ` ${NOT_CACHED_NOTE}` : ''),
    );
    const notFound: AgentInfo = { found: false, path: null, version: null };
    if (sawTransientFailure) this.uncacheable.add(notFound);
    return notFound;
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

  /**
   * A configured path into a WSL distro. Windows cannot run a Linux binary or
   * follow the distro's symlinks (`~/.local/bin/claude` is one), so neither
   * `fs.existsSync` nor `execVersion` applies: the probe runs `--version`
   * inside the distro, on the PATH its interactive shell gives the user, and a
   * failure carries the error the distro printed.
   */
  private async detectWslOverride(
    overridePath: string,
    wslCli: { distro: string; linuxCliPath: string },
  ): Promise<AgentInfo> {
    const name = this.config.binaryName;
    const cliTarget: StoredCliTarget = { kind: 'wsl', distro: wslCli.distro };
    if (!this.config.supportsWslCli) {
      console.warn(`[agent-detect] ${name}: override ${overridePath} is a WSL path, and ${name} does not run from WSL`);
      return { found: false, path: overridePath, version: null, cliTarget, unsupportedTarget: true };
    }

    let target: CliTarget;
    try {
      target = { kind: 'wsl', ...wslCli, facts: await this.resolveFacts(wslCli.distro) };
    } catch (error) {
      const detectionError = error instanceof Error ? error.message : String(error);
      console.warn(`[agent-detect] ${name}: could not read WSL distro ${wslCli.distro} for ${overridePath} (${detectionError})`);
      // Not cached: the facts read keeps no failure either (`resolveWslDistroFacts`),
      // so a distro that was stopped or still booting is found by the next detection.
      const result: AgentInfo = { found: false, path: overridePath, version: null, cliTarget, detectionError };
      this.uncacheable.add(result);
      return result;
    }

    const invocation = cliInvocationForTarget(target, this.config.versionArgs ?? ['--version']);
    try {
      const output = await this.runWsl(invocation.file, invocation.args, {
        env: childProcessEnv({ WSL_UTF8: '1' }),
        timeout: WSL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      const raw = output.stdout.trim() || output.stderr.trim();
      const parsed = raw ? this.config.parseVersion(raw) : null;
      if (parsed) {
        console.log(`[agent-detect] ${name}: found in WSL ${wslCli.distro} at ${wslCli.linuxCliPath} (${parsed})`);
        return { found: true, path: overridePath, version: parsed, cliTarget };
      }
      // Empty output is transient here as it is for a Windows path (`VersionProbe`).
      const detectionError = raw ? firstLine(raw) : 'empty output';
      return this.wslOverrideNotFound(
        `${overridePath} did not produce a version (${detectionError})`,
        { found: false, path: overridePath, version: null, cliTarget, detectionError },
        !raw,
      );
    } catch (error) {
      const detectionError = truncate(describeWslFailure(error));
      return this.wslOverrideNotFound(
        `${overridePath} failed its version probe in WSL (${detectionError})`,
        { found: false, path: overridePath, version: null, cliTarget, detectionError },
        isHostUnanswered(error),
      );
    }
  }

  /** Log a WSL override's NOT FOUND, and keep it out of the cache when it rests on a transient failure. */
  private wslOverrideNotFound(description: string, result: AgentInfo, transient: boolean): AgentInfo {
    console.warn(`[agent-detect] ${this.config.binaryName}: ${description}` + (transient ? `. ${NOT_CACHED_NOTE}` : ''));
    if (transient) this.uncacheable.add(result);
    return result;
  }

  private async probeVersion(candidatePath: string): Promise<VersionProbe> {
    try {
      if (!fs.existsSync(candidatePath)) {
        return { ok: false, reason: 'missing', detail: 'the file does not exist on disk', transient: false };
      }
      const versionArgs = this.config.versionArgs;
      let output: { stdout: string; stderr: string };
      try {
        output = versionArgs ? await execVersion(candidatePath, undefined, versionArgs) : await execVersion(candidatePath);
      } catch (error) {
        // A timeout says the binary is slow, not that it is the wrong one, and
        // every agent is probed at once at boot: a CLI answering in 1.3 s alone
        // timed out at 5 s among the rest and vanished from the agent list.
        // So once more with room, by which point the rest have mostly finished.
        if (!isProbeTimeout(error)) return probeFailed(error);
        try {
          output = versionArgs
            ? await execVersion(candidatePath, SLOW_PROBE_TIMEOUT_MS, versionArgs)
            : await execVersion(candidatePath, SLOW_PROBE_TIMEOUT_MS);
        } catch (retryError) {
          return probeFailed(retryError);
        }
      }
      const raw = output.stdout.trim() || output.stderr.trim();
      // Exit 0 with nothing on either stream names no tool at all, so it is
      // not evidence of a different one (see `VersionProbe`).
      if (!raw) return { ok: false, reason: 'empty-output', detail: 'empty output', transient: true };
      const parsed = this.config.parseVersion(raw);
      return parsed && parsed.length > 0
        ? { ok: true, version: parsed }
        : { ok: false, reason: 'unrecognized-output', detail: firstLine(raw), transient: false };
    } catch (error) {
      return probeFailed(error);
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
    case 'empty-output':
      return 'its --version exited without printing anything';
    case 'unrecognized-output':
      return `its --version output did not match this agent (likely a different tool publishing the same name): "${probe.detail}"`;
  }
}

/** The second, lone `--version` attempt after a timeout. */
const SLOW_PROBE_TIMEOUT_MS = 15_000;

/** Whether `execVersion` rejected because its timeout killed the probe. */
function isProbeTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const killed: unknown = Object.getOwnPropertyDescriptor(error, 'killed')?.value;
  const signal: unknown = Object.getOwnPropertyDescriptor(error, 'signal')?.value;
  return killed === true && typeof signal === 'string';
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
