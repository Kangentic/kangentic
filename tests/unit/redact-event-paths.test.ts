/**
 * src/main/analytics/redact-event-paths.ts rewrites this machine's home directory to `~` in
 * every string of a Sentry event before it leaves the machine.
 *
 * The leak it closes was measured on production events: Monaco's rethrown diff-editor error put
 * about 48 `file:///C:/Users/<name>/...` paths into the exception VALUE, which the SDK's path
 * normalization never touches (it rewrites stack frames only), and an OS username is often a real
 * name. The cases below use the field names where real leaks were found, a Windows home with both
 * separators and a POSIX home, and the failure modes a privacy rewrite must not have: dropping an
 * event, throwing, or rewriting someone else's path.
 *
 * It also rewrites every registered project root to `[project]`. A spawn that failed on a full
 * disk sent a session directory under a project on another drive to Sentry whole, issue title
 * included (DESKTOP-21), because the home rewrite never reached that drive. The cases pass the
 * roots and the case flag explicitly, so the Windows cases run on Linux CI too.
 */

import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';
import { PROJECT_ROOT_PLACEHOLDER, redactEventPaths } from '../../src/main/analytics/redact-event-paths';
import { pathPattern } from '../../src/main/utility-process/stderr-tail';

const WINDOWS_HOME = 'C:\\Users\\dev';
const POSIX_HOME = '/home/dev';
const OTHER_DRIVE_ROOT = 'D:\\work\\client-app';
const POSIX_PROJECT_ROOT = '/mnt/data/client-app';

/** A spawn failure shaped like DESKTOP-21's, with the project root in the three fields the issue
 *  carried it in: the exception value, the message, and a context. */
function spawnFailureEvent(exceptionPath: string, messagePath: string, contextPath: string): ErrorEvent {
  return {
    exception: {
      values: [{ type: 'Error', value: `Cannot create session directory at ${exceptionPath}: ENOSPC` }],
    },
    message: `mkdir failed for ${messagePath}`,
    contexts: { spawn: { cwd: contextPath } },
  };
}

function fieldsOf(event: ErrorEvent): string[] {
  return [
    event.exception?.values?.[0].value ?? '',
    event.message ?? '',
    String((event.contexts?.spawn as { cwd: string }).cwd),
  ];
}

