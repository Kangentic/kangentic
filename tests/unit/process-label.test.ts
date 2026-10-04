/**
 * The short name a leftover process is shown under (src/main/pty/process-tag/process-label.ts).
 * A command line can carry a token, so the label may hold the program's name
 * and one more short name only; these tests pin both what it shows and that
 * nothing else from the arguments ever reaches it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFileFrom, labelProcess, programName, scriptName, splitWindowsCommandLine } from '../../src/main/pty/process-tag/process-label';

const SECRET = 'sk-live-0123456789abcdef';

function label(executablePath: string | null, argv: string[], files: string[] = []) {
  const existing = new Set(files);
  return labelProcess({ executablePath, argv, isFile: async (candidate) => existing.has(candidate) });
}

describe('programName', () => {
  it('takes the file name from either separator and drops a Windows .exe', () => {
    expect(programName('C:\\Program Files\\nodejs\\node.exe')).toBe('node');
    expect(programName('/usr/bin/python3.12')).toBe('python3.12');
    expect(programName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Google Chrome');
  });
});

describe('scriptName', () => {
  it('names a script inside node_modules by its package', () => {
    expect(scriptName('/repo/node_modules/vite/bin/vite.js')).toBe('vite');
    expect(scriptName('node_modules/.bin/vite')).toBe('vite');
    expect(scriptName('C:\\repo\\node_modules\\.bin\\next.cmd')).toBe('next');
    expect(scriptName('/repo/node_modules/@angular/cli/bin/ng.js')).toBe('@angular/cli');
  });

  it('names any other script by its file name', () => {
    expect(scriptName('/repo/server.js')).toBe('server.js');
    expect(scriptName('manage.py')).toBe('manage.py');
  });
});

describe('labelProcess', () => {
  it('shows a non-interpreter by its program name alone, whatever its arguments', async () => {
    expect(await label('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['chrome.exe', `--token=${SECRET}`])).toBe('chrome');
    expect(await label('/usr/bin/tmux', ['tmux', 'new', '-d'])).toBe('tmux');
  });

  it('adds the script an interpreter runs, when that path is an existing file', async () => {
    expect(await label('/usr/bin/node', ['node', '/repo/node_modules/vite/bin/vite.js', '--port', '5173'], ['/repo/node_modules/vite/bin/vite.js'])).toBe('node (vite)');
    expect(await label('C:\\Program Files\\nodejs\\node.exe', ['C:\\Program Files\\nodejs\\node.exe', 'server.js'], ['server.js'])).toBe('node (server.js)');
  });

  it('skips flags and a flag value that is not a file', async () => {
    expect(await label('/usr/bin/node', ['node', '--inspect', '-r', 'dotenv/config', 'server.js'], ['server.js'])).toBe('node (server.js)');
  });

  it('names a python module after -m', async () => {
    expect(await label('/usr/bin/python3.12', ['python3', '-m', 'http.server', '8000'])).toBe('python3 (http.server)');
  });

  it('shows no script for inline code', async () => {
    expect(await label('/usr/bin/node', ['node', '-e', `fetch('https://example.invalid/?key=${SECRET}')`])).toBe('node');
    expect(await label('/usr/bin/python3', ['python3', '-c', `print('${SECRET}')`])).toBe('python3');
  });

  it('never shows an argument that is not an existing script, even one that looks like a path', async () => {
    const shown = await label('/usr/bin/node', ['node', `--api-key=${SECRET}`, `/tmp/${SECRET}`, SECRET]);
    expect(shown).toBe('node');
    expect(shown).not.toContain(SECRET);
  });

  it('names a process that retitled itself by the title\'s first word only', async () => {
    // npm sets its title to the whole command, arguments included.
    const npm = await label('/usr/bin/node', [`npm run deploy --token=${SECRET}`]);
    expect(npm).toBe('node (npm)');
    expect(npm).not.toContain(SECRET);
    expect(await label('/usr/bin/node', ['next-server (v14.2.3)'])).toBe('node (next-server)');
  });

  it('ignores a script past the first few arguments', async () => {
    expect(await label('/usr/bin/node', ['node', '-a', '-b', '-c2', '-d', 'late.js'], ['late.js'])).toBe('node');
  });

  it('falls back to argv[0] and then a generic name when the executable path is unknown', async () => {
    expect(await label(null, ['ruby', 'app.rb'], ['app.rb'])).toBe('ruby (app.rb)');
    expect(await label(null, [])).toBe('process');
  });

  it('never shows a retitled argv[0] as the program name when the executable path is unknown', async () => {
    const titled = await label(null, [`myapp --api-key=${SECRET}`]);
    expect(titled).toBe('process');
    const pathTitled = await label(null, [`/opt/app/bin/server --token=${SECRET}`]);
    expect(pathTitled).toBe('process');
    expect(await label(null, ['/usr/local/bin/redis-server'])).toBe('redis-server');
  });

  it('treats an isFile failure as not a file', async () => {
    const shown = await labelProcess({ executablePath: '/usr/bin/node', argv: ['node', 'server.js'], isFile: async () => { throw new Error('denied'); } });
    expect(shown).toBe('node');
  });
});

describe('splitWindowsCommandLine', () => {
  it('splits like CommandLineToArgvW', () => {
    expect(splitWindowsCommandLine('"C:\\Program Files\\nodejs\\node.exe" server.js --port 3000')).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'server.js', '--port', '3000']);
    expect(splitWindowsCommandLine('node "a b.js" c')).toEqual(['node', 'a b.js', 'c']);
    expect(splitWindowsCommandLine('node "a\\"b"')).toEqual(['node', 'a"b']);
    expect(splitWindowsCommandLine('node a\\\\"b c"')).toEqual(['node', 'a\\b c']);
    expect(splitWindowsCommandLine('node C:\\dir\\file.js')).toEqual(['node', 'C:\\dir\\file.js']);
    expect(splitWindowsCommandLine('node "say ""hi"""')).toEqual(['node', 'say "hi"']);
    expect(splitWindowsCommandLine('   ')).toEqual([]);
  });
});

describe('isFileFrom', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * `fs.promises.stat` (the same object the module imports) failing at once, so a
   * network path that did reach it would not wait on a real share.
   */
  function failingStat() {
    return vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('unreachable'), { code: 'ENOENT' }));
  }

  it('answers false for a UNC candidate without asking the filesystem', async () => {
    const stat = failingStat();
    // `//host/share` is absolute on every OS, so this runs everywhere.
    expect(await isFileFrom(null, '//host/share/app.js')).toBe(false);
    expect(await isFileFrom('/mock/work', '//host/share/app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it('answers false for a relative candidate under a UNC working directory without asking the filesystem', async () => {
    const stat = failingStat();
    expect(await isFileFrom('//host/share/work', 'app.js')).toBe(false);
    expect(await isFileFrom('//host/share/work', './scripts/app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('answers false for a backslash UNC candidate, or one under a backslash UNC working directory, without asking the filesystem', async () => {
    const stat = failingStat();
    expect(await isFileFrom(null, '\\\\host\\share\\app.js')).toBe(false);
    expect(await isFileFrom('\\\\host\\share\\work', 'app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it('answers false for a UNC path behind a device prefix without asking the filesystem', async () => {
    const stat = failingStat();
    // `//?/UNC/host/share` is `\\host\share` in its long-path form, and absolute on every OS.
    expect(await isFileFrom(null, '//?/UNC/host/share/app.js')).toBe(false);
    expect(await isFileFrom(null, '//?/unc/host/share/app.js')).toBe(false);
    expect(await isFileFrom(null, '//./UNC/host/share/app.js')).toBe(false);
    expect(await isFileFrom('//?/UNC/host/share/work', 'app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('answers false for a backslash UNC path behind a device prefix without asking the filesystem', async () => {
    const stat = failingStat();
    expect(await isFileFrom(null, '\\\\?\\UNC\\host\\share\\app.js')).toBe(false);
    expect(await isFileFrom('\\\\?\\UNC\\host\\share\\work', 'app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it('answers false for a relative candidate under any backslash share form, on every OS, without asking the filesystem', async () => {
    // A relative candidate makes the check read the working directory as written,
    // so the backslash half of the pattern runs on Linux and macOS too.
    const stat = failingStat();
    expect(await isFileFrom('\\\\host\\share\\work', 'app.js')).toBe(false);
    expect(await isFileFrom('\\\\?\\UNC\\host\\share\\work', 'app.js')).toBe(false);
    expect(await isFileFrom('\\\\.\\UNC\\host\\share\\work', 'app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });

  it('does not take a backslash local device path for a share, on every OS, and still asks the filesystem', async () => {
    const stat = failingStat();
    expect(await isFileFrom('\\\\.\\pipe\\work', 'app.js')).toBe(false);
    expect(await isFileFrom('\\\\?\\C:\\work', 'app.js')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('does not take a local device path for a share, and still asks the filesystem about it', async () => {
    const stat = failingStat();
    expect(await isFileFrom(null, '//?/C:/work/app.js')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('still asks the filesystem about a local file, absolute or relative to its working directory, and finds it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-label-'));
    temporaryRoots.push(directory);
    const script = path.join(directory, 'app.js');
    fs.writeFileSync(script, '');
    const stat = vi.spyOn(fs.promises, 'stat');

    expect(await isFileFrom(null, script)).toBe(true);
    expect(await isFileFrom(directory, 'app.js')).toBe(true);
    expect(stat).toHaveBeenCalledTimes(2);
    // A directory is not a file, and a missing path is not one either.
    expect(await isFileFrom(null, directory)).toBe(false);
    expect(await isFileFrom(directory, 'missing.js')).toBe(false);
    // A relative path with no working directory is never a file, and never reaches the filesystem.
    stat.mockClear();
    expect(await isFileFrom(null, 'app.js')).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });
});
