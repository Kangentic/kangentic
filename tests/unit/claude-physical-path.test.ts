import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { physicalPath, physicalPathSync } from '../../src/main/agent/adapters/claude/physical-path';

/**
 * The trust writer files a `~/.claude.json` entry with `physicalPath` and the
 * spawn's command build looks it up with `physicalPathSync`. If the two ever
 * answer differently for one folder, the entry is filed under a key nobody
 * reads. The symlink cases are pinned per caller (trust-manager, relocation,
 * browser-servers, transcript-locator); this file pins what they leave open:
 * a relative path stays as given, and the two functions agree.
 */
let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-physical-path-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('physicalPath and physicalPathSync', () => {
  it('leave a relative path as given instead of resolving it against this process cwd', async () => {
    // A relative cwd would otherwise be filed under whatever folder the main
    // process happens to run in. `kangentic-physical-path-relative` does not exist
    // under it, so a resolving implementation would return an absolute path.
    const relative = path.join('kangentic-physical-path-relative', 'project');
    expect(await physicalPath(relative)).toBe(relative);
    expect(physicalPathSync(relative)).toBe(relative);
  });

  it('agree with each other, and with the native realpath off Windows, for an existing folder', async () => {
    const folder = path.join(workspace, 'project');
    fs.mkdirSync(folder);
    const expected = process.platform === 'win32' ? folder : fs.realpathSync.native(folder);

    expect(await physicalPath(folder)).toBe(expected);
    expect(physicalPathSync(folder)).toBe(expected);
  });

  it('agree for a folder that does not exist yet, keeping the missing segments under the existing parent', async () => {
    const parent = path.join(workspace, 'parent');
    fs.mkdirSync(parent);
    const missing = path.join(parent, 'not-created-yet', 'deeper');
    const expectedParent = process.platform === 'win32' ? parent : fs.realpathSync.native(parent);
    const expected = path.join(expectedParent, 'not-created-yet', 'deeper');

    expect(await physicalPath(missing)).toBe(expected);
    expect(physicalPathSync(missing)).toBe(expected);
  });

  describe.skipIf(process.platform === 'win32')('through a symlink', () => {
    it('agree on the physical path, for a folder and for a missing child of it', async () => {
      const physicalParent = path.join(fs.realpathSync.native(workspace), 'physical-parent');
      fs.mkdirSync(physicalParent);
      const linkedParent = path.join(workspace, 'linked-parent');
      fs.symlinkSync(physicalParent, linkedParent);

      expect(await physicalPath(linkedParent)).toBe(physicalParent);
      expect(physicalPathSync(linkedParent)).toBe(physicalParent);

      const expectedMissing = path.join(physicalParent, 'not-created-yet');
      expect(await physicalPath(path.join(linkedParent, 'not-created-yet'))).toBe(expectedMissing);
      expect(physicalPathSync(path.join(linkedParent, 'not-created-yet'))).toBe(expectedMissing);
    });
  });
});