describe('redactEventPaths: project roots (DESKTOP-21)', () => {
  it('removes a project root on another drive from the exception value, the message and a context', () => {
    const event = spawnFailureEvent(
      'D:\\work\\client-app\\.kangentic\\sessions\\abc',
      'file:///D:/work/client-app/.kangentic/sessions/abc',
      'D:/work/client-app',
    );
    redactEventPaths(event, WINDOWS_HOME, false, [OTHER_DRIVE_ROOT]);
    for (const field of fieldsOf(event)) {
      expect(field).not.toMatch(/client-app/i);
      expect(field).toContain(PROJECT_ROOT_PLACEHOLDER);
    }
    expect(event.exception?.values?.[0].value).toBe(
      'Cannot create session directory at [project]\\.kangentic\\sessions\\abc: ENOSPC',
    );
    expect(event.message).toBe('mkdir failed for file:///[project]/.kangentic/sessions/abc');
  });

  it('matches a case-changed root when the filesystem is case-insensitive, and only then', () => {
    const insensitive = spawnFailureEvent('d:\\WORK\\Client-App\\x', 'D:/Work/CLIENT-APP/y', 'd:\\work\\client-APP');
    redactEventPaths(insensitive, WINDOWS_HOME, true, [OTHER_DRIVE_ROOT]);
    for (const field of fieldsOf(insensitive)) expect(field).not.toMatch(/client-app/i);

    const sensitive = spawnFailureEvent('d:\\WORK\\Client-App\\x', 'D:/Work/CLIENT-APP/y', 'd:\\work\\client-APP');
    redactEventPaths(sensitive, WINDOWS_HOME, false, [OTHER_DRIVE_ROOT]);
    expect(sensitive.message).toBe('mkdir failed for D:/Work/CLIENT-APP/y');
  });

  it('removes a POSIX project root', () => {
    const event = spawnFailureEvent(
      '/mnt/data/client-app/.kangentic/sessions/abc',
      '/mnt/data/client-app/.kangentic/worktrees/12',
      '/mnt/data/client-app',
    );
    redactEventPaths(event, POSIX_HOME, false, [POSIX_PROJECT_ROOT]);
    for (const field of fieldsOf(event)) expect(field).not.toContain('client-app');
    expect(event.message).toBe('mkdir failed for [project]/.kangentic/worktrees/12');
  });

  it('removes the folder name of a project under the home directory instead of leaving ~/projects/<name>', () => {
    const event: ErrorEvent = { message: 'failed in C:\\Users\\dev\\projects\\client-app\\.kangentic and C:\\Users\\dev\\other' };
    redactEventPaths(event, WINDOWS_HOME, true, ['C:\\Users\\dev\\projects\\client-app']);
    expect(event.message).toBe('failed in [project]\\.kangentic and ~\\other');
  });

  it('removes the folder name from text already home-redacted at capture, such as a worker stderr tail', () => {
    // StderrTail.snapshot rewrites home to `~` before the event is built, so the absolute root
    // pattern finds nothing to match by the time this pass runs.
    const event: ErrorEvent = {
      contexts: { utility_process: { stderr: 'at ~\\Projects\\Client-App\\x.js and ~/projects/client-app-old/y.js' } },
    };
    redactEventPaths(event, WINDOWS_HOME, true, ['C:\\Users\\dev\\projects\\client-app']);
    expect((event.contexts?.utility_process as { stderr: string }).stderr).toBe(
      'at [project]\\x.js and ~/projects/client-app-old/y.js',
    );
  });

  it('matches the longest root first, so a project nested in another keeps no outer folder name', () => {
    const event: ErrorEvent = { message: 'D:\\work\\client-app\\.kangentic\\worktrees\\7\\x' };
    redactEventPaths(event, WINDOWS_HOME, true, [OTHER_DRIVE_ROOT, 'D:\\work\\client-app\\.kangentic\\worktrees\\7']);
    expect(event.message).toBe('[project]\\x');
  });

  it('leaves a sibling folder that merely starts with the root alone', () => {
    const event: ErrorEvent = { message: 'D:\\work\\client-app-old\\x and D:\\work\\client-app\\y' };
    redactEventPaths(event, WINDOWS_HOME, true, [OTHER_DRIVE_ROOT]);
    expect(event.message).toBe('D:\\work\\client-app-old\\x and [project]\\y');
  });

  it('skips a root at or above the home directory, so the username still goes through the home rewrite', () => {
    const event: ErrorEvent = { message: 'C:\\Users\\dev\\x and C:\\Users\\shared\\y' };
    redactEventPaths(event, WINDOWS_HOME, true, ['C:\\Users', 'C:\\Users\\dev']);
    expect(event.message).toBe('~\\x and C:\\Users\\shared\\y');
  });

  it('skips a drive root, which would otherwise rewrite every path on the drive', () => {
    const event: ErrorEvent = { message: 'D:\\anything\\x and /var/log/y' };
    redactEventPaths(event, WINDOWS_HOME, true, ['D:\\', '/', '']);
    expect(event.message).toBe('D:\\anything\\x and /var/log/y');
  });

  it('removes a percent-encoded spelling of a root with a space and an accent in it', () => {
    const root = 'D:\\Client Work\\Soci\u00e9t\u00e9';
    const event = spawnFailureEvent(
      'file:///D:/Client%20Work/Soci%C3%A9t%C3%A9/a.ts',
      'file:///d%3A/Client%20Work/Soci%c3%a9t%c3%a9/b.ts',
      '?path=D%3A%5CClient%20Work%5CSoci%C3%A9t%C3%A9%5Cc',
    );
    redactEventPaths(event, WINDOWS_HOME, true, [root]);
    for (const field of fieldsOf(event)) {
      expect(field).not.toMatch(/Client|Soci/i);
      expect(field).toContain(PROJECT_ROOT_PLACEHOLDER);
    }
    expect(event.message).toBe('mkdir failed for file:///[project]/b.ts');
  });

  // `!`, `'`, `(` and `)` are raw in `encodeURIComponent` but `URLSearchParams` writes them
  // `%21`, `%27`, `%28` and `%29`, and a space as `+`. Each spelling is a different string.
  it('removes a root holding !\'() in its raw, encodeURIComponent and URLSearchParams spellings', () => {
    const root = "D:\\Client (1)\\App's!";
    const formEncoded = new URLSearchParams({ path: root }).toString();
    expect(formEncoded).toBe('path=D%3A%5CClient+%281%29%5CApp%27s%21');
    expect(() => pathPattern(root, true)).not.toThrow();

    const event: ErrorEvent = {
      message: "failed in D:\\Client (1)\\App's!\\x",
      exception: { values: [{ type: 'Error', value: `bad ${encodeURIComponent(root)}%5Cx` }] },
      contexts: { spawn: { cwd: `${formEncoded}&next=1` } },
    };
    redactEventPaths(event, WINDOWS_HOME, true, [root]);
    expect(event.message).toBe('failed in [project]\\x');
    expect(event.exception?.values?.[0].value).toBe('bad [project]%5Cx');
    expect((event.contexts?.spawn as { cwd: string }).cwd).toBe('path=[project]&next=1');
  });

  it('removes a root whose * and ~ are percent-encoded', () => {
    const root = 'D:\\Odd*Name~1';
    const event: ErrorEvent = {
      message: 'D:\\Odd*Name~1\\x and D%3A%5COdd%2AName%7E1%5Cy and d%3a%5cODD%2aNAME%7e1%5cz',
    };
    redactEventPaths(event, WINDOWS_HOME, true, [root]);
    expect(event.message).toBe('[project]\\x and [project]%5Cy and [project]%5cz');
  });

  // A lone surrogate has no UTF-8 encoding, so it matches only as written. Encoded as UTF-8 it
  // would become U+FFFD (`%EF%BF%BD`), which would match any replacement character.
  it('redacts a root holding a lone surrogate as written only, and still redacts the rest of the event', () => {
    const root = 'D:\\work\\a\uD800b';
    expect(() => pathPattern(root, true)).not.toThrow();
    expect(pathPattern(root, true)).toBeInstanceOf(RegExp);

    const event: ErrorEvent = {
      message: `failed in ${root}\\x`,
      tags: { source: 'C:\\Users\\dev\\y', replacement: 'D%3A%5Cwork%5Ca%EF%BF%BDb%5Cx' },
    };
    redactEventPaths(event, WINDOWS_HOME, true, [root]);
    expect(event.message).toBe('failed in [project]\\x');
    expect(event.tags?.source).toBe('~\\y');
    expect(event.tags?.replacement).toBe('D%3A%5Cwork%5Ca%EF%BF%BDb%5Cx');
  });

  it('removes a one-segment POSIX root, which is not a drive root', () => {
    const event: ErrorEvent = { message: '/client-app/x and /client-app-old/y and /var/log/z' };
    redactEventPaths(event, POSIX_HOME, false, ['/', '/client-app']);
    expect(event.message).toBe('[project]/x and /client-app-old/y and /var/log/z');
  });

  it('is idempotent across both rewrites', () => {
    const event: ErrorEvent = { message: 'D:\\work\\client-app\\x and C:\\Users\\dev\\y' };
    redactEventPaths(event, WINDOWS_HOME, true, [OTHER_DRIVE_ROOT]);
    redactEventPaths(event, WINDOWS_HOME, true, [OTHER_DRIVE_ROOT]);
    expect(event.message).toBe('[project]\\x and ~\\y');
  });
});

