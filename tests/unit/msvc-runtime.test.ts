/**
 * build/msvc-runtime.js - the MSVC runtime afterPack ships beside onnxruntime-node's Windows
 * binding (Sentry DESKTOP-38: ERR_DLOPEN_FAILED on a machine without the Visual C++ runtime).
 *
 * The real binaries come from node_modules: the onnxruntime-node package ships every platform's
 * binaries (tests/unit/embedding-runtime.test.ts relies on the same), so the Linux runner reads
 * the win32 import tables too. Everything that writes uses synthetic PE images in os.tmpdir().
 *
 * Tier: Unit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface RedistCandidate {
  version: string;
  crtDir: string;
  source: string;
}

interface LocateResult {
  candidates: RedistCandidate[];
  searched: string[];
}

type VswhereExec = (command: string, args: string[], options: object) => string;

const msvcRuntime = require('../../build/msvc-runtime.js') as {
  parseVswhereOutput: (stdout: string) => string[];
  defaultRunVswhere: (
    env: Record<string, string | undefined>,
    injected?: { exec?: VswhereExec; exists?: (candidate: string) => boolean },
  ) => string[];
  readPeInfo: (buffer: Buffer) => { linkerVersion: [number, number]; imports: string[] };
  requiredMsvcRuntime: (binaryDir: string) => { required: string[]; linkerFloor: [number, number] };
  locateVcRedist: (options: {
    targetArch: string;
    env?: Record<string, string | undefined>;
    runVswhere?: (env: Record<string, string | undefined>) => string[];
  }) => LocateResult;
  stageMsvcRuntime: (options: {
    binaryDir: string;
    platform: string;
    targetArch: string;
    locate?: (options: { targetArch: string }) => LocateResult;
    log?: (line: string) => void;
    hostPlatform?: string;
  }) => void;
  verifyMsvcRuntimeBesideBinding: (options: { binaryDir: string; platform: string; log?: (line: string) => void }) => void;
};

/**
 * A minimal PE32+ image: one section holding the import descriptors and their names, and,
 * when `delayImports` is given, the delay-load descriptors too. Enough for the import-table
 * reader, and nothing a loader could run.
 */
function buildPeImage({
  linkerVersion = [14, 44],
  imports = [],
  delayImports = [],
  magic = 0x20b,
}: {
  linkerVersion?: [number, number];
  imports?: string[];
  delayImports?: string[];
  /** Optional header magic: 0x20b is PE32+ (240-byte header), 0x10b is PE32 (224-byte header). */
  magic?: number;
}): Buffer {
  const isPe32 = magic === 0x10b;
  const optionalHeaderSize = isPe32 ? 224 : 240;
  const sectionVirtualAddress = 0x1000;
  const sectionFileOffset = 0x200;
  const importTableSize = (imports.length + 1) * 20;
  const delayTableSize = delayImports.length > 0 ? (delayImports.length + 1) * 32 : 0;
  const names = [...imports, ...delayImports];
  let namesSize = 0;
  for (const name of names) namesSize += name.length + 1;
  const sectionSize = importTableSize + delayTableSize + namesSize;
  const image = Buffer.alloc(sectionFileOffset + sectionSize);

  image.writeUInt16LE(0x5a4d, 0); // MZ
  const peOffset = 0x40;
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x00004550, peOffset); // PE\0\0
  image.writeUInt16LE(0x8664, peOffset + 4); // x64
  image.writeUInt16LE(1, peOffset + 6); // one section
  image.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  const optionalHeader = peOffset + 24;
  image.writeUInt16LE(magic, optionalHeader);
  image[optionalHeader + 2] = linkerVersion[0];
  image[optionalHeader + 3] = linkerVersion[1];
  const dataDirectories = optionalHeader + (isPe32 ? 96 : 112);
  if (imports.length > 0) image.writeUInt32LE(sectionVirtualAddress, dataDirectories + 8);
  if (delayImports.length > 0) image.writeUInt32LE(sectionVirtualAddress + importTableSize, dataDirectories + 13 * 8);
  const sectionHeader = optionalHeader + optionalHeaderSize;
  image.writeUInt32LE(sectionSize, sectionHeader + 8);
  image.writeUInt32LE(sectionVirtualAddress, sectionHeader + 12);
  image.writeUInt32LE(sectionSize, sectionHeader + 16);
  image.writeUInt32LE(sectionFileOffset, sectionHeader + 20);

  let nameOffset = importTableSize + delayTableSize;
  const writeName = (name: string): number => {
    const rva = sectionVirtualAddress + nameOffset;
    image.write(name, sectionFileOffset + nameOffset, 'latin1');
    nameOffset += name.length + 1;
    return rva;
  };
  imports.forEach((name, index) => {
    image.writeUInt32LE(writeName(name), sectionFileOffset + index * 20 + 12);
  });
  delayImports.forEach((name, index) => {
    image.writeUInt32LE(writeName(name), sectionFileOffset + importTableSize + index * 32 + 4);
  });
  return image;
}

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(directory);
  return directory;
}

