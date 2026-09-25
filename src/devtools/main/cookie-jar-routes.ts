// Dev-only cookie experiment rig for the embedded Browser pane.
//
// The whole seeding question ("does copying a worktree's IdP cookies into
// another worktree's jar carry the login, or is Google's session device-bound?")
// is empirical and has to be answered against a live instance before any
// production seeding ships. There is no other way to run `session.cookies` in a
// running Kangentic today: the inspection server's /eval is renderer-only. These
// two routes are that surface.
//
// Dev-only: this whole tree is build-excluded via __KANGENTIC_DEV__, and the
// routes are additionally gated behind Allow Unsafe Operations (cookie values
// are credentials). Dev code may import from src/main; the reverse is forbidden,
// so the shared copy primitive lives in src/main/browser/cookie-seed.ts and this
// file is only a thin HTTP shim over it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, session, type Cookie } from 'electron';
import { partitionDirName } from '../../shared/browser-partition';
import { cookieDomainMatches, copyCookies } from '../../main/browser/cookie-seed';

interface JsonResponder {
  json: (statusCode: number, body: unknown) => void;
  error: (statusCode: number, kind: string, detail: string) => void;
}

class CookieJarRequestError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
  }
}

/** Read a required partition string. Jars are keyed by task identity now, so the
 *  rig addresses them by their full `persist:...` partition string (read it from
 *  the `[browser-pane] pane bound partition=...` log, or list a jar's dir). */
function resolvePartition(input: Record<string, unknown>, partitionKey: string, label: string): string {
  const partition = input[partitionKey];
  if (typeof partition === 'string' && partition) return partition;
  throw new CookieJarRequestError(
    'missing-target',
    `Provide "${partitionKey}" (a persist:... partition string) for the ${label}.`,
  );
}

/**
 * Whether the partition's jar directory already exists on disk. Computed BEFORE
 * any `session.fromPartition` call, which MATERIALIZES the directory - this is
 * both what keeps the rig honest and what validates the production seeder's
 * first-use detection in the same run.
 */
function jarExistsOnDisk(partition: string): boolean {
  const dir = path.join(app.getPath('userData'), 'Partitions', partitionDirName(partition));
  return fs.existsSync(dir);
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new CookieJarRequestError('invalid-domains', '"domains" must be an array of strings.');
  }
  return value as string[];
}

function redactCookie(cookie: Cookie, includeValues: boolean): Record<string, unknown> {
  return {
    name: cookie.name,
    domain: cookie.domain ?? null,
    path: cookie.path ?? null,
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    session: cookie.session ?? cookie.expirationDate === undefined,
    expirationDate: cookie.expirationDate ?? null,
    hostOnly: cookie.hostOnly ?? false,
    valueLength: cookie.value.length,
    value: includeValues ? cookie.value : undefined,
  };
}

async function handleList(input: Record<string, unknown>, responder: JsonResponder): Promise<void> {
  const partition = resolvePartition(input, 'partition', 'jar to list');
  const includeValues = input.includeValues === true;
  const domains = toStringArray(input.domains);

  const existedOnDisk = jarExistsOnDisk(partition);
  const jar = session.fromPartition(partition);
  const all = await jar.cookies.get({});
  const filtered = all.filter((cookie) => cookieDomainMatches(cookie.domain ?? '', domains));

  responder.json(200, {
    ok: true,
    partition,
    existedOnDisk,
    count: filtered.length,
    cookies: filtered.map((cookie) => redactCookie(cookie, includeValues)),
  });
}

async function handleCopy(input: Record<string, unknown>, responder: JsonResponder): Promise<void> {
  const sourcePartition = resolvePartition(input, 'sourcePartition', 'copy source');
  const targetPartition = resolvePartition(input, 'targetPartition', 'copy target');
  const domains = toStringArray(input.domains);
  if (!domains || domains.length === 0) {
    throw new CookieJarRequestError(
      'missing-domains',
      '"domains" is required for a copy so a full-jar copy can never happen by accident.',
    );
  }
  const includeLocal = input.includeLocal === true;

  const sourceExisted = jarExistsOnDisk(sourcePartition);
  const targetExisted = jarExistsOnDisk(targetPartition);
  const source = session.fromPartition(sourcePartition);
  const target = session.fromPartition(targetPartition);
  const result = await copyCookies(source, target, {
    includeDomains: domains,
    excludeLocal: !includeLocal,
  });

  responder.json(200, {
    ok: true,
    sourcePartition,
    targetPartition,
    sourceExisted,
    targetExisted,
    ...result,
  });
}

/**
 * Dispatch a cookie-jar rig route. `body` is the already-parsed JSON request
 * body; the caller is responsible for the eval-enabled gate and for rejecting a
 * malformed body BEFORE calling this.
 */
export async function respondCookieJar(
  route: string,
  body: unknown,
  responder: JsonResponder,
): Promise<void> {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  try {
    if (route === 'POST /cookie-jar-list') {
      await handleList(input, responder);
    } else {
      await handleCopy(input, responder);
    }
  } catch (error) {
    if (error instanceof CookieJarRequestError) {
      responder.error(400, error.kind, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    responder.error(500, 'cookie-jar-failed', message);
  }
}