describe('redactEventPaths: where it looks', () => {
  it('rewrites an exception value, the field a real production leak sat in', () => {
    const event: ErrorEvent = {
      exception: {
        values: [
          {
            type: 'Error',
            value: "Illegal value at file:///C:/Users/dev/AppData/Local/x.js:1 and 'C:\\Users\\dev\\y.js'",
          },
        ],
      },
    };
    redactEventPaths(event, WINDOWS_HOME, true);
    expect(event.exception?.values?.[0].value).toBe("Illegal value at file:///~/AppData/Local/x.js:1 and '~\\y.js'");
  });

  it('walks the whole event, not a list of fields', () => {
    const event = {
      message: 'failed in C:\\Users\\dev\\proj',
      tags: { source: 'C:\\Users\\dev\\tag' },
      extra: { note: 'C:/Users/dev/extra', nested: { deep: ['C:\\Users\\dev\\a', 3, null] } },
      contexts: { electron: { 'crashpad.gpu-url-chunk': 'file:///C:/Users/dev/AppData/index.html' } },
      breadcrumbs: [{ message: 'opened C:\\Users\\dev\\p', data: { cwd: 'C:\\Users\\dev' } }],
      exception: { values: [{ stacktrace: { frames: [{ abs_path: 'C:\\Users\\dev\\proj\\a.js' }] } }] },
    } as unknown as ErrorEvent;
    redactEventPaths(event, WINDOWS_HOME, true);
    expect(JSON.stringify(event)).not.toMatch(/Users[\\/]+dev/i);
    expect(event.tags?.source).toBe('~\\tag');
    expect((event.extra as { nested: { deep: unknown[] } }).nested.deep).toEqual(['~\\a', 3, null]);
    expect((event.breadcrumbs ?? [])[0].data).toEqual({ cwd: '~' });
  });

  // Electron 44.5's install-folder ACL check (electron/electron#54484) aborts with a FATAL that
  // names the per-user install folder, which sits under the home directory, and the icacls
  // command to fix it. A LOG(FATAL) reaches the dump as a Crashpad annotation, and the SDK copies
  // those into contexts.electron on THIS machine, before beforeSend, so this pass covers it.
  it('rewrites the install folder in a Crashpad LOG_FATAL annotation', () => {
    const installFolder = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic';
    const event = {
      contexts: {
        electron: {
          'crashpad.LOG_FATAL':
            `The sandbox cannot read ${installFolder}\\icudtl.dat. Run: icacls "${installFolder}" /grant *S-1-15-2-1:(OI)(CI)(RX)`,
        },
      },
    } as unknown as ErrorEvent;
    redactEventPaths(event, WINDOWS_HOME, true);
    const annotation = (event.contexts?.electron as Record<string, string>)['crashpad.LOG_FATAL'];
    expect(annotation).not.toMatch(/Users[\\/]+dev/i);
    expect(annotation).toContain('~\\AppData\\Local\\Programs\\Kangentic\\icudtl.dat');
  });

  it('rewrites a POSIX home directory', () => {
    const event: ErrorEvent = { message: 'EACCES: open /home/dev/.config/kangentic/config.json' };
    redactEventPaths(event, POSIX_HOME, false);
    expect(event.message).toBe('EACCES: open ~/.config/kangentic/config.json');
  });
});

