import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// scripts/merge-mac-update-feeds.js builds the one latest-mac.yml both macOS arches update from.
// Each mac release leg publishes a feed naming only its own files, and the second upload replaces
// the first on the release, so without this whichever leg finished last decided every Mac's
// updates: an x64-only feed moves Apple silicon onto the Intel build under Rosetta, an arm64-only
// feed leaves Intel Macs no zip at all.
//
// The `files:` entries are hashed from the binaries on the release, not carried over from the
// legs, so the feed matches what a Mac downloads on every kind of re-run. The result is checked
// the way the app reads it: parsed with electron-updater's own js-yaml and filtered with its own
// MacUpdater.filterFilesForArch and findFile, resolved from ITS dependency tree, so this fails if
// the script writes a feed the updater would read wrongly, not only one that differs from a
// re-typed expectation.

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

interface FeedEntry {
  url: string;
  sha512: string;
  size: number;
}

type ExecFile = (command: string, args: string[], options?: unknown) => unknown;

const { macFeedFileNames, splitFeed, feedFileUrls, readFeedVersion, fileEntry, buildMacFeed, parseArgs, mergeReleaseFeed, main } =
  requireFromRepo('./scripts/merge-mac-update-feeds.js') as {
    macFeedFileNames: (version: string) => string[];
    splitFeed: (ymlText: string) => { head: string[]; items: string[][]; tail: string[] };
    feedFileUrls: (ymlText: string) => string[];
    readFeedVersion: (ymlText: string) => string | null;
    fileEntry: (filePath: string, url: string) => Promise<FeedEntry>;
    buildMacFeed: (baseText: string, entries: FeedEntry[]) => string;
    parseArgs: (argv: string[]) => { tag: string | undefined; repo: string; dryRun: boolean };
    mergeReleaseFeed: (
      options: { tag: string; repo: string; dryRun: boolean },
      dependencies?: { execFile?: ExecFile },
    ) => Promise<void>;
    main: () => Promise<void>;
  };

const updaterPackageJson = requireFromRepo.resolve('electron-updater/package.json');
const requireFromUpdater = createRequire(updaterPackageJson);
const jsYaml = requireFromUpdater('js-yaml') as { load: (text: string) => Record<string, unknown> };
const { MacUpdater } = requireFromUpdater('./out/MacUpdater.js') as {
  MacUpdater: { filterFilesForArch: (files: ResolvedFile[], isArm64Mac: boolean) => ResolvedFile[] };
};
const { findFile } = requireFromUpdater('./out/providers/Provider.js') as {
  findFile: (files: ResolvedFile[], extension: string, not?: string[]) => ResolvedFile | null | undefined;
};

interface ResolvedFile {
  url: URL;
  info: FeedEntry;
}

const VERSION = '0.43.2';
const armFeed = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/release/latest-mac-0.43.2.yml'), 'utf8');
const intelFeed = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/release/latest-mac-0.43.2-x64.yml'), 'utf8');

/** The four entries the release's binaries hash to, taken from the two legs' own feeds. */
function entriesFromLegFeeds(): FeedEntry[] {
  const parsedArm = jsYaml.load(armFeed) as { files: FeedEntry[] };
  const parsedIntel = jsYaml.load(intelFeed) as { files: FeedEntry[] };
  return [...parsedArm.files, ...parsedIntel.files];
}

/** The zip MacUpdater would download from this feed on an Apple silicon (true) or Intel (false) Mac. */
function zipPickedFor(feedText: string, isArm64Mac: boolean): string | undefined {
  const parsed = jsYaml.load(feedText) as { files: FeedEntry[] };
  const resolved = parsed.files.map((info) => ({
    url: new URL(`https://github.com/Kangentic/kangentic/releases/download/v${VERSION}/${info.url}`),
    info,
  }));
  return findFile(MacUpdater.filterFilesForArch(resolved, isArm64Mac), 'zip', ['pkg', 'dmg'])?.info.url;
}

