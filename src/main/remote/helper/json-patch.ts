/**
 * A small declarative edit of a JSON file on the host, applied by the helper under a lock (#913).
 *
 * Some files an agent CLI keeps on its host are shared with the CLI itself, which rewrites them while
 * it runs and guards them with its own lock (Claude's `~/.claude.json`). Kangentic edits them before a
 * spawn, as it does on this computer: read, change, write, all under that lock. The app cannot do the
 * read-modify-write across a link, so it sends the edit as data and the helper applies it. The ops
 * are generic, so the helper needs no knowledge of any one CLI.
 *
 * A file that exists but is not a JSON object is left untouched (it holds the user's own state, and a
 * torn read must never be written back), and a lock that stays held past its budget skips the write,
 * which is the CLI's own policy on a final lock failure.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { JsonPatchOp, JsonPatchRequest, JsonPatchResult, JsonPointer } from '../protocol/messages';

// The request and result types live in the protocol, which both sides import; re-exported for the helper's callers.
export type { JsonPatchOp, JsonPatchRequest, JsonPatchResult, JsonPointer };

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const LOCK_STALE_MS = 10_000;
const LOCK_BUDGET_MS = 12_000;
const LOCK_RETRY_LADDER_MS = [50, 100, 200, 400, 800];

export class JsonPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafe(pointer: JsonPointer): void {
  if (pointer.length === 0) throw new JsonPatchError('A patch path needs at least one key.');
  for (const segment of pointer) {
    if (typeof segment !== 'string' || FORBIDDEN_SEGMENTS.has(segment)) throw new JsonPatchError(`The key ${String(segment)} cannot be patched.`);
  }
}

/** The object holding the pointer's last key, made along the way; throws when a step is not an object. */
function parentOf(root: Record<string, unknown>, pointer: JsonPointer, create: boolean): Record<string, unknown> | null {
  let current = root;
  for (const segment of pointer.slice(0, -1)) {
    const next = ownValue(current, segment);
    if (next === undefined) {
      if (!create) return null;
      const made: Record<string, unknown> = {};
      current[segment] = made;
      current = made;
    } else if (isObject(next)) {
      current = next;
    } else {
      throw new JsonPatchError(`${segment} is not an object, so the patch cannot go through it.`);
    }
  }
  return current;
}

function clone(value: unknown): unknown {
  if (value === undefined) throw new JsonPatchError('The patch has no value to write.');
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The file's own value at a key. A parsed object inherits `toString` and the like, which no file holds. */
function ownValue(parent: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(parent, key) ? parent[key] : undefined;
}

/** Apply the ops to a parsed object in place. True when anything changed. Throws `JsonPatchError` on a bad op or a step that is not an object. */
export function applyJsonPatch(root: Record<string, unknown>, ops: readonly JsonPatchOp[]): boolean {
  let changed = false;
  for (const op of ops) {
    assertSafe(op.at);
    const key = op.at[op.at.length - 1];
    switch (op.op) {
      case 'set': {
        const parent = parentOf(root, op.at, true);
        if (!parent) break;
        if (Object.hasOwn(parent, key) && JSON.stringify(parent[key]) === JSON.stringify(op.value)) break;
        parent[key] = clone(op.value);
        changed = true;
        break;
      }
      case 'setDefault': {
        const parent = parentOf(root, op.at, true);
        if (!parent || ownValue(parent, key) !== undefined) break;
        parent[key] = clone(op.value);
        changed = true;
        break;
      }
      case 'addToArray': {
        const parent = parentOf(root, op.at, true);
        if (!parent) break;
        const existing = ownValue(parent, key);
        if (existing !== undefined && !Array.isArray(existing)) throw new JsonPatchError(`${key} is not an array, so nothing can be added to it.`);
        const list = (existing as unknown[] | undefined) ?? [];
        if (list.some((item) => JSON.stringify(item) === JSON.stringify(op.value))) {
          if (existing === undefined) parent[key] = list;
          break;
        }
        parent[key] = [...list, clone(op.value)];
        changed = true;
        break;
      }
      case 'copyIfAbsent': {
        assertSafe(op.from);
        const parent = parentOf(root, op.at, true);
        if (!parent || ownValue(parent, key) !== undefined) break;
        const source = parentOf(root, op.from, false);
        const found = source ? ownValue(source, op.from[op.from.length - 1]) : undefined;
        parent[key] = clone(Array.isArray(found) ? found : op.fallback);
        changed = true;
        break;
      }
      default: {
        const unknownOp: never = op;
        throw new JsonPatchError(`Unknown patch operation: ${JSON.stringify(unknownOp)}`);
      }
    }
  }
  return changed;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** The locks a request of this program is breaking now. */
const breakingLocks = new Set<string>();

function lockAge(lockDirectory: string): Promise<number> {
  return fs.stat(lockDirectory).then((stats) => Date.now() - stats.mtimeMs, () => 0);
}

/**
 * Take a stale lock by removing it and making it again, and say whether this call holds it now. One request at
 * a time, and the age is read again inside that: two requests that both saw the old lock would otherwise have
 * the second remove the fresh lock the first just took, and both would go on. A lock that cannot be removed
 * (something inside it) is not taken.
 */
async function takeStaleLock(lockDirectory: string): Promise<boolean> {
  if (breakingLocks.has(lockDirectory)) return false;
  breakingLocks.add(lockDirectory);
  try {
    if (await lockAge(lockDirectory) <= LOCK_STALE_MS) return false;
    const removed = await fs.rmdir(lockDirectory).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
    if (!removed) return false;
    return await fs.mkdir(lockDirectory).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        return false;
      },
    );
  } finally {
    breakingLocks.delete(lockDirectory);
  }
}

