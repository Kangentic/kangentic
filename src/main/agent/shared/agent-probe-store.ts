/**
 * What each agent CLI answered the last time it was asked, kept across launches.
 *
 * Every launch used to start each registered CLI at least once (`--version`),
 * and each one it found twice or three times more (its sign-in check, `--help`,
 * its model list), all in the first seconds. Over 19 dev boots that made
 * `agent:list` take 4 to 18 s. One slow CLI among them is enough to hold other
 * terminals' input while it answers (`agent-list.ts` has the measurement).
 *
 * Two kinds of answer are kept, in one file in the config folder:
 *
 * - A PROBE: what one file answered to its version command, with the identity
 *   of every file that decides the answer (the path itself, an npm shim's
 *   target, a launcher's program). An answer is reused only while every one of
 *   them is the same file it was.
 * - An INVENTORY entry: an agent's sign-in state and capabilities at one path
 *   and version.
 *
 * Both are for DISPLAY: the agent list and the account cards, for an agent
 * nothing has started this launch. A spawn never reads them: `AgentDetector`
 * keeps a remembered detection apart from a live one, and every spawn path asks
 * for a live one (see `detect` there). A version manager's shim keeps its
 * identity across an upgrade, so a remembered version can be wrong, and
 * OpenCode and Qwen build their command line from the version.
 *
 * Off until main turns it on (`enableAgentProbeStore`), so the pty host, the
 * retrieval worker and every unit test, which all bundle the adapters, touch no
 * file. Reads and writes are async: the cache is never worth a held main thread,
 * and a write that fails costs the next launch its probes and nothing else,
 * which is why it does not go through `safeWriteJson` and its user-facing notice.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentCapabilities, ModelAliasOption } from '../../../shared/types';

/** Bumped when an entry's shape changes: a file written under another number reads as empty. */
const STORE_SCHEMA = 1;
/** How long a change waits for others before the file is rewritten. */
const WRITE_DEBOUNCE_MS = 2_000;
/** A machine has a few dozen candidates at most; past these the oldest entries go. */
const MAX_PROBES = 400;
const MAX_INVENTORY = 100;

/**
 * Which file a path resolves to, and whether it has changed. The numbers are
 * strings because they are read as bigints (an NTFS file id does not fit a
 * JS number, see `cli-identity.ts`) and JSON has no bigint.
 */
export interface ProbeFileIdentity {
  realPath: string;
  device: string;
  inode: string;
  size: string;
  modifiedAtNs: string;
}

/** A version, or output that was not this agent's (another tool publishing the same name). */
export type RememberedProbeOutcome =
  | { ok: true; version: string }
  | { ok: false; detail: string };

export interface ProbeKey {
  /** The detector's binary name: two agents can probe one file and read it differently. */
  detector: string;
  /** The words that made the CLI print its version. */
  args: string;
  /** The candidate path as detection walked to it. */
  path: string;
}

export interface RememberedProbe extends ProbeKey {
  /**
   * Every file that decides the answer, the candidate first. Empty for a path
   * no local read can identify (a CLI inside a WSL distro), which is then
   * remembered by path alone.
   */
  files: ProbeFileIdentity[];
  outcome: RememberedProbeOutcome;
  probedAt: string;
}

export interface InventoryKey {
  agent: string;
  path: string;
  version: string | null;
}

export interface RememberedInventory extends InventoryKey {
  /** Absent for an agent with no sign-in check. */
  authenticated?: boolean | null;
  capabilities?: AgentCapabilities;
  readAt: string;
}

interface StoreState {
  filePath: string;
  probes: Map<string, RememberedProbe>;
  inventory: Map<string, RememberedInventory>;
  loading: Promise<void> | null;
  writeTimer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void> | null;
  dirty: boolean;
}

let state: StoreState | null = null;

/** Start keeping answers in `filePath`. Main calls this once; nothing else does. */
export function enableAgentProbeStore(filePath: string): void {
  if (state?.filePath === filePath) return;
  if (state?.writeTimer) clearTimeout(state.writeTimer);
  state = { filePath, probes: new Map(), inventory: new Map(), loading: null, writeTimer: null, writing: null, dirty: false };
}

export function isAgentProbeStoreEnabled(): boolean {
  return state !== null;
}