describe('redactEventPaths: what it leaves alone', () => {
  it('does not touch another user, or a longer name that merely starts with the home path', () => {
    const event: ErrorEvent = { message: '/home/developer/x and /home/other/y and /home/dev/z' };
    redactEventPaths(event, POSIX_HOME, false);
    expect(event.message).toBe('/home/developer/x and /home/other/y and ~/z');
  });

  it('matches Windows letter case only when told the filesystem is case-insensitive', () => {
    const sensitive: ErrorEvent = { message: 'c:\\users\\dev\\x' };
    redactEventPaths(sensitive, WINDOWS_HOME, false);
    expect(sensitive.message).toBe('c:\\users\\dev\\x');

    const insensitive: ErrorEvent = { message: 'c:\\users\\dev\\x' };
    redactEventPaths(insensitive, WINDOWS_HOME, true);
    expect(insensitive.message).toBe('~\\x');
  });

  it('leaves non-string values, keys and an empty home directory alone', () => {
    const event = { message: 'C:\\Users\\dev', level: 'error', extra: { count: 4, flag: true, nothing: null } } as unknown as ErrorEvent;
    redactEventPaths(event, '', true);
    expect(event.message).toBe('C:\\Users\\dev');

    redactEventPaths(event, WINDOWS_HOME, true);
    expect(event.level).toBe('error');
    expect(event.extra).toEqual({ count: 4, flag: true, nothing: null });
  });

  it('leaves Date, Buffer and Uint8Array values intact: same instance, same bytes, never stringified', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    // The bytes spell a home path on purpose. They are binary payload, not text,
    // and a walk that decoded them would rewrite them.
    const buffer = Buffer.from('C:\\Users\\dev\\x');
    const view = new Uint8Array([1, 2, 3]);
    const event = { message: 'C:\\Users\\dev\\y', extra: { when, buffer, view } } as unknown as ErrorEvent;

    redactEventPaths(event, WINDOWS_HOME, true);

    const extra = event.extra as { when: Date; buffer: Buffer; view: Uint8Array };
    expect(event.message).toBe('~\\y');
    expect(extra.when).toBe(when);
    expect(extra.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(extra.buffer).toBe(buffer);
    expect(Buffer.isBuffer(extra.buffer)).toBe(true);
    expect(extra.buffer.toString()).toBe('C:\\Users\\dev\\x');
    expect(extra.view).toBe(view);
    expect(Array.from(extra.view)).toEqual([1, 2, 3]);
  });

  it('is idempotent, so the breadcrumb policy and this pass can both run', () => {
    const event: ErrorEvent = { message: 'C:\\Users\\dev\\x' };
    redactEventPaths(event, WINDOWS_HOME, true);
    redactEventPaths(event, WINDOWS_HOME, true);
    expect(event.message).toBe('~\\x');
  });
});

