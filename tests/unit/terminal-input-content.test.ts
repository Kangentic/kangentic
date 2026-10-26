/**
 * `writeCarriesUserContent` decides whether a write into a terminal means
 * someone used it. A Command Terminal nobody used is replaced in place when an
 * earlier conversation is resumed from it, so xterm's own replies must never
 * count: a fresh terminal's mount sends several (device attributes, cursor
 * position, focus), and counting them would mark every terminal used.
 */
import { describe, expect, it } from 'vitest';
import { writeCarriesUserContent } from '../../src/shared/terminal-input-content';

describe('writeCarriesUserContent', () => {
  it.each([
    ['primary device attributes reply', '\x1b[?1;2c'],
    ['secondary device attributes reply', '\x1b[>0;276;0c'],
    ['cursor position report', '\x1b[24;80R'],
    ['device status reply', '\x1b[0n'],
    ['mode report (DECRPM)', '\x1b[?2004;2$y'],
    ['window size report', '\x1b[8;24;80t'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['SGR mouse press', '\x1b[<0;10;5M'],
    ['SGR mouse release', '\x1b[<0;10;5m'],
    ['SGR wheel tick', '\x1b[<64;10;5M'],
    ['SGR mouse motion', '\x1b[<35;10;5M'],
    ['X10 mouse report', '\x1b[M !!'],
    ['colour reply ended by ST', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['colour reply ended by BEL', '\x1b]10;rgb:ffff/ffff/ffff\x07'],
    ['version reply (DCS)', '\x1bP>|xterm.js(5.5.0)\x1b\\'],
    ['a mount burst of several replies', '\x1b[?1;2c\x1b[24;80R\x1b[I'],
    ['nothing', ''],
  ])('ignores %s', (_name, data) => {
    expect(writeCarriesUserContent(data)).toBe(false);
  });

  it.each([
    ['a typed character', 'a'],
    ['Enter', '\r'],
    ['Backspace', '\x7f'],
    ['Ctrl+C', '\x03'],
    ['an arrow key', '\x1b[A'],
    ['an application-mode arrow (SS3)', '\x1bOA'],
    ['Delete', '\x1b[3~'],
    ['a modified arrow', '\x1b[1;5C'],
    ['a bracketed paste', '\x1b[200~hello\x1b[201~'],
    ['the Escape key', '\x1b'],
    ['a key after a focus report', '\x1b[Ix'],
    ['a slash command', '/model\r'],
    // The bytes that open a reply string, with nothing ending them: xterm sends
    // a reply whole, so these are keys.
    ['Alt+]', '\x1b]'],
    ['Alt+Shift+P', '\x1bP'],
    ['Alt+Shift+X', '\x1bX'],
    ['a key after a complete reply', '\x1b]11;rgb:0000/0000/0000\x07a'],
  ])('counts %s', (_name, data) => {
    expect(writeCarriesUserContent(data)).toBe(true);
  });
});