describe('the feeds each leg publishes on their own', () => {
  // The failure this script exists for, shown with the updater's own code: a single-arch feed
  // strands the other arch.
  it('strand the other arch: an arm64-only feed gives Intel Macs no zip, and an x64-only feed moves Apple silicon to Intel', () => {
    // The updater filters every file out and its findFile throws, which is the update check
    // failing on every Intel Mac.
    expect(() => zipPickedFor(armFeed, false)).toThrow(/No files provided/);
    expect(zipPickedFor(intelFeed, true)).toBe(`Kangentic-${VERSION}-x64-mac.zip`);
  });
});

describe('macFeedFileNames', () => {
  it('lists each arch zip then dmg, arm64 first', () => {
    expect(macFeedFileNames(VERSION)).toEqual([
      `Kangentic-${VERSION}-arm64-mac.zip`,
      `Kangentic-${VERSION}-arm64.dmg`,
      `Kangentic-${VERSION}-x64-mac.zip`,
      `Kangentic-${VERSION}-x64.dmg`,
    ]);
  });
});

describe('buildMacFeed', () => {
  const entries = entriesFromLegFeeds();

  // Whichever leg uploaded last, the result is the same feed: the base only lends its version and
  // release notes.
  it.each([['arm64', armFeed], ['x64', intelFeed]] as const)(
    'gives each arch its own zip, read the way electron-updater reads it, whichever leg won the race (%s)',
    (_winner, baseFeed) => {
      const built = buildMacFeed(baseFeed, entries);
      expect(zipPickedFor(built, true)).toBe(`Kangentic-${VERSION}-arm64-mac.zip`);
      expect(zipPickedFor(built, false)).toBe(`Kangentic-${VERSION}-x64-mac.zip`);
      expect(feedFileUrls(built)).toEqual(macFeedFileNames(VERSION));
    },
  );

  it('carries the hashes and sizes it was given, which the updater checks the download against', () => {
    const parsed = jsYaml.load(buildMacFeed(intelFeed, entries)) as { files: FeedEntry[] };
    expect(parsed.files).toEqual(entries);
  });

  // Clients that read the top-level path / sha512, or the first file, keep what they got before
  // Intel builds existed, even when the Intel leg's feed is the one on the release.
  it('points the top-level path and sha512 at the arm64 zip, and keeps the base feed\'s other fields', () => {
    const parsedIntel = jsYaml.load(intelFeed);
    const parsedBuilt = jsYaml.load(buildMacFeed(intelFeed, entries)) as Record<string, unknown> & { files: FeedEntry[] };
    expect(parsedBuilt.path).toBe(`Kangentic-${VERSION}-arm64-mac.zip`);
    expect(parsedBuilt.sha512).toBe(entries[0].sha512);
    expect(parsedBuilt.files[0].url).toBe(`Kangentic-${VERSION}-arm64-mac.zip`);
    expect(parsedBuilt.releaseNotes).toBe(parsedIntel.releaseNotes);
    expect(parsedBuilt.releaseDate).toBe(parsedIntel.releaseDate);
    expect(parsedBuilt.version).toBe(VERSION);
  });

  // A re-run over a published release rebuilds from the published binaries, so the feed must come
  // out byte for byte what was published, minimumSystemVersion included, and nothing is uploaded.
  it('is idempotent, and keeps a minimumSystemVersion already written', () => {
    const published = `${buildMacFeed(armFeed, entries).replace(/\n$/, '')}\nminimumSystemVersion: '22.0.0'\n`;
    expect(buildMacFeed(published, entries)).toBe(published);
  });

  it('never touches a release note line that looks like a files item', () => {
    const notesWithListItem = armFeed.replace('  ## Bug Fixes\n', '  ## Bug Fixes\n\n  - url: Evil-arm64-mac.zip\n');
    const built = buildMacFeed(notesWithListItem, entries);
    expect(feedFileUrls(built)).toEqual(macFeedFileNames(VERSION));
    expect((jsYaml.load(built) as { releaseNotes: string }).releaseNotes).toContain('- url: Evil-arm64-mac.zip');
  });

  it('reads CRLF feeds too', () => {
    expect(feedFileUrls(intelFeed.replace(/\n/g, '\r\n'))).toEqual([`Kangentic-${VERSION}-x64-mac.zip`, `Kangentic-${VERSION}-x64.dmg`]);
  });

  it('refuses a feed with no files list, and one with no top-level path', () => {
    expect(() => splitFeed('version: 1.0.0\npath: x.zip\n')).toThrow(/no top-level "files:" list/);
    const noPath = armFeed.replace(/^path: .*\n/m, '');
    expect(() => buildMacFeed(noPath, entries)).toThrow(/no top-level "path:"/);
  });

  it('refuses a feed with no top-level sha512, which older clients read next to path', () => {
    const noSha512 = armFeed.replace(/^sha512: .*\n/m, '');
    expect(noSha512).not.toBe(armFeed);
    expect(() => buildMacFeed(noSha512, entries)).toThrow('The feed has no top-level "sha512:" for older clients to read.');
  });

  it('refuses to build a feed that lists no files', () => {
    expect(() => buildMacFeed(armFeed, [])).toThrow('No files to list in the feed.');
  });

  // Both fixtures write path / sha512 after the files list, which exercises only the tail. A feed
  // written by a different tool, or by a later electron-builder, may put them before it.
  it('rewrites a top-level path and sha512 that sit before the files list', () => {
    const headFeed = armFeed
      .replace(/^path: .*\n/m, '')
      .replace(/^sha512: .*\n/m, '')
      .replace(`version: ${VERSION}\n`, `version: ${VERSION}\npath: Stale-arm64-mac.zip\nsha512: StaleHash==\n`);
    expect(headFeed).toContain('\nsha512: StaleHash==\nfiles:');

    const built = buildMacFeed(headFeed, entries);

    // js-yaml rejects a duplicate key, so this also proves no second copy was appended after the list.
    const parsed = jsYaml.load(built) as Record<string, unknown> & { files: FeedEntry[] };
    expect(parsed.path).toBe(`Kangentic-${VERSION}-arm64-mac.zip`);
    expect(parsed.sha512).toBe(entries[0].sha512);
    expect(parsed.files).toEqual(entries);
    expect(parsed.version).toBe(VERSION);
    expect(built).not.toContain('Stale');
    expect(built.indexOf('path: ')).toBeLessThan(built.indexOf('files:'));
    expect(built.indexOf('releaseNotes:')).toBeGreaterThan(built.indexOf('files:'));
  });
});

