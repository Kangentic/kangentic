import os from 'node:os';
import { spawnCli, stopCli } from '../../shared/cli-print';
import type { CliTarget } from '../../shared/cli-target';
import type { CliChildProcess } from '../../../utility-process/off-main-cli';
import { shimFamilyKey } from '../../shared/shim-family-key';
import { converseWithAppServer, type AppServerConversation } from './app-server-rpc';

/**
 * Codex's own model list, read from `codex app-server`'s `model/list`.
 *
 * The request and response are `ModelListParams` and `Model` in
 * `codex-rs/app-server-protocol/src/protocol/v2/model.rs`
 * (https://raw.githubusercontent.com/openai/codex/rust-v0.163.0/codex-rs/app-server-protocol/src/protocol/v2/model.rs).
 * A logged-out codex-cli 0.163.0 on Windows answered it with its whole list,
 * captured in `tests/fixtures/codex-app-server-model-list.json`; a signed-in
 * one has not been read yet. https://learn.chatgpt.com/docs/app-server says
 * "Available models, reasoning efforts, and defaults depend on the client and
 * account". The read therefore runs on the user's real `CODEX_HOME` (never a
 * scratch one, unlike the hook trust read), and it may reach the network. A
 * Codex in a WSL distro is asked there, on the distro's own home.
 *
 * It is the source for three things the CLI cannot otherwise be asked for: the
 * model ids its picker offers, their display names, and the reasoning efforts
 * each one advertises (`supportedReasoningEfforts`). Codex has no effort flag
 * and no `--help` list of levels, and `cli-features-over-custom-layers.md`
 * rules out keeping our own list, so without this read the Effort row stays
 * hidden, as it was.
 */

/** What `model/list` told us, in the CLI's own order. */
export interface CodexModelCatalog {
  /** The `model` id of each listed, non-hidden entry: what `--model` takes. */
  models: string[];
  /** `displayName` by model id, where Codex gave one. */
  displayNames: Record<string, string>;
  /** Every `supportedReasoningEfforts[].reasoningEffort`, deduplicated in first-seen order. */
  effortLevels: string[];
  /** The levels each model advertises, by model id. */
  effortsByModel: Record<string, string[]>;
}

/**
 * Whether Codex's own list says `model` takes `effort`: that model's levels
 * when the catalog lists the model, else any listed model's (a model chosen
 * by free text, or the CLI's default when none is set). A level no listed
 * model advertises is never passed. The spawn's effort can be a value set for
 * another agent (a column whose agent changed keeps its effort, and an MCP
 * override is accepted unchecked for an agent that listed no levels), and
 * Codex had always ignored it, so nothing it does not list goes through.
 */
export function catalogAcceptsEffort(catalog: CodexModelCatalog, effort: string, model?: string | null): boolean {
  const modelId = model?.trim();
  // An own key only: a free-text model such as `constructor` must not find Object.prototype's.
  const modelLevels = modelId && Object.hasOwn(catalog.effortsByModel, modelId) ? catalog.effortsByModel[modelId] : undefined;
  return (modelLevels ?? catalog.effortLevels).includes(effort);
}

/** Longest one read may run before it counts as failed. A cold app-server start took up to the hook trust read's bound. */
const CATALOG_READ_TIMEOUT_MS = 20_000;

/** How long a read is kept before the next discovery reads again. */
export const CATALOG_TTL_MS = 12 * 60 * 60_000;

/** How long a read that failed is kept before the next discovery tries again. */
export const FAILED_READ_RETRY_MS = 5 * 60_000;

/**
 * How soon after a read settles a forced refresh may start another. A model
 * dropdown forces one each time it opens, and each read spawns an app-server
 * that may reach the network.
 */
const FORCED_REFRESH_MIN_MS = 60_000;

/** How long `discoverCapabilities` waits for a read before answering without it. */
export const CATALOG_DISCOVERY_WAIT_MS = 8_000;

/** Largest number of pages one read follows. Each page is one request; a real list fits one. */
const MAX_PAGES = 5;