/** A binding directory shaped like onnxruntime-node 1.30's win32/x64 one, from synthetic images. */
function makeBindingDir(): string {
  const binaryDir = makeTempDir('msvc-runtime-binding-');
  fs.writeFileSync(
    path.join(binaryDir, 'onnxruntime_binding.node'),
    buildPeImage({ imports: ['onnxruntime.dll', 'KERNEL32.dll', 'MSVCP140.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll'] }),
  );
  fs.writeFileSync(
    path.join(binaryDir, 'onnxruntime.dll'),
    buildPeImage({ imports: ['KERNEL32.dll', 'MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_ATOMIC_WAIT.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'DirectML.dll'] }),
  );
  fs.writeFileSync(path.join(binaryDir, 'DirectML.dll'), buildPeImage({ linkerVersion: [14, 41], imports: ['d3d12.dll'] }));
  return binaryDir;
}

const BINDING_RUNTIME = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** A Visual Studio redist tree holding `dlls` for one version and arch. Returns the CRT directory. */
function makeRedist(
  version: string,
  dlls: string[],
  archDir = 'x64',
  dllLinkerVersion: [number, number] = [14, 44],
): { versionDir: string; crtDir: string } {
  const versionDir = path.join(makeTempDir('msvc-runtime-redist-'), 'VC', 'Redist', 'MSVC', version);
  const crtDir = path.join(versionDir, archDir, 'Microsoft.VC143.CRT');
  fs.mkdirSync(crtDir, { recursive: true });
  for (const name of dlls) {
    // Each runtime DLL is a PE image, as the gate re-reads the staged directory.
    const imports = name.startsWith('msvcp') ? ['VCRUNTIME140.dll', 'KERNEL32.dll'] : ['KERNEL32.dll'];
    fs.writeFileSync(path.join(crtDir, name), buildPeImage({ imports, linkerVersion: dllLinkerVersion }));
  }
  return { versionDir, crtDir };
}

function locateFrom(candidates: RedistCandidate[]): () => LocateResult {
  return () => ({ candidates, searched: candidates.map((candidate) => candidate.crtDir) });
}

describe('readPeInfo', () => {
  it('reads the linker version and both import tables of a PE image', () => {
    const info = msvcRuntime.readPeInfo(buildPeImage({
      linkerVersion: [14, 44],
      imports: ['KERNEL32.dll', 'MSVCP140.dll'],
      delayImports: ['VCOMP140.dll'],
    }));
    expect(info).toEqual({ linkerVersion: [14, 44], imports: ['KERNEL32.dll', 'MSVCP140.dll', 'VCOMP140.dll'] });
  });

  it('refuses a file that is not a PE image', () => {
    expect(() => msvcRuntime.readPeInfo(Buffer.from('binding'.padEnd(128, ' ')))).toThrow(/not a PE image/);
  });

  // Red-green: read the data directories at +112 for PE32 and the imports come back empty.
  it('reads a 32-bit PE32 image the same way', () => {
    const options = { linkerVersion: [14, 44] as [number, number], imports: ['KERNEL32.dll', 'MSVCP140.dll'], delayImports: ['VCOMP140.dll'] };
    expect(msvcRuntime.readPeInfo(buildPeImage({ ...options, magic: 0x10b })))
      .toEqual(msvcRuntime.readPeInfo(buildPeImage(options)));
    expect(msvcRuntime.readPeInfo(buildPeImage({ ...options, magic: 0x10b }))).toEqual({
      linkerVersion: [14, 44],
      imports: ['KERNEL32.dll', 'MSVCP140.dll', 'VCOMP140.dll'],
    });
  });

  it('refuses an optional header magic it does not know', () => {
    expect(() => msvcRuntime.readPeInfo(buildPeImage({ imports: ['KERNEL32.dll'], magic: 0x1234 })))
      .toThrow(/unknown optional header magic/);
  });

  // Offset of data directory 1 (imports) in buildPeImage's PE32+ layout: PE header at 0x40,
  // optional header 24 bytes after it, data directories 112 bytes into that, entry 1 at +8.
  const IMPORT_DIRECTORY_RVA_OFFSET = 0x40 + 24 + 112 + 8;

  // Red-green: drop the `descriptor >= 0` guard in readPeInfo and rvaToOffset's -1 reaches
  // readUInt32LE(-1 + 12), which throws a RangeError instead of returning no imports.
  it('returns no imports for an import table RVA that no section maps', () => {
    const image = buildPeImage({ imports: ['MSVCP140.dll'] });
    image.writeUInt32LE(0x9000, IMPORT_DIRECTORY_RVA_OFFSET);
    expect(msvcRuntime.readPeInfo(image)).toEqual({ linkerVersion: [14, 44], imports: [] });
  });

  // Red-green: drop the `descriptor + 20 <= buffer.length` guard and the read past the end of
  // the buffer throws a RangeError. The terminator descriptor is overwritten with a copy of the
  // first one's name RVA, so the table has no zero terminator before the buffer ends.
  it('returns the names it could read from an import table cut off before its terminator', () => {
    const image = buildPeImage({ imports: ['MSVCP140.dll'] });
    const sectionFileOffset = 0x200;
    const firstNameRva = image.readUInt32LE(sectionFileOffset + 12);
    image.writeUInt32LE(firstNameRva, sectionFileOffset + 20 + 12);
    let info: { imports: string[] } | undefined;
    expect(() => { info = msvcRuntime.readPeInfo(image); }).not.toThrow();
    expect(info?.imports[0]).toBe('MSVCP140.dll');
    expect(info?.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseVswhereOutput and defaultRunVswhere', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'vswhere-installation-paths-win32.json'), 'utf8'),
  ) as { stdout: string; installationPaths: string[] };
  const EXPECTED_ARGS = ['-all', '-products', '*', '-utf8', '-property', 'installationPath'];

  // Red-green: split on '\n' only (no trim) and every real line keeps a trailing \r; drop the
  // empty-line filter and the output's final CRLF adds an empty path.
  it('parses real vswhere stdout (CRLF endings, trailing CRLF) into the install paths', () => {
    expect(fixture.stdout).toContain('\r\n');
    expect(msvcRuntime.parseVswhereOutput(fixture.stdout)).toEqual(fixture.installationPaths);
  });

  // Red-green: drop the `!programFilesX86` early return and path.join(undefined) throws.
  it('returns no installs, and runs nothing, when neither Program Files variable is set', () => {
    const exec = vi.fn<VswhereExec>();
    const exists = vi.fn(() => true);
    expect(msvcRuntime.defaultRunVswhere({}, { exec, exists })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  // Red-green: drop the `exists` check and exec is called for a vswhere that is not there.
  it('returns no installs, and runs nothing, when vswhere.exe is not installed', () => {
    const exec = vi.fn<VswhereExec>();
    const exists = vi.fn(() => false);
    expect(msvcRuntime.defaultRunVswhere({ 'ProgramFiles(x86)': path.join(os.tmpdir(), 'pf86') }, { exec, exists })).toEqual([]);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
  });

  // Red-green: drop '-utf8' (non-ASCII install paths break), '-all' (hides older installs), or
  // change the property, and the exact argument list differs.
  it('runs vswhere once from the Visual Studio Installer folder with the pinned arguments, and parses its output', () => {
    const programFiles = path.join(os.tmpdir(), 'pf86');
    const exec = vi.fn<VswhereExec>(() => fixture.stdout);
    const exists = vi.fn(() => true);
    const result = msvcRuntime.defaultRunVswhere({ 'ProgramFiles(x86)': programFiles }, { exec, exists });
    const expectedExecutable = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    expect(exists).toHaveBeenCalledWith(expectedExecutable);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe(expectedExecutable);
    expect(exec.mock.calls[0][1]).toEqual(EXPECTED_ARGS);
    expect(result).toEqual(fixture.installationPaths);
  });

  // Red-green: swap the operands of `||` and the 32-bit-view directory loses to ProgramFiles.
  it('prefers ProgramFiles(x86) over ProgramFiles', () => {
    const exec = vi.fn<VswhereExec>(() => '');
    const x86 = path.join(os.tmpdir(), 'pf86');
    const native = path.join(os.tmpdir(), 'pf');
    msvcRuntime.defaultRunVswhere({ 'ProgramFiles(x86)': x86, ProgramFiles: native }, { exec, exists: () => true });
    expect(exec.mock.calls[0][0]).toBe(path.join(x86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
    exec.mockClear();
    msvcRuntime.defaultRunVswhere({ ProgramFiles: native }, { exec, exists: () => true });
    expect(exec.mock.calls[0][0]).toBe(path.join(native, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  });
});

describe('requiredMsvcRuntime', () => {
  // Red-green: drop the isMsvcRuntimeDll exclusion and the floor becomes 14.99.
  it('leaves a runtime DLL\'s own linker version out of the floor', () => {
    const binaryDir = makeBindingDir();
    fs.writeFileSync(path.join(binaryDir, 'msvcp140.dll'), buildPeImage({ linkerVersion: [14, 99], imports: ['VCRUNTIME140.dll'] }));
    expect(msvcRuntime.requiredMsvcRuntime(binaryDir).linkerFloor).toEqual([14, 44]);
  });
});

// The real onnxruntime-node binaries: the parser reads what Windows' loader reads. dumpbin
// /DEPENDENTS on 1.30.0 lists exactly these runtime DLLs for the binding and onnxruntime.dll.
describe('the shipped onnxruntime-node Windows binaries', () => {
  const onnxruntimeRoot = path.dirname(require.resolve('onnxruntime-node/package.json'));

  it.each(['x64', 'arm64'])('win32/%s: the binding and onnxruntime.dll import the MSVC runtime', (arch) => {
    const binaryDir = path.join(onnxruntimeRoot, 'bin', 'napi-v6', 'win32', arch);
    const binding = msvcRuntime.readPeInfo(fs.readFileSync(path.join(binaryDir, 'onnxruntime_binding.node')));
    expect(binding.imports.map((name) => name.toLowerCase())).toContain('onnxruntime.dll');

    const { required, linkerFloor } = msvcRuntime.requiredMsvcRuntime(binaryDir);
    expect(required).toEqual(expect.arrayContaining(['msvcp140.dll', 'vcruntime140.dll']));
    // Every name is a runtime DLL, so the copy step never reaches for a Windows system DLL.
    for (const name of required) expect(name).toMatch(/^(msvcp140|vcruntime140|concrt140|vccorlib140|vcomp140)/);
    // The floor comes from the binaries, so an older redist cannot be shipped beside them.
    expect(linkerFloor[0]).toBe(14);
    expect(linkerFloor[1]).toBeGreaterThanOrEqual(40);
  });
});

describe('stageMsvcRuntime', () => {
  it('copies every runtime DLL the binaries import from the newest redist', () => {
    const binaryDir = makeBindingDir();
    const newer = makeRedist('14.44.35112', [...BINDING_RUNTIME, 'concrt140.dll']);
    const older = makeRedist('14.29.30133', BINDING_RUNTIME);
    const lines: string[] = [];
    msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([
        { version: '14.44.35112', crtDir: newer.crtDir, source: 'newer' },
        { version: '14.29.30133', crtDir: older.crtDir, source: 'older' },
      ]),
      log: (line) => lines.push(line),
    });

    for (const name of BINDING_RUNTIME) {
      expect(fs.readFileSync(path.join(binaryDir, name))).toEqual(fs.readFileSync(path.join(newer.crtDir, name)));
    }
    // Only what is imported: concrt140 is in the redist but nothing here imports it.
    expect(fs.existsSync(path.join(binaryDir, 'concrt140.dll'))).toBe(false);
    expect(lines).toEqual([expect.stringMatching(/copied .*redist 14\.44\.35112, binaries linked with 14\.44/)]);
    expect(() => msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: () => {} })).not.toThrow();
  });

  // An app-local runtime wins over System32, so one older than the binaries' toolset would
  // break machines whose newer system copy works today.
  it('refuses a redist older than the binaries were linked with', () => {
    const binaryDir = makeBindingDir();
    const older = makeRedist('14.29.30133', BINDING_RUNTIME);
    expect(() => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.29.30133', crtDir: older.crtDir, source: 'older' }]),
      log: () => {},
    })).toThrow(/newest x64 redist here is 14\.29\.30133.*linked with 14\.44.*C\+\+ redist is 14\.44 or later/);
    expect(fs.existsSync(path.join(binaryDir, 'msvcp140.dll'))).toBe(false);
  });

  // Red-green: compare the floor and the redist version as strings and 14.10 < 14.9, so a
  // redist newer than the binaries' toolset is refused as older.
  it('treats redist 14.10.1 as newer than a binding linked with 14.9', () => {
    const binaryDir = makeTempDir('msvc-runtime-numeric-floor-');
    fs.writeFileSync(path.join(binaryDir, 'onnxruntime_binding.node'), buildPeImage({ linkerVersion: [14, 9], imports: ['MSVCP140.dll'] }));
    const redist = makeRedist('14.10.1', ['msvcp140.dll', 'vcruntime140.dll']);
    expect(() => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.10.1', crtDir: redist.crtDir, source: 'redist' }]),
      log: () => {},
    })).not.toThrow();
    expect(fs.existsSync(path.join(binaryDir, 'msvcp140.dll'))).toBe(true);
  });

  it('refuses when no redist is found, naming what it searched', () => {
    const binaryDir = makeBindingDir();
    expect(() => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: () => ({ candidates: [], searched: ['VCToolsRedistDir=somewhere'] }),
      log: () => {},
    })).toThrow(/no x64 Visual C\+\+ redist .*searched: VCToolsRedistDir=somewhere/);
  });

  it('refuses a redist that lacks a DLL the binaries import', () => {
    const binaryDir = makeBindingDir();
    const partial = makeRedist('14.44.35112', BINDING_RUNTIME.filter((name) => name !== 'msvcp140_atomic_wait.dll'));
    expect(() => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.44.35112', crtDir: partial.crtDir, source: 'partial' }]),
      log: () => {},
    })).toThrow(/has no msvcp140_atomic_wait\.dll/);
  });

  // Red-green: with the floor including staged DLLs (linked 14.99 here), the second run throws "older than".
  it('can run twice on the same directory without the staged DLLs raising the floor', () => {
    const binaryDir = makeBindingDir();
    const redist = makeRedist('14.44.35112', BINDING_RUNTIME, 'x64', [14, 99]);
    const run = (): void => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.44.35112', crtDir: redist.crtDir, source: 'redist' }]),
      log: () => {},
    });
    run();
    expect(run).not.toThrow();
  });

  // Red-green: stage only the names the binaries import (no re-read) and concrt140.dll is never copied.
  it('stages a DLL that only a staged runtime DLL imports', () => {
    const binaryDir = makeBindingDir();
    const redist = makeRedist('14.44.35112', [...BINDING_RUNTIME, 'concrt140.dll']);
    fs.writeFileSync(path.join(redist.crtDir, 'msvcp140.dll'), buildPeImage({ imports: ['VCRUNTIME140.dll', 'CONCRT140.dll'] }));
    const lines: string[] = [];
    msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.44.35112', crtDir: redist.crtDir, source: 'redist' }]),
      log: (line) => lines.push(line),
    });
    expect(fs.readFileSync(path.join(binaryDir, 'concrt140.dll'))).toEqual(fs.readFileSync(path.join(redist.crtDir, 'concrt140.dll')));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('concrt140.dll');
    expect(() => msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: () => {} })).not.toThrow();
  });

  it('refuses a redist that lacks a DLL only a runtime DLL imports', () => {
    const binaryDir = makeBindingDir();
    const redist = makeRedist('14.44.35112', BINDING_RUNTIME);
    fs.writeFileSync(path.join(redist.crtDir, 'msvcp140.dll'), buildPeImage({ imports: ['VCRUNTIME140.dll', 'CONCRT140.dll'] }));
    expect(() => msvcRuntime.stageMsvcRuntime({
      binaryDir,
      platform: 'win32',
      targetArch: 'x64',
      locate: locateFrom([{ version: '14.44.35112', crtDir: redist.crtDir, source: 'redist' }]),
      log: () => {},
    })).toThrow(/has no concrt140\.dll/);
  });

  it('stages nothing when no binary imports the runtime, and never looks for a redist', () => {
    const binaryDir = makeTempDir('msvc-runtime-noimports-');
    fs.writeFileSync(path.join(binaryDir, 'plain.node'), buildPeImage({ imports: ['KERNEL32.dll'] }));
    const lines: string[] = [];
    const locate = vi.fn(() => ({ candidates: [], searched: [] }));
    msvcRuntime.stageMsvcRuntime({ binaryDir, platform: 'win32', targetArch: 'x64', locate, log: (line) => lines.push(line) });
    expect(locate).not.toHaveBeenCalled();
    expect(lines).toEqual([`[afterPack] MSVC runtime: no binary in ${binaryDir} imports it, nothing to stage`]);
  });

  // Red-green: drop hostNote and the cross-host message loses its hint.
  it('tells a cross-host build to package Windows on Windows', () => {
    const stage = (hostPlatform: string): void => msvcRuntime.stageMsvcRuntime({
      binaryDir: makeBindingDir(),
      platform: 'win32',
      targetArch: 'x64',
      hostPlatform,
      locate: () => ({ candidates: [], searched: [] }),
      log: () => {},
    });
    expect(() => stage('linux')).toThrow(/This build runs on linux.*package Windows on Windows/);
    let windowsHostMessage = '';
    try {
      stage('win32');
    } catch (error) {
      windowsHostMessage = (error as Error).message;
    }
    expect(windowsHostMessage).toContain('no x64 Visual C++ redist');
    expect(windowsHostMessage).not.toContain('This build runs on');
  });

  it('stages nothing off Windows, and says so', () => {
    const lines: string[] = [];
    msvcRuntime.stageMsvcRuntime({
      binaryDir: makeTempDir('msvc-runtime-linux-'),
      platform: 'linux',
      targetArch: 'x64',
      locate: () => { throw new Error('must not look for a redist off Windows'); },
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([expect.stringMatching(/not needed on linux/)]);
  });
});