describe('splitFeed', () => {
  it('refuses a files list whose first line is not a list item', () => {
    expect(() => splitFeed('version: 1.0.0\nfiles:\n  url: Kangentic-1.0.0-arm64-mac.zip\npath: x.zip\n')).toThrow(
      'The feed\'s "files:" list starts with a line that is not a list item: "  url: Kangentic-1.0.0-arm64-mac.zip".',
    );
  });
});

describe('fileEntry', () => {
  const scratchDirectories: string[] = [];

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('hashes a file the way electron-builder writes it: sha512 in base64, and its size', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-feed-entry-'));
    scratchDirectories.push(directory);
    const filePath = path.join(directory, 'Kangentic-1.0.0-x64-mac.zip');
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    fs.writeFileSync(filePath, content);

    const entry = await fileEntry(filePath, 'Kangentic-1.0.0-x64-mac.zip');

    expect(entry).toEqual({
      url: 'Kangentic-1.0.0-x64-mac.zip',
      sha512: crypto.createHash('sha512').update(content).digest('base64'),
      size: content.length,
    });
  });

  it('rejects for a file that is not there', async () => {
    await expect(fileEntry(path.join(os.tmpdir(), 'no-such-mac-feed-file.zip'), 'x.zip')).rejects.toThrow();
  });
});

