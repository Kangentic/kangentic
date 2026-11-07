/**
 * The host names Add host suggests from `~/.ssh/config` (#913), read from real files.
 *
 * What a user loses if it breaks: a wildcard pattern offered as an address to connect to, a host defined in an
 * included file never suggested, or an Include that loops hanging the Add host form.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSshConfigHosts } from '../../src/main/remote/ssh-config-hosts';

let home: string;

function writeConfig(relativePath: string, content: string): void {
  const file = path.join(home, '.ssh', relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-ssh-config-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('reading the named hosts of an SSH config', () => {
  it('is no hosts when there is no config file', async () => {
    expect(await readSshConfigHosts(home)).toEqual([]);
  });

  it('lists each alias in file order with its HostName and User, and several aliases on one line', async () => {
    writeConfig('config', [
      '# my machines',
      'Host build-box',
      '  HostName build.example.com',
      '  User dev',
      '',
      'Host gpu-1 gpu-2   # two names, one machine',
      '  HostName gpu.example.com',
      '',
      'Host bare',
    ].join('\n'));

    expect(await readSshConfigHosts(home)).toEqual([
      { alias: 'build-box', hostName: 'build.example.com', user: 'dev' },
      { alias: 'gpu-1', hostName: 'gpu.example.com', user: null },
      { alias: 'gpu-2', hostName: 'gpu.example.com', user: null },
      { alias: 'bare', hostName: null, user: null },
    ]);
  });

  it('leaves out wildcard patterns and negations, which are not hosts, and keeps the names beside them', async () => {
    writeConfig('config', 'Host * \nHost *.example.com\nHost web-? !skip real\n  User ops\n');

    expect((await readSshConfigHosts(home)).map((host) => host.alias)).toEqual(['real']);
  });

  it('reads the keyword in any case, with an equals sign, and a quoted name', async () => {
    writeConfig('config', 'host=alpha\nHOST = "beta"\n  hostname   beta.example.com\n');

    expect(await readSshConfigHosts(home)).toEqual([
      { alias: 'alpha', hostName: null, user: null },
      { alias: 'beta', hostName: 'beta.example.com', user: null },
    ]);
  });

  it('does not give a Match block\'s settings to the host before it', async () => {
    writeConfig('config', 'Host alpha\nMatch host beta\n  User stranger\n');

    expect(await readSshConfigHosts(home)).toEqual([{ alias: 'alpha', hostName: null, user: null }]);
  });

  it('keeps the first definition of an alias, as ssh does', async () => {
    writeConfig('config', 'Host dup\n  User first\nHost dup\n  User second\n');

    expect(await readSshConfigHosts(home)).toEqual([{ alias: 'dup', hostName: null, user: 'first' }]);
  });

  it('follows Include relative to ~/.ssh, by a glob in the file name, and by an absolute path', async () => {
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'extra'), 'Host from-absolute\n');
    writeConfig('config', [
      'Include conf.d/*.conf',
      'Include work',
      `Include "${path.join(elsewhere, 'extra')}"`,
      'Include nothing-here',
      'Host own',
    ].join('\n'));
    writeConfig('conf.d/a.conf', 'Host from-glob-a\n');
    writeConfig('conf.d/b.conf', 'Host from-glob-b\n');
    writeConfig('conf.d/ignored.txt', 'Host not-matched\n');
    writeConfig('work', 'Host from-work\n  HostName w.example.com\n');

    expect((await readSshConfigHosts(home)).map((host) => host.alias)).toEqual(['from-glob-a', 'from-glob-b', 'from-work', 'from-absolute', 'own']);
  });

  it('ends when files include each other, and reads each once', async () => {
    writeConfig('config', 'Include other\nHost one\n');
    writeConfig('other', 'Include config\nHost two\n');

    expect((await readSshConfigHosts(home)).map((host) => host.alias)).toEqual(['two', 'one']);
  });
});
