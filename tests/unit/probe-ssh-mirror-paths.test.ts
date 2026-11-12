/**
 * The #913 mirror path mapping (scripts/probe-ssh-mirror-paths.mjs). Every mirror write and read goes
 * through it, so a collision (two host paths landing on one NTFS file) or a reserved device name
 * (CON, AUX, COM1...) corrupts the mirror silently. Pure logic, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MAXIMUM_SEGMENT,
  mirrorPath,
  mirrorSegment,
  unmirrorSegment,
} from '../../scripts/probe-ssh-mirror-paths.mjs';

const WINDOWS_DEVICE_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;

function stemOf(name: string): string {
  return name.split('.')[0];
}

describe('mirrorSegment', () => {
  it('is the identity on lowercase ASCII, UUIDs and .jsonl names', () => {
    const unchanged = [
      'project',
      'my-slug_1.2',
      'notes.txt',
      '3f2b8c1e-9a4d-4e7f-b6a1-0c5d7e8f9a2b',
      '3f2b8c1e-9a4d-4e7f-b6a1-0c5d7e8f9a2b.jsonl',
      '-home-dev-project-3',
    ];
    for (const name of unchanged) expect(mirrorSegment(name)).toBe(name);
  });

  it('stays injective after NTFS case folding, over generated names', () => {
    // Letters in both cases, the escape character, hex digits that follow it, and the characters the
    // trailing and reserved-name rules rewrite. Every string up to four characters long.
    const alphabet = ['a', 'A', 'c', 'C', 'o', 'n', '%', '4', '1', '.', ' '];
    const inputs: string[] = [];
    let frontier: string[] = [''];
    for (let length = 1; length <= 4; length += 1) {
      const next: string[] = [];
      for (const prefix of frontier) for (const character of alphabet) next.push(prefix + character);
      inputs.push(...next);
      frontier = next;
    }
    const foldedOutputs = new Set<string>();
    for (const input of inputs) foldedOutputs.add(mirrorSegment(input).toLowerCase());
    expect(foldedOutputs.size).toBe(inputs.length);
  });

  it('keeps names that differ only in case distinct after lowercasing', () => {
    expect(mirrorSegment('Readme').toLowerCase()).not.toBe(mirrorSegment('readme').toLowerCase());
    expect(mirrorSegment('Readme').toLowerCase()).not.toBe(mirrorSegment('README').toLowerCase());
    expect(mirrorSegment('A')).toBe('%41');
  });

  it('escapes a trailing dot and a trailing space, which NTFS would strip', () => {
    expect(mirrorSegment('name.')).toBe('name%2e');
    expect(mirrorSegment('name ')).toBe('name%20');
    expect(mirrorSegment('name. .')).toBe('name%2e%20%2e');
    expect(mirrorSegment('a.b')).toBe('a.b');
  });

  it('escapes the first character of a reserved device stem', () => {
    expect(mirrorSegment('con')).toBe('%63on');
    expect(mirrorSegment('aux.jsonl')).toBe('%61ux.jsonl');
    expect(mirrorSegment('com1')).toBe('%63om1');
    expect(mirrorSegment('lpt9.txt')).toBe('%6cpt9.txt');
    expect(mirrorSegment('conout$')).toBe('%63onout$');
    expect(mirrorSegment('nul')).toBe('%6eul');
  });

  it('leaves no output whose stem is a reserved device name, superscript digits included', () => {
    const names = ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1', 'CON', 'Aux.jsonl', 'com¹', 'lpt²', 'lpt³.txt', 'com¹.jsonl'];
    for (const name of names) {
      const mapped = mirrorSegment(name);
      expect(stemOf(mapped)).not.toMatch(WINDOWS_DEVICE_STEM);
      // A superscript digit is not ASCII, so it must never reach NTFS unescaped.
      expect(mapped).toMatch(/^[\x20-\x7e]*$/);
      expect(unmirrorSegment(mapped)).toBe(name);
    }
    expect(mirrorSegment('lpt¹')).toBe('lpt%c2%b9');
  });

  it('escapes ~, which could answer as an 8.3 alias and which marks a shortened name', () => {
    expect(mirrorSegment('~')).toBe('%7e');
    expect(mirrorSegment('name~1.txt')).toBe('name%7e1.txt');
    expect(mirrorSegment('a~~0123456789abcdef')).not.toMatch(/~/);
  });

  it('cuts a name over the cap to at most MAXIMUM_SEGMENT and ends it in ~~ plus 16 hex', () => {
    const long = mirrorSegment('x'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(MAXIMUM_SEGMENT);
    expect(long).toMatch(/~~[0-9a-f]{16}$/);
    // Escaping can push a name over the cap that was short as typed.
    const escaped = mirrorSegment('A'.repeat(100));
    expect(escaped.length).toBeLessThanOrEqual(MAXIMUM_SEGMENT);
    expect(escaped).toMatch(/~~[0-9a-f]{16}$/);
  });

  it('shortens a name only past the cap, and keeps two long names with a shared prefix distinct', () => {
    expect(mirrorSegment('a'.repeat(MAXIMUM_SEGMENT))).toBe('a'.repeat(MAXIMUM_SEGMENT));
    expect(mirrorSegment('a'.repeat(MAXIMUM_SEGMENT + 1))).toMatch(/~~[0-9a-f]{16}$/);
    const first = mirrorSegment(`${'p'.repeat(280)}-one`);
    const second = mirrorSegment(`${'p'.repeat(280)}-two`);
    expect(first).not.toBe(second);
  });
});

describe('unmirrorSegment', () => {
  it('undoes mirrorSegment for names under the cap, non-ASCII included', () => {
    const names = [
      'project',
      'Readme',
      'name.',
      'name ',
      'con',
      '100%',
      'a%41',
      'name~1',
      'café',
      '日本語.jsonl',
      'emoji-😀',
      'Mixed Case & Symbols',
    ];
    for (const name of names) expect(unmirrorSegment(mirrorSegment(name))).toBe(name);
  });

  it('undoes a shortened name in the same process', () => {
    const original = `${'long-é-'.repeat(60)}end`;
    const mapped = mirrorSegment(original);
    expect(mapped).toMatch(/~~[0-9a-f]{16}$/);
    expect(unmirrorSegment(mapped)).toBe(original);
  });

  it('returns null for a shortened-looking name it never produced', () => {
    expect(unmirrorSegment('a~~0123456789abcdef')).toBeNull();
    expect(unmirrorSegment(`${'b'.repeat(222)}~~fedcba9876543210`)).toBeNull();
  });
});

describe('mirrorPath', () => {
  const mirrorHome = path.join(path.sep, 'mirror', 'home');

  it('maps every segment of a valid path under the mirror home', () => {
    expect(mirrorPath(mirrorHome, 'a/b/c.jsonl')).toBe(path.join(mirrorHome, 'a', 'b', 'c.jsonl'));
    expect(mirrorPath(mirrorHome, '.claude/projects/-home-dev-App/Session.jsonl')).toBe(
      path.join(mirrorHome, '.claude', 'projects', '-home-dev-%41pp', '%53ession.jsonl'),
    );
    expect(mirrorPath(mirrorHome, 'logs/con/aux.jsonl/end.')).toBe(
      path.join(mirrorHome, 'logs', '%63on', '%61ux.jsonl', 'end%2e'),
    );
    expect(mirrorPath(mirrorHome, 'single')).toBe(path.join(mirrorHome, 'single'));
  });

  it('allows a segment that merely starts with dots', () => {
    expect(mirrorPath(mirrorHome, 'a/..hidden')).toBe(path.join(mirrorHome, 'a', '..hidden'));
  });

  it('refuses the empty string', () => {
    expect(() => mirrorPath(mirrorHome, '')).toThrow(/refused/);
  });

  it('refuses a leading slash', () => {
    expect(() => mirrorPath(mirrorHome, '/etc/passwd')).toThrow(/refused/);
  });

  it('refuses a NUL byte', () => {
    expect(() => mirrorPath(mirrorHome, 'a\0b')).toThrow(/refused/);
  });

  it('refuses .. and . segments, anywhere in the path', () => {
    for (const hostRelative of ['..', '.', '../x', 'a/..', 'a/../b', 'a/./b', './a']) {
      expect(() => mirrorPath(mirrorHome, hostRelative)).toThrow(/refused/);
    }
  });

  it('refuses an empty segment', () => {
    for (const hostRelative of ['a//b', 'a/']) {
      expect(() => mirrorPath(mirrorHome, hostRelative)).toThrow(/refused/);
    }
  });
});