describe('verifyMsvcRuntimeBesideBinding', () => {
  // Red before the fix: this is the tree every Windows release through 0.58.0 shipped.
  it('fails a binding directory without the runtime, naming each missing DLL', () => {
    const binaryDir = makeBindingDir();
    expect(() => msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: () => {} }))
      .toThrow(new RegExp(`${BINDING_RUNTIME.join(', ').replace(/\./g, '\\.')} not beside onnxruntime_binding\\.node`));
  });

  it('fails when a staged runtime DLL imports one that is not there', () => {
    const binaryDir = makeBindingDir();
    for (const name of BINDING_RUNTIME) {
      fs.writeFileSync(path.join(binaryDir, name), buildPeImage({ imports: name === 'msvcp140.dll' ? ['CONCRT140.dll'] : [] }));
    }
    expect(() => msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: () => {} }))
      .toThrow(/concrt140\.dll not beside/);
  });

  it('passes once every imported runtime DLL is beside the binding, and logs it', () => {
    const binaryDir = makeBindingDir();
    for (const name of BINDING_RUNTIME) fs.writeFileSync(path.join(binaryDir, name), buildPeImage({}));
    const lines: string[] = [];
    msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: (line) => lines.push(line) });
    expect(lines).toEqual([`[afterPack] MSVC runtime: ${BINDING_RUNTIME.join(', ')} beside onnxruntime_binding.node`]);
  });
});

