/**
 * The short name a leftover process is shown under (src/main/pty/process-tag/process-label.ts).
 * A command line can carry a token, so the label may hold the program's name
 * and one more short name only; these tests pin both what it shows and that
 * nothing else from the arguments ever reaches it.
 */

import { describe, it, expect } from 'vitest';
import { labelProcess, programName, scriptName, splitWindowsCommandLine } from '../../src/main/pty/process-tag/process-label';

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