describe('redactEventPaths: it never costs the event', () => {
  it('mutates and returns the same event object', () => {
    const event: ErrorEvent = { message: 'C:\\Users\\dev\\x' };
    expect(redactEventPaths(event, WINDOWS_HOME, true)).toBe(event);
  });

  it('survives a cyclic structure instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { text: 'C:\\Users\\dev\\x' };
    cyclic.self = cyclic;
    const event = { message: 'C:\\Users\\dev\\y', extra: cyclic } as unknown as ErrorEvent;
    expect(() => redactEventPaths(event, WINDOWS_HOME, true)).not.toThrow();
    expect(event.message).toBe('~\\y');
  });

  it('stops descending past its depth cap without throwing, and still reaches realistic nesting', () => {
    // Builds `extra` so that the object holding `text` sits `depth` levels below
    // the event. The cap only needs to be far from real event nesting (a few
    // levels), so this checks well inside it and well past it, not the exact edge.
    function eventWithTextAtDepth(depth: number): { event: ErrorEvent; readText: () => unknown } {
      let holder: Record<string, unknown> = { text: 'C:\\Users\\dev\\x' };
      const innermost = holder;
      for (let level = 1; level < depth; level += 1) holder = { child: holder };
      return {
        event: { extra: holder } as unknown as ErrorEvent,
        readText: () => innermost.text,
      };
    }

    const shallow = eventWithTextAtDepth(10);
    expect(() => redactEventPaths(shallow.event, WINDOWS_HOME, true)).not.toThrow();
    expect(shallow.readText()).toBe('~\\x');

    const tooDeep = eventWithTextAtDepth(40);
    expect(() => redactEventPaths(tooDeep.event, WINDOWS_HOME, true)).not.toThrow();
    expect(tooDeep.readText()).toBe('C:\\Users\\dev\\x');
  });

  it('survives a value whose property read throws, and still returns the event', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const event = { message: 'C:\\Users\\dev\\y', extra: hostile } as unknown as ErrorEvent;
    expect(() => redactEventPaths(event, WINDOWS_HOME, true)).not.toThrow();
    expect(redactEventPaths(event, WINDOWS_HOME, true)).toBe(event);
  });

  it('keeps redacting later fields after a frozen object and a throwing getter', () => {
    // Key order is the point: the fields that cannot be written or read come FIRST, so a walk that
    // aborts on them would leave `message` and `tags` below them unredacted.
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const event = {
      extra: Object.freeze({ note: 'hello', nested: Object.freeze({ deep: 'world' }) }),
      contexts: { hostile },
      message: 'C:\\Users\\dev\\y',
      tags: { source: 'C:\\Users\\dev\\z' },
    } as unknown as ErrorEvent;
    redactEventPaths(event, WINDOWS_HOME, true);
    expect(event.message).toBe('~\\y');
    expect(event.tags?.source).toBe('~\\z');
    expect(event.extra).toEqual({ note: 'hello', nested: { deep: 'world' } });
  });

  it('does not write back a value that did not change, so a read-only object is not an error', () => {
    const frozenExtra = Object.freeze({ note: 'nothing to redact here' });
    const event = { extra: frozenExtra, message: 'C:\\Users\\dev\\x' } as unknown as ErrorEvent;
    redactEventPaths(event, WINDOWS_HOME, true);
    expect(event.extra).toBe(frozenExtra);
    expect(event.message).toBe('~\\x');
  });
});