function pathKey(filePath: string): string {
  // `which` expands PATHEXT in both cases on Windows, so one file is walked under two spellings.
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function probeKeyOf(key: ProbeKey): string {
  return `${key.detector}\n${key.args}\n${pathKey(key.path)}`;
}

function inventoryKeyOf(key: InventoryKey): string {
  return `${key.agent}\n${pathKey(key.path)}\n${key.version ?? ''}`;
}

/** The identity of the file `filePath` resolves to now, or null when it cannot be read. */
export async function readProbeFileIdentity(filePath: string): Promise<ProbeFileIdentity | null> {
  try {
    const realPath = await fs.promises.realpath(filePath);
    const stats = await fs.promises.stat(realPath, { bigint: true });
    return {
      realPath,
      device: String(stats.dev),
      inode: String(stats.ino),
      size: String(stats.size),
      modifiedAtNs: String(stats.mtimeNs),
    };
  } catch {
    // report-ok: a file that cannot be read has no identity, so its answer is neither kept nor reused.
    return null;
  }
}

/** Whether two lists name the same files, unchanged, in the same order. */
export function sameProbeFiles(left: readonly ProbeFileIdentity[], right: readonly ProbeFileIdentity[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return file.realPath === other.realPath
      && file.device === other.device
      && file.inode === other.inode
      && file.size === other.size
      && file.modifiedAtNs === other.modifiedAtNs;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileIdentityFrom(value: unknown): ProbeFileIdentity | null {
  if (!isRecord(value)) return null;
  const { realPath, device, inode, size, modifiedAtNs } = value;
  if (typeof realPath !== 'string' || typeof device !== 'string' || typeof inode !== 'string') return null;
  if (typeof size !== 'string' || typeof modifiedAtNs !== 'string') return null;
  return { realPath, device, inode, size, modifiedAtNs };
}

function outcomeFrom(value: unknown): RememberedProbeOutcome | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return typeof value.version === 'string' && value.version.length > 0 ? { ok: true, version: value.version } : null;
  if (value.ok === false) return typeof value.detail === 'string' ? { ok: false, detail: value.detail } : null;
  return null;
}

function probeFrom(value: unknown): RememberedProbe | null {
  if (!isRecord(value)) return null;
  const { detector, args, probedAt } = value;
  if (typeof detector !== 'string' || typeof args !== 'string' || typeof value.path !== 'string' || typeof probedAt !== 'string') return null;
  if (!Array.isArray(value.files)) return null;
  const files: ProbeFileIdentity[] = [];
  for (const entry of value.files) {
    const file = fileIdentityFrom(entry);
    if (!file) return null;
    files.push(file);
  }
  const outcome = outcomeFrom(value.outcome);
  if (!outcome) return null;
  return { detector, args, path: value.path, files, outcome, probedAt };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecordOf<Value>(value: unknown, isValue: (entry: unknown) => entry is Value): value is Record<string, Value> {
  return isRecord(value) && Object.values(value).every(isValue);
}

function isModelAlias(value: unknown): value is ModelAliasOption {
  return isRecord(value) && isString(value.id) && (value.resolvesTo === undefined || isString(value.resolvesTo));
}

/**
 * Whether every field has the type the pickers read it as. The file is this
 * app's own, but one damaged or edited into `models: "x"` would otherwise reach
 * a renderer that maps over the list.
 */
function isAgentCapabilities(value: unknown): value is AgentCapabilities {
  if (!isRecord(value)) return false;
  const { effortLevels, effortLevelsByModel, supportsModelOverride, models, modelDisplayNames, modelAliases } = value;
  return (effortLevels === undefined || isStringArray(effortLevels))
    && (effortLevelsByModel === undefined || isRecordOf(effortLevelsByModel, isStringArray))
    && (supportsModelOverride === undefined || typeof supportsModelOverride === 'boolean')
    && (models === undefined || isStringArray(models))
    && (modelDisplayNames === undefined || isRecordOf(modelDisplayNames, isString))
    && (modelAliases === undefined || (Array.isArray(modelAliases) && modelAliases.every(isModelAlias)));
}

function inventoryFrom(value: unknown): RememberedInventory | null {
  if (!isRecord(value)) return null;
  const { agent, version, authenticated, capabilities, readAt } = value;
  if (typeof agent !== 'string' || typeof value.path !== 'string' || typeof readAt !== 'string') return null;
  if (version !== null && typeof version !== 'string') return null;
  if (authenticated !== undefined && authenticated !== null && typeof authenticated !== 'boolean') return null;
  const entry: RememberedInventory = { agent, path: value.path, version, readAt };
  if (authenticated !== undefined) entry.authenticated = authenticated;
  if (capabilities !== undefined) {
    if (!isAgentCapabilities(capabilities)) return null;
    // The parse made every key an own property, a model named `__proto__` included, and nothing here copies by assignment.
    entry.capabilities = capabilities;
  }
  return entry;
}

async function load(current: StoreState): Promise<void> {
  let text: string;
  try {
    text = await fs.promises.readFile(current.filePath, 'utf8');
  } catch {
    // report-ok: no file on a first launch, and an unreadable one reads as empty.
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // report-ok: a damaged cache reads as empty, and the next write replaces it.
    return;
  }
  if (!isRecord(parsed) || parsed.schema !== STORE_SCHEMA) return;
  // An answer recorded while the file was being read is newer than the file's.
  for (const value of Array.isArray(parsed.probes) ? parsed.probes : []) {
    const probe = probeFrom(value);
    if (probe && !current.probes.has(probeKeyOf(probe))) current.probes.set(probeKeyOf(probe), probe);
  }
  for (const value of Array.isArray(parsed.inventory) ? parsed.inventory : []) {
    const entry = inventoryFrom(value);
    if (entry && !current.inventory.has(inventoryKeyOf(entry))) current.inventory.set(inventoryKeyOf(entry), entry);
  }
}

function loaded(current: StoreState): Promise<void> {
  current.loading ??= load(current);
  return current.loading;
}

/** Drop the oldest entries past `limit`. A Map keeps insertion order, and a rewrite moves its key last. */
function prune<Entry>(entries: Map<string, Entry>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

async function write(current: StoreState): Promise<void> {
  current.dirty = false;
  const temporaryPath = `${current.filePath}.${process.pid}.tmp`;
  const content = JSON.stringify({
    schema: STORE_SCHEMA,
    probes: [...current.probes.values()],
    inventory: [...current.inventory.values()],
  });
  try {
    await fs.promises.mkdir(path.dirname(current.filePath), { recursive: true });
    await fs.promises.writeFile(temporaryPath, content, 'utf8');
    await fs.promises.rename(temporaryPath, current.filePath);
  } catch {
    // report-ok: a cache of probe answers. A failed write costs the next launch its probes and nothing else.
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {
      // report-ok: the temp file is rewritten by the next write.
    });
  }
}

function scheduleWrite(current: StoreState): void {
  current.dirty = true;
  if (current.writeTimer || current.writing) return;
  current.writeTimer = setTimeout(() => {
    current.writeTimer = null;
    void runWrite(current);
  }, WRITE_DEBOUNCE_MS);
  current.writeTimer.unref?.();
}

function runWrite(current: StoreState): Promise<void> {
  // The file is read before it is first replaced, so a write never drops what a launch has not looked at yet.
  current.writing ??= loaded(current)
    .then(() => write(current))
    .finally(() => {
      current.writing = null;
      if (current.dirty && state === current) scheduleWrite(current);
    });
  return current.writing;
}

/** What `key`'s file answered last time, or null. The caller compares `files` with the file as it is now. */
export async function rememberedProbe(key: ProbeKey): Promise<RememberedProbe | null> {
  const current = state;
  if (!current) return null;
  await loaded(current);
  return current.probes.get(probeKeyOf(key)) ?? null;
}

/** Keep what a live probe just answered. */
export function recordProbe(probe: RememberedProbe): void {
  const current = state;
  if (!current) return;
  const key = probeKeyOf(probe);
  current.probes.delete(key);
  current.probes.set(key, probe);
  prune(current.probes, MAX_PROBES);
  scheduleWrite(current);
}

/** An agent's sign-in state and capabilities the last time they were read at this path and version, or null. */
export async function rememberedInventory(key: InventoryKey): Promise<RememberedInventory | null> {
  const current = state;
  if (!current) return null;
  await loaded(current);
  return current.inventory.get(inventoryKeyOf(key)) ?? null;
}

/** Keep what a live read of an agent's sign-in state and capabilities just returned. */
export function recordInventory(entry: RememberedInventory): void {
  const current = state;
  if (!current) return;
  // One entry per agent and path: an upgrade replaces the old version's entry.
  for (const [key, existing] of current.inventory) {
    if (existing.agent === entry.agent && pathKey(existing.path) === pathKey(entry.path)) current.inventory.delete(key);
  }
  current.inventory.set(inventoryKeyOf(entry), entry);
  prune(current.inventory, MAX_INVENTORY);
  scheduleWrite(current);
}

/** Tests only: write now and wait for it. */
export async function flushAgentProbeStoreForTests(): Promise<void> {
  const current = state;
  if (!current) return;
  await current.writing;
  // After the wait: a write that finished with more to save re-arms the timer.
  if (current.writeTimer) {
    clearTimeout(current.writeTimer);
    current.writeTimer = null;
  }
  if (current.dirty) await runWrite(current);
}

/** Tests only: turn the store off and forget everything it held. */
export function resetAgentProbeStoreForTests(): void {
  if (state?.writeTimer) clearTimeout(state.writeTimer);
  state = null;
}