/**
 * Turn a `model/list` result into a catalog, or null when it is not one. Only
 * entries with a string `model` count, and a `hidden` entry is left out (the
 * request already asks for none). Exported for tests.
 */
export function modelCatalogOf(results: readonly unknown[]): CodexModelCatalog | null {
  const models: string[] = [];
  // Maps, turned into objects at the end: an id is Codex's text, and assigning
  // `__proto__` on a plain object would replace its prototype, not add a key.
  const displayNames = new Map<string, string>();
  const effortLevels: string[] = [];
  const effortsByModel = new Map<string, string[]>();
  let sawPage = false;
  for (const result of results) {
    if (!isRecord(result) || !Array.isArray(result.data)) return null;
    sawPage = true;
    for (const entry of result.data) {
      if (!isRecord(entry) || entry.hidden === true) continue;
      const model = typeof entry.model === 'string' && entry.model.length > 0
        ? entry.model
        : typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null;
      if (!model || models.includes(model)) continue;
      models.push(model);
      if (typeof entry.displayName === 'string' && entry.displayName.trim().length > 0) {
        displayNames.set(model, entry.displayName.trim());
      }
      const modelLevels: string[] = [];
      effortsByModel.set(model, modelLevels);
      if (!Array.isArray(entry.supportedReasoningEfforts)) continue;
      for (const option of entry.supportedReasoningEfforts) {
        const level = isRecord(option) ? option.reasoningEffort : option;
        if (typeof level !== 'string' || level.length === 0) continue;
        if (!modelLevels.includes(level)) modelLevels.push(level);
        if (!effortLevels.includes(level)) effortLevels.push(level);
      }
    }
  }
  if (!sawPage) return null;
  // `Object.fromEntries` defines each key as an own property, `__proto__` included.
  return { models, displayNames: Object.fromEntries(displayNames), effortLevels, effortsByModel: Object.fromEntries(effortsByModel) };
}

/** The `nextCursor` a page names, or null at the end. */
function nextCursorOf(result: unknown): string | null {
  return isRecord(result) && typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : null;
}

/**
 * `model/list` page by page over one app-server conversation. Resolves the
 * pages' results; rejects on an error answer, an exit before the answer, or
 * the bound.
 */
function listModelPages(child: CliChildProcess, timeoutMs: number): Promise<unknown[]> {
  const pages: unknown[] = [];
  let pageRequestId = 2;
  const requestPage = (conversation: AppServerConversation<unknown[]>, cursor: string | null): void => {
    conversation.send({ jsonrpc: '2.0', id: pageRequestId, method: 'model/list', params: { includeHidden: false, ...(cursor ? { cursor } : {}) } });
  };
  return converseWithAppServer<unknown[]>(
    child,
    timeoutMs,
    (conversation) => requestPage(conversation, null),
    (message, conversation) => {
      if (message.id !== pageRequestId) return;
      if (message.error) {
        conversation.reject(new Error('model/list failed'));
        return;
      }
      pages.push(message.result);
      const cursor = nextCursorOf(message.result);
      if (cursor && pages.length < MAX_PAGES) {
        pageRequestId += 1;
        requestPage(conversation, cursor);
      } else {
        conversation.resolve(pages);
      }
    },
  );
}

/**
 * Ask the binary at `codexPath` for its model list. Resolves null when Codex
 * answered with something that is not a list, and rejects when the run failed.
 */
export async function readCodexModelCatalog(
  codexPath: string,
  target: CliTarget | null = null,
  spawn: typeof spawnCli = spawnCli,
  timeoutMs: number = CATALOG_READ_TIMEOUT_MS,
): Promise<CodexModelCatalog | null> {
  // No CODEX_HOME override: the list is the account's. The working folder is
  // the OS temp folder, so the read is tied to no project.
  const child = spawn(codexPath, ['app-server'], os.tmpdir(), undefined, target);
  try {
    return modelCatalogOf(await listModelPages(child, timeoutMs));
  } finally {
    stopCli(child);
  }
}