describe('verifyMsvcRuntimeBesideBinding off Windows or with nothing to check', () => {
  it('skips off Windows and says so, even with the DLLs absent', () => {
    const lines: string[] = [];
    expect(() => msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir: makeBindingDir(), platform: 'linux', log: (line) => lines.push(line) })).not.toThrow();
    expect(lines).toEqual([expect.stringContaining('not checked on linux')]);
  });

  it('passes a win32 directory whose binaries import no runtime, and logs nothing beside the binding', () => {
    const binaryDir = makeTempDir('msvc-runtime-verify-none-');
    fs.writeFileSync(path.join(binaryDir, 'plain.node'), buildPeImage({ imports: ['KERNEL32.dll'] }));
    const lines: string[] = [];
    msvcRuntime.verifyMsvcRuntimeBesideBinding({ binaryDir, platform: 'win32', log: (line) => lines.push(line) });
    expect(lines).toEqual([expect.stringContaining('nothing beside onnxruntime_binding.node')]);
  });
});

describe('locateVcRedist', () => {
  it('notes a failing vswhere by its first line and keeps the VCToolsRedistDir candidate', () => {
    const fromEnv = makeRedist('14.40.33807', BINDING_RUNTIME);
    const { candidates, searched } = msvcRuntime.locateVcRedist({
      targetArch: 'x64',
      env: { VCToolsRedistDir: fromEnv.versionDir },
      runVswhere: () => { throw new Error('Command failed: vswhere.exe\nsecond line'); },
    });
    expect(candidates).toEqual([{ version: '14.40.33807', crtDir: fromEnv.crtDir, source: 'VCToolsRedistDir' }]);
    expect(searched).toContain('vswhere failed (Command failed: vswhere.exe)');
  });

  it('explains an install it skipped, and yields no candidate for either', () => {
    const noVersionFile = makeTempDir('msvc-runtime-vs-nofile-');
    const noCrt = makeTempDir('msvc-runtime-vs-nocrt-');
    fs.mkdirSync(path.join(noCrt, 'VC', 'Auxiliary', 'Build'), { recursive: true });
    fs.writeFileSync(path.join(noCrt, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112\n');
    // The shape seen on an install without the redistributable component: only an Auxiliary folder.
    fs.mkdirSync(path.join(noCrt, 'VC', 'Redist', 'MSVC', '14.44.35112', 'Auxiliary'), { recursive: true });

    const { candidates, searched } = msvcRuntime.locateVcRedist({
      targetArch: 'x64',
      env: {},
      runVswhere: () => [noVersionFile, noCrt],
    });
    expect(candidates).toEqual([]);
    expect(searched).toEqual([
      `${noVersionFile} (no C++ redist version file)`,
      `${noCrt} (redist 14.44.35112 has no x64 CRT folder)`,
    ]);
  });

  it('reads VCToolsRedistDir and every vswhere install, newest first, for the target arch', () => {
    const fromEnv = makeRedist('14.40.33807', BINDING_RUNTIME);
    const installationPath = makeTempDir('msvc-runtime-vs-');
    const versionDir = path.join(installationPath, 'VC', 'Redist', 'MSVC', '14.44.35112');
    fs.mkdirSync(path.join(versionDir, 'x64', 'Microsoft.VC143.CRT'), { recursive: true });
    fs.mkdirSync(path.join(installationPath, 'VC', 'Auxiliary', 'Build'), { recursive: true });
    fs.writeFileSync(path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112\r\n');

    const { candidates } = msvcRuntime.locateVcRedist({
      targetArch: 'x64',
      env: { VCToolsRedistDir: `${fromEnv.versionDir}${path.sep}` },
      runVswhere: () => [installationPath],
    });
    expect(candidates).toEqual([
      { version: '14.44.35112', crtDir: path.join(versionDir, 'x64', 'Microsoft.VC143.CRT'), source: installationPath },
      { version: '14.40.33807', crtDir: fromEnv.crtDir, source: 'VCToolsRedistDir' },
    ]);
  });

  // Red-green: compare the version strings instead of their numeric parts and '14.9.1' sorts
  // after '14.10.1', so the older redist is picked as the newest.
  it('orders redist versions numerically: 14.10.1 is newer than 14.9.1', () => {
    const older = makeRedist('14.9.1', BINDING_RUNTIME);
    const newer = makeRedist('14.10.1', BINDING_RUNTIME);
    const { candidates } = msvcRuntime.locateVcRedist({
      targetArch: 'x64',
      env: { VCToolsRedistDir: older.versionDir },
      runVswhere: () => [],
    });
    expect(candidates.map((candidate) => candidate.version)).toEqual(['14.9.1']);
    const both = msvcRuntime.locateVcRedist({
      targetArch: 'x64',
      env: { VCToolsRedistDir: older.versionDir },
      runVswhere: () => {
        // vswhere's install holding the 14.10.1 redist, laid out as Visual Studio does.
        const installationPath = path.resolve(newer.versionDir, '..', '..', '..', '..');
        fs.mkdirSync(path.join(installationPath, 'VC', 'Auxiliary', 'Build'), { recursive: true });
        fs.writeFileSync(path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.10.1\n');
        return [installationPath];
      },
    });
    expect(both.candidates.map((candidate) => candidate.version)).toEqual(['14.10.1', '14.9.1']);
  });

  it('finds nothing for an arch the redist does not carry', () => {
    const fromEnv = makeRedist('14.44.35112', BINDING_RUNTIME, 'x64');
    const { candidates, searched } = msvcRuntime.locateVcRedist({
      targetArch: 'arm64',
      env: { VCToolsRedistDir: fromEnv.versionDir },
      runVswhere: () => [],
    });
    expect(candidates).toEqual([]);
    expect(searched).toEqual([`VCToolsRedistDir=${fromEnv.versionDir}`]);
  });

  it('refuses an arch it has no redist directory name for', () => {
    expect(() => msvcRuntime.locateVcRedist({ targetArch: 'armv7l', env: {}, runVswhere: () => [] }))
      .toThrow(/no redist arch directory for target arch armv7l/);
  });
});
