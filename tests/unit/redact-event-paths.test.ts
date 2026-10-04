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
 */

import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';
import { redactEventHomeDirectory } from '../../src/main/analytics/redact-event-paths';

const WINDOWS_HOME = 'C:\\Users\\dev';
const POSIX_HOME = '/home/dev';

describe('redactEventHomeDirectory: where it looks', () => {
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
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
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
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
    expect(JSON.stringify(event)).not.toMatch(/Users[\\/]+dev/i);
    expect(event.tags?.source).toBe('~\\tag');
    expect((event.extra as { nested: { deep: unknown[] } }).nested.deep).toEqual(['~\\a', 3, null]);
    expect((event.breadcrumbs ?? [])[0].data).toEqual({ cwd: '~' });
  });

  it('rewrites a POSIX home directory', () => {
    const event: ErrorEvent = { message: 'EACCES: open /home/dev/.config/kangentic/config.json' };
    redactEventHomeDirectory(event, POSIX_HOME, false);
    expect(event.message).toBe('EACCES: open ~/.config/kangentic/config.json');
  });
});

describe('redactEventHomeDirectory: what it leaves alone', () => {
  it('does not touch another user, or a longer name that merely starts with the home path', () => {
    const event: ErrorEvent = { message: '/home/developer/x and /home/other/y and /home/dev/z' };
    redactEventHomeDirectory(event, POSIX_HOME, false);
    expect(event.message).toBe('/home/developer/x and /home/other/y and ~/z');
  });

  it('matches Windows letter case only when told the filesystem is case-insensitive', () => {
    const sensitive: ErrorEvent = { message: 'c:\\users\\dev\\x' };
    redactEventHomeDirectory(sensitive, WINDOWS_HOME, false);
    expect(sensitive.message).toBe('c:\\users\\dev\\x');

    const insensitive: ErrorEvent = { message: 'c:\\users\\dev\\x' };
    redactEventHomeDirectory(insensitive, WINDOWS_HOME, true);
    expect(insensitive.message).toBe('~\\x');
  });

  it('leaves non-string values, keys and an empty home directory alone', () => {
    const event = { message: 'C:\\Users\\dev', level: 'error', extra: { count: 4, flag: true, nothing: null } } as unknown as ErrorEvent;
    redactEventHomeDirectory(event, '', true);
    expect(event.message).toBe('C:\\Users\\dev');

    redactEventHomeDirectory(event, WINDOWS_HOME, true);
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

    redactEventHomeDirectory(event, WINDOWS_HOME, true);

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
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
    expect(event.message).toBe('~\\x');
  });
});

describe('redactEventHomeDirectory: it never costs the event', () => {
  it('mutates and returns the same event object', () => {
    const event: ErrorEvent = { message: 'C:\\Users\\dev\\x' };
    expect(redactEventHomeDirectory(event, WINDOWS_HOME, true)).toBe(event);
  });

  it('survives a cyclic structure instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { text: 'C:\\Users\\dev\\x' };
    cyclic.self = cyclic;
    const event = { message: 'C:\\Users\\dev\\y', extra: cyclic } as unknown as ErrorEvent;
    expect(() => redactEventHomeDirectory(event, WINDOWS_HOME, true)).not.toThrow();
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
    expect(() => redactEventHomeDirectory(shallow.event, WINDOWS_HOME, true)).not.toThrow();
    expect(shallow.readText()).toBe('~\\x');

    const tooDeep = eventWithTextAtDepth(40);
    expect(() => redactEventHomeDirectory(tooDeep.event, WINDOWS_HOME, true)).not.toThrow();
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
    expect(() => redactEventHomeDirectory(event, WINDOWS_HOME, true)).not.toThrow();
    expect(redactEventHomeDirectory(event, WINDOWS_HOME, true)).toBe(event);
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
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
    expect(event.message).toBe('~\\y');
    expect(event.tags?.source).toBe('~\\z');
    expect(event.extra).toEqual({ note: 'hello', nested: { deep: 'world' } });
  });

  it('does not write back a value that did not change, so a read-only object is not an error', () => {
    const frozenExtra = Object.freeze({ note: 'nothing to redact here' });
    const event = { extra: frozenExtra, message: 'C:\\Users\\dev\\x' } as unknown as ErrorEvent;
    redactEventHomeDirectory(event, WINDOWS_HOME, true);
    expect(event.extra).toBe(frozenExtra);
    expect(event.message).toBe('~\\x');
  });
});
