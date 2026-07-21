import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// electron-builder.yml's rpm.depends once listed a bare package name (libXShmfence) that no
// RPM distro has ever shipped - Fedora/RHEL call it libxshmfence, openSUSE libxshmfence1. `rpm
// -i` enforces Requires without resolving them, so `npx kangentic` failed outright on Fedora
// even though the library was already installed. See .claude/rules/linux-package-dependencies.md.
//
// A soname capability ("libxshmfence.so.1()(64bit)") is identical on every RPM distro and every
// distro's rpmbuild auto-generates a Provides: for it, so this guard fails on any bare package
// name creeping back into rpm.depends. It cannot verify a soname is spelled correctly or still
// needed - that is the Linux release-CI install gate's job, not this test's.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SONAME_CAPABILITY_PATTERN = /^lib[\w.-]+\.so(?:\.\d+)*\(\)\(64bit\)$/;
const RICH_DEPENDENCY_BOOLEAN_PATTERN = /^\(.+ or .+\)$/;

/** Extract the full indented body of a top-level YAML key - every line following "<key>:\n"
 *  up to (not including) the next unindented line. Mirrors branding-assets.test.ts. */
function extractTopLevelBlock(yamlSource: string, topLevelKey: string): string {
  const match = yamlSource.match(new RegExp(`\\n${topLevelKey}:\\n((?:[ \\t].*\\n?)*)`));
  if (!match) {
    throw new Error(`electron-builder.yml: could not find top-level key "${topLevelKey}:"`);
  }
  return match[1];
}

/** Extract the `- entry` strings of a nested "depends:" list within an already-extracted block.
 *  Comment lines are consumed as part of the run and then filtered out: matching only `- ` lines
 *  would silently TRUNCATE the list at the first interleaved comment, and every entry after it
 *  would escape validation while the test still passed. A guard that quietly stops guarding is
 *  worse than no guard, so the comment case is matched explicitly rather than left to chance. */
function extractDependsList(block: string): string[] {
  const match = block.match(/depends:\n((?:[ \t]+[-#].*\n?)*)/);
  if (!match) {
    throw new Error('electron-builder.yml: could not find "depends:" list within the block');
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

describe('extractDependsList', () => {
  // Pins the fix for a truncation bug in the guard itself. The original regex matched only a
  // contiguous run of "- " lines, so a comment between two entries ended the run and dropped
  // every entry below it -- the shape assertion then validated a short list and passed while a
  // bare package name sat in the file unchecked.
  it('does not truncate the list at an interleaved comment', () => {
    const blockWithInterleavedComment = [
      '  depends:',
      '    - libnss3.so()(64bit)',
      '    # added for the at-spi bridge, see the linux-package-dependencies rule',
      '    - libbadname',
      '',
    ].join('\n');

    expect(extractDependsList(blockWithInterleavedComment)).toEqual([
      'libnss3.so()(64bit)',
      'libbadname',
    ]);
  });
});

describe('electron-builder.yml rpm.depends', () => {
  const electronBuilderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf-8');
  const rpmBlock = extractTopLevelBlock(electronBuilderConfig, 'rpm');
  const rpmDepends = extractDependsList(rpmBlock);

  it('declares at least one dependency', () => {
    expect(rpmDepends.length).toBeGreaterThan(0);
  });

  it('every entry is a soname capability or a rich-dependency boolean, never a bare package name', () => {
    const invalid = rpmDepends.filter(
      (entry) => !SONAME_CAPABILITY_PATTERN.test(entry) && !RICH_DEPENDENCY_BOOLEAN_PATTERN.test(entry),
    );
    expect(
      invalid,
      `rpm.depends has bare package name(s), which do not resolve on every RPM distro:\n${invalid.join('\n')}\n` +
        'Use a soname capability (e.g. libxshmfence.so.1()(64bit)) instead. See .claude/rules/linux-package-dependencies.md',
    ).toEqual([]);
  });

  it('includes the xshmfence soname (the originally-reported dependency)', () => {
    const hasXshmfence = rpmDepends.some((entry) => entry.includes('libxshmfence.so.1()(64bit)'));
    expect(hasXshmfence, 'rpm.depends should declare libxshmfence.so.1()(64bit)').toBe(true);
  });
});

describe('electron-builder.yml deb.depends', () => {
  const electronBuilderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf-8');
  const debBlock = extractTopLevelBlock(electronBuilderConfig, 'deb');
  const debDepends = extractDependsList(debBlock);

  it('uses alternation for the Ubuntu 24.04 libasound2 -> libasound2t64 rename', () => {
    const alsaEntry = debDepends.find((entry) => entry.includes('asound'));
    expect(alsaEntry, 'deb.depends should declare an alsa dependency').toBeDefined();
    expect(
      alsaEntry?.includes('libasound2t64') && alsaEntry?.includes('libasound2'),
      `deb.depends alsa entry ("${alsaEntry}") should alternate libasound2t64 | libasound2 - ` +
        'Ubuntu 24.04+ renamed the package and only libasound2t64 is installable there.',
    ).toBe(true);
  });
});