interface CatalogRead {
  pending: Promise<CodexModelCatalog | null>;
  catalog: CodexModelCatalog | null;
  settled: boolean;
  /** When the read settled. */
  settledAt: number;
  /** True when the run itself failed, which is retried sooner. */
  failed: boolean;
}

/**
 * The cached reads, one per binary (a `.cmd` shim and the sibling a spawn
 * launches share one, `shimFamilyKey`). `start` begins one (from `detect`, and
 * from discovery when none is fresh), `wait` gives discovery what is there
 * within a bound, `settle` lets a spawn wait for reads in flight, and
 * `catalogFor` and `displayNameOf` answer at once.
 */
export class CodexModelCatalogCache {
  private readonly reads = new Map<string, CatalogRead>();

  constructor(
    private readonly read: (codexPath: string, target: CliTarget | null) => Promise<CodexModelCatalog | null> = (codexPath, target) => readCodexModelCatalog(codexPath, target),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Begin a read for `codexPath` unless a fresh one exists or one is running.
   * `force` starts a new one unless one is running or the last settled under
   * `FORCED_REFRESH_MIN_MS` ago.
   */
  start(codexPath: string, target: CliTarget | null = null, force = false): void {
    const key = shimFamilyKey(codexPath);
    const existing = this.reads.get(key);
    if (existing && !existing.settled) return;
    if (existing && !this.isStale(existing)) {
      if (!force || this.now() - existing.settledAt < FORCED_REFRESH_MIN_MS) return;
    }
    const catalogRead: CatalogRead = { pending: Promise.resolve(null), catalog: existing?.catalog ?? null, settled: false, settledAt: 0, failed: false };
    catalogRead.pending = this.read(codexPath, target)
      .then((catalog) => {
        catalogRead.catalog = catalog ?? catalogRead.catalog;
        return catalogRead.catalog;
      })
      .catch((error: unknown) => {
        catalogRead.failed = true;
        console.warn(`[codex] model list read failed: ${error instanceof Error ? error.message : String(error)}`);
        return catalogRead.catalog;
      })
      .finally(() => {
        catalogRead.settled = true;
        catalogRead.settledAt = this.now();
      });
    this.reads.set(key, catalogRead);
  }

  /** The catalog a read for `codexPath` (or a shim sibling of it) has given so far, or null. */
  catalogFor(codexPath: string): CodexModelCatalog | null {
    return this.reads.get(shimFamilyKey(codexPath))?.catalog ?? null;
  }

  /** Whether the read for `codexPath` has finished, so its answer is final until the next read. */
  isSettled(codexPath: string): boolean {
    return this.reads.get(shimFamilyKey(codexPath))?.settled ?? false;
  }

  /** Wait, at most `timeoutMs`, for every read in flight. */
  async settle(timeoutMs: number): Promise<void> {
    const pending = [...this.reads.values()].filter((catalogRead) => !catalogRead.settled).map((catalogRead) => catalogRead.pending);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** The catalog for `codexPath`, waiting at most `timeoutMs` for a read in flight; null when there is none. */
  async wait(codexPath: string, timeoutMs: number): Promise<CodexModelCatalog | null> {
    const catalogRead = this.reads.get(shimFamilyKey(codexPath));
    if (!catalogRead) return null;
    if (catalogRead.settled) return catalogRead.catalog;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<CodexModelCatalog | null>((resolve) => {
      timer = setTimeout(() => resolve(catalogRead.catalog), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([catalogRead.pending, bounded]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** The display name Codex gave `modelId` in any read so far, or null. */
  displayNameOf(modelId: string): string | null {
    for (const catalogRead of this.reads.values()) {
      const displayNames = catalogRead.catalog?.displayNames;
      if (displayNames && Object.hasOwn(displayNames, modelId)) return displayNames[modelId];
    }
    return null;
  }

  private isStale(catalogRead: CatalogRead): boolean {
    const age = this.now() - catalogRead.settledAt;
    return age >= (catalogRead.failed ? FAILED_READ_RETRY_MS : CATALOG_TTL_MS);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
