/**
 * The host names in the user's `~/.ssh/config` (#913), offered as suggestions in the Add host address field.
 * A name from that file is already something `ssh` resolves, which is how a jump host or a port is set, so
 * the suggestion is the alias and nothing is copied out of the file.
 *
 * Read on this computer, since the `ssh` program that connects is this computer's. A missing file is no hosts.
 * Wildcard patterns (`Host *`, `Host *.example.com`) and negations are not hosts and are left out. `Include`
 * is followed the way OpenSSH follows it: relative to `~/.ssh`, with a `*` or `?` in the file name, and a file
 * that is not there is skipped. Depth and file count are bounded, so a file that includes itself ends.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SshConfigHost } from '../../shared/types';

const MAX_INCLUDE_DEPTH = 8;
const MAX_FILES_READ = 100;
const MAX_HOSTS = 500;

/** The words of one config line, quotes removed, stopping at a comment. */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(character)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else if (!quoted && character === '#' && !started) {
      return words;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** A line as its keyword (lower case) and the words after it. `Host a b`, `Host=a b` and `Host = a b` read alike. */
function keywordLine(line: string): { keyword: string; args: string[] } | null {
  const match = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  return { keyword: match[1].toLowerCase(), args: wordsOf(match[2]) };
}

function isHostName(pattern: string): boolean {
  return pattern.length > 0 && !/[*?!]/.test(pattern);
}

/** A glob in a file name (`*` and `?` only) as a pattern for a whole name. */
function fileNamePattern(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

interface ReadState {
  sshDirectory: string;
  homeDirectory: string;
  filesRead: number;
  seen: Set<string>;
  hosts: Map<string, SshConfigHost>;
}

async function includedFiles(argument: string, state: ReadState): Promise<string[]> {
  const expanded = argument === '~' ? state.homeDirectory : argument.startsWith('~/') ? path.join(state.homeDirectory, argument.slice(2)) : argument;
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(state.sshDirectory, expanded);
  const baseName = path.basename(absolute);
  if (!/[*?]/.test(baseName)) return [absolute];
  const directory = path.dirname(absolute);
  const pattern = fileNamePattern(baseName);
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  return names.filter((name) => pattern.test(name)).sort().map((name) => path.join(directory, name));
}

async function readConfigFile(file: string, depth: number, state: ReadState): Promise<void> {
  const key = path.resolve(file);
  if (state.seen.has(key) || state.filesRead >= MAX_FILES_READ) return;
  state.seen.add(key);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return;
  state.filesRead += 1;

  // The aliases of the Host line a `HostName` or `User` belongs to.
  let blockHosts: SshConfigHost[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = keywordLine(line);
    if (!parsed) continue;
    if (parsed.keyword === 'host') {
      blockHosts = [];
      for (const alias of parsed.args.filter(isHostName)) {
        // The first definition of an alias is the one `ssh` uses.
        const existing = state.hosts.get(alias);
        if (existing) {
          blockHosts.push(existing);
        } else if (state.hosts.size < MAX_HOSTS) {
          const host: SshConfigHost = { alias, hostName: null, user: null };
          state.hosts.set(alias, host);
          blockHosts.push(host);
        }
      }
    } else if (parsed.keyword === 'match') {
      blockHosts = [];
    } else if (parsed.keyword === 'hostname' && parsed.args[0]) {
      for (const host of blockHosts) host.hostName ??= parsed.args[0];
    } else if (parsed.keyword === 'user' && parsed.args[0]) {
      for (const host of blockHosts) host.user ??= parsed.args[0];
    } else if (parsed.keyword === 'include' && depth < MAX_INCLUDE_DEPTH) {
      for (const argument of parsed.args) {
        for (const included of await includedFiles(argument, state)) await readConfigFile(included, depth + 1, state);
      }
    }
  }
}

/** The named hosts of the user's SSH config, in the order the file lists them. */
export async function readSshConfigHosts(homeDirectory: string): Promise<SshConfigHost[]> {
  const sshDirectory = path.join(homeDirectory, '.ssh');
  const state: ReadState = { sshDirectory, homeDirectory, filesRead: 0, seen: new Set(), hosts: new Map() };
  await readConfigFile(path.join(sshDirectory, 'config'), 0, state);
  return [...state.hosts.values()];
}