/** Take a lock by `mkdir`, breaking one older than the stale age. False when it stays held past the budget. */
async function acquireLock(lockDirectory: string): Promise<boolean> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(lockDirectory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await lockAge(lockDirectory) > LOCK_STALE_MS && await takeStaleLock(lockDirectory)) return true;
    if (Date.now() - startedAt >= LOCK_BUDGET_MS) return false;
    await delay(LOCK_RETRY_LADDER_MS[Math.min(attempt, LOCK_RETRY_LADDER_MS.length - 1)]);
  }
}

let stagingCounter = 0;

/** Read, patch and write one JSON file under the request's lock. See the file comment for what it leaves alone. */
export async function patchJsonFile(request: JsonPatchRequest): Promise<JsonPatchResult> {
  const locked = request.lockDirectory ? await acquireLock(request.lockDirectory) : true;
  if (!locked) return { applied: false, changed: false, reason: 'locked' };
  try {
    let raw: string | null;
    try {
      raw = await fs.readFile(request.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { applied: false, changed: false, reason: 'unreadable' };
      raw = null;
    }
    let data: Record<string, unknown>;
    if (raw === null) {
      data = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { applied: false, changed: false, reason: 'not-an-object' };
      }
      if (!isObject(parsed)) return { applied: false, changed: false, reason: 'not-an-object' };
      data = parsed;
    }
    let changed: boolean;
    try {
      changed = applyJsonPatch(data, request.ops);
    } catch (error) {
      if (error instanceof JsonPatchError) return { applied: false, changed: false, reason: 'bad-patch' };
      throw error;
    }
    if (!changed) return { applied: true, changed: false };
    // Written through a link's target, with the file's own mode, so a symlinked file stays a link and a
    // 0600 file holding the user's auth does not come back with the umask's default.
    const target = await fs.realpath(request.path).catch(() => request.path);
    const mode = await fs.stat(target).then((stats) => stats.mode & 0o777, () => 0o600);
    await fs.mkdir(path.dirname(target), { recursive: true });
    stagingCounter += 1;
    const staging = `${target}.kangentic-${process.pid}-${stagingCounter}.tmp`;
    try {
      await fs.writeFile(staging, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
      await fs.rename(staging, target);
    } finally {
      await fs.rm(staging, { force: true }).catch(() => undefined);
    }
    return { applied: true, changed: true };
  } finally {
    if (request.lockDirectory) await fs.rmdir(request.lockDirectory).catch(() => undefined);
  }
}