describe('small readers', () => {
  it('reads the feed version', () => {
    expect(readFeedVersion(armFeed)).toBe(VERSION);
    expect(readFeedVersion('files:\n')).toBeNull();
  });

  it('parses the tag, the repo and a dry run', () => {
    expect(parseArgs(['v1.2.3', '--repo', 'owner/name', '--dry-run'])).toEqual({ tag: 'v1.2.3', repo: 'owner/name', dryRun: true });
  });
});

// The release path: publish-release runs mergeReleaseFeed against the draft release. The script binds
// execFileSync when it loads, so these tests hand it a gh stub through its second parameter. The stub
// answers `gh release download` by writing real files into the --dir it is given (so the real hashing
// runs) and records `gh release upload` along with the text of the file it was asked to upload, because
// the scratch directory is gone by the time the call returns.
describe('mergeReleaseFeed', () => {
  const TAG = `v${VERSION}`;
  const REPO = 'owner/name';
  const CHANNEL_FILE = 'latest-mac.yml';
  const ARM64_ZIP = `Kangentic-${VERSION}-arm64-mac.zip`;
  const ARM64_DMG = `Kangentic-${VERSION}-arm64.dmg`;
  const X64_ZIP = `Kangentic-${VERSION}-x64-mac.zip`;
  const X64_DMG = `Kangentic-${VERSION}-x64.dmg`;

  // Distinct bytes per file, so a swapped pairing or a wrong order gives a different hash and size.
  const releaseBinaries = new Map<string, Buffer>(
    [ARM64_ZIP, ARM64_DMG, X64_ZIP, X64_DMG].map((name) => [name, Buffer.from(`stub bytes of ${name}`)]),
  );
  const expectedEntries: FeedEntry[] = [...releaseBinaries].map(([name, bytes]) => ({
    url: name,
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
    size: bytes.length,
  }));

  interface GhCall {
    command: string;
    args: string[];
  }

  interface GhStub {
    execFile: ExecFile;
    calls: GhCall[];
    uploads: { args: string[]; uploadedText: string }[];
    workDirectories: string[];
  }

  interface GhStubOptions {
    /** The latest-mac.yml the release carries. */
    channelFeed: string;
    /** Names the download does not deliver, as a release that is missing an asset. */
    omitFiles?: string[];
    downloadError?: Error;
    uploadError?: Error;
  }

  const stubsToClean: GhStub[] = [];

  function createGhStub(options: GhStubOptions): GhStub {
    const stub: GhStub = { execFile: () => undefined, calls: [], uploads: [], workDirectories: [] };
    stub.execFile = (command, args) => {
      stub.calls.push({ command, args });
      if (args[0] === 'release' && args[1] === 'download') {
        const directory = args[args.indexOf('--dir') + 1];
        stub.workDirectories.push(directory);
        if (options.downloadError) throw options.downloadError;
        const delivered = new Map<string, string | Buffer>([[CHANNEL_FILE, options.channelFeed], ...releaseBinaries]);
        for (const [name, content] of delivered) {
          if (!options.omitFiles?.includes(name)) fs.writeFileSync(path.join(directory, name), content);
        }
        return Buffer.alloc(0);
      }
      if (args[0] === 'release' && args[1] === 'upload') {
        stub.uploads.push({ args, uploadedText: fs.readFileSync(args[3], 'utf8') });
        if (options.uploadError) throw options.uploadError;
        return Buffer.alloc(0);
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    };
    stubsToClean.push(stub);
    return stub;
  }

  function captureLog(): () => string[] {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return () => logSpy.mock.calls.map((callArguments) => callArguments.join(' '));
  }

  function runMerge(stub: GhStub, dryRun = false): Promise<void> {
    return mergeReleaseFeed({ tag: TAG, repo: REPO, dryRun }, { execFile: stub.execFile });
  }

  /** The scratch directory the script made for the download is gone, whatever the outcome. */
  function expectWorkDirectoryRemoved(stub: GhStub): void {
    expect(stub.workDirectories).toHaveLength(1);
    expect(fs.existsSync(stub.workDirectories[0])).toBe(false);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    // Only reached with something left over when a test failed (or the script stopped removing it).
    for (const stub of stubsToClean.splice(0)) {
      for (const directory of stub.workDirectories) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('downloads the feed and the four macOS binaries of the tag into one scratch directory', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed });

    await runMerge(stub);

    const [downloadCall] = stub.calls;
    expect(downloadCall.command).toBe('gh');
    expect(downloadCall.args).toEqual([
      'release', 'download', TAG, '--repo', REPO,
      '--pattern', CHANNEL_FILE,
      '--pattern', ARM64_ZIP, '--pattern', ARM64_DMG, '--pattern', X64_ZIP, '--pattern', X64_DMG,
      '--dir', stub.workDirectories[0], '--clobber',
    ]);
    expect(path.dirname(stub.workDirectories[0])).toBe(os.tmpdir());
    expect(path.basename(stub.workDirectories[0])).toMatch(/^kangentic-mac-feed-/);
  });

  it('rejects, without uploading, when a binary is missing from the release', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed, omitFiles: [X64_DMG] });

    await expect(runMerge(stub)).rejects.toThrow(
      `${TAG} is missing ${X64_DMG}. The macOS leg that builds it did not upload it; ` +
        're-run that leg (verify-release-assets.js would refuse this release too).',
    );

    expect(stub.uploads).toHaveLength(0);
    expect(stub.calls).toHaveLength(1);
    expectWorkDirectoryRemoved(stub);
  });

  it('names every missing file, the feed first', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed, omitFiles: [CHANNEL_FILE, ARM64_ZIP] });

    await expect(runMerge(stub)).rejects.toThrow(`${TAG} is missing ${CHANNEL_FILE}, ${ARM64_ZIP}.`);

    expect(stub.uploads).toHaveLength(0);
    expectWorkDirectoryRemoved(stub);
  });

  it('rejects, without uploading, when the feed on the release is for another version', async () => {
    captureLog();
    const staleFeed = intelFeed.replace(/^version: .*$/m, 'version: 0.43.1');
    const stub = createGhStub({ channelFeed: staleFeed });

    await expect(runMerge(stub)).rejects.toThrow(`${CHANNEL_FILE} on ${TAG} is for version 0.43.1, expected ${VERSION}.`);

    expect(stub.uploads).toHaveLength(0);
    expectWorkDirectoryRemoved(stub);
  });

  it('says so when the feed on the release has no version at all', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed.replace(/^version: .*\n/m, '') });

    await expect(runMerge(stub)).rejects.toThrow(`${CHANNEL_FILE} on ${TAG} is for version (none), expected ${VERSION}.`);

    expect(stub.uploads).toHaveLength(0);
    expectWorkDirectoryRemoved(stub);
  });

  it('on a dry run writes the merged feed to stdout and uploads nothing', async () => {
    const loggedLines = captureLog();
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stub = createGhStub({ channelFeed: intelFeed });

    await runMerge(stub, true);

    // The feed differs from the one on the release, so only the dry run stops the upload.
    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).toHaveBeenCalledWith(buildMacFeed(intelFeed, expectedEntries));
    expect(stub.uploads).toHaveLength(0);
    expect(stub.calls).toHaveLength(1);
    expect(loggedLines().join('\n')).toContain(`Dry run: ${CHANNEL_FILE} on ${TAG} would list ${ARM64_ZIP} (${expectedEntries[0].size} bytes)`);
    expect(loggedLines().join('\n')).toContain('Nothing uploaded.');
    expectWorkDirectoryRemoved(stub);
  });

  // A re-run over a published release: the binaries are the published ones, so the computed feed is
  // the published feed byte for byte, and replacing the asset would only churn it.
  it.each([['LF', '\n'], ['CRLF', '\r\n']] as const)(
    'uploads nothing when the feed on the release already lists these files with these hashes (%s)',
    async (_lineEnding, newline) => {
      const loggedLines = captureLog();
      const published = buildMacFeed(intelFeed, expectedEntries).replace(/\n/g, newline);
      const stub = createGhStub({ channelFeed: published });

      await runMerge(stub);

      expect(stub.uploads).toHaveLength(0);
      expect(stub.calls).toHaveLength(1);
      expect(loggedLines().join('\n')).toContain(`${CHANNEL_FILE} on ${TAG} already lists`);
      expect(loggedLines().join('\n')).toContain('with matching hashes. Not re-uploading.');
      expectWorkDirectoryRemoved(stub);
    },
  );

  it('replaces the feed on the release with one listing both arches, hashed from the files it downloaded', async () => {
    const loggedLines = captureLog();
    const stub = createGhStub({ channelFeed: intelFeed });

    await runMerge(stub);

    expect(stub.uploads).toHaveLength(1);
    const [upload] = stub.uploads;
    expect(upload.args).toEqual(['release', 'upload', TAG, expect.stringMatching(/merged[\\/]latest-mac\.yml$/), '--clobber', '--repo', REPO]);
    expect(stub.calls.filter((call) => call.args[1] === 'upload')).toHaveLength(1);
    expect(upload.args[3].startsWith(stub.workDirectories[0])).toBe(true);

    const uploaded = jsYaml.load(upload.uploadedText) as Record<string, unknown> & { files: FeedEntry[] };
    expect(uploaded.files.map((file) => file.url)).toEqual([ARM64_ZIP, ARM64_DMG, X64_ZIP, X64_DMG]);
    expect(uploaded.files).toEqual(expectedEntries);
    expect(uploaded.path).toBe(ARM64_ZIP);
    expect(uploaded.sha512).toBe(expectedEntries[0].sha512);
    expect(uploaded.version).toBe(VERSION);
    expect(uploaded.releaseNotes).toBe((jsYaml.load(intelFeed) as { releaseNotes: string }).releaseNotes);
    expect(zipPickedFor(upload.uploadedText, true)).toBe(ARM64_ZIP);
    expect(zipPickedFor(upload.uploadedText, false)).toBe(X64_ZIP);

    expect(loggedLines().join('\n')).toContain(`${CHANNEL_FILE} on ${TAG}: was listing ${X64_ZIP}, ${X64_DMG}; now lists ${ARM64_ZIP} (`);
    expectWorkDirectoryRemoved(stub);
  });

  it('rejects, naming the tag, when the upload fails', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed, uploadError: new Error('HTTP 502') });

    await expect(runMerge(stub)).rejects.toThrow(`Could not replace ${CHANNEL_FILE} on ${TAG}: HTTP 502`);

    expectWorkDirectoryRemoved(stub);
  });

  it('rejects, naming the tag, when the download fails', async () => {
    captureLog();
    const stub = createGhStub({ channelFeed: intelFeed, downloadError: new Error('release not found') });

    await expect(runMerge(stub)).rejects.toThrow(
      `Could not download ${CHANNEL_FILE} and the macOS binaries from ${TAG}: release not found`,
    );

    expect(stub.uploads).toHaveLength(0);
    expectWorkDirectoryRemoved(stub);
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the usage line and exits 1 when no tag is given', async () => {
    class ExitSignal extends Error {
      constructor(readonly exitCode: number | undefined) {
        super(`process.exit(${exitCode})`);
      }
    }
    // Throws so the run stops at the exit, as the real one would. A stub that only recorded the code
    // would let main carry on into mergeReleaseFeed with no tag.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((exitCode?: number) => {
      throw new ExitSignal(exitCode);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const originalArgv = process.argv;
    process.argv = [originalArgv[0], 'merge-mac-update-feeds.js'];
    try {
      await expect(main()).rejects.toMatchObject({ exitCode: 1 });
    } finally {
      process.argv = originalArgv;
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Usage: node scripts/merge-mac-update-feeds.js <tag> [--repo owner/name] [--dry-run]');
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
