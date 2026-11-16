const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * The Microsoft C++ runtime that onnxruntime-node's Windows binding needs, shipped
 * beside it (Sentry DESKTOP-38).
 *
 * `onnxruntime_binding.node` and `onnxruntime.dll` import MSVCP140, VCRUNTIME140 and
 * their siblings. Electron links its own C runtime statically, so nothing in the
 * install provides them, and a Windows machine without the Visual C++
 * Redistributable (or with one older than the toolset onnxruntime was built with)
 * fails the embed worker's `require` with ERR_DLOPEN_FAILED on every fork.
 *
 * afterPack copies the DLLs from the build machine's Visual Studio redist folder
 * into the binding's directory (app-local deployment, which the redistributable's
 * terms allow). Windows searches the directory of a module loaded by full path
 * before System32, so the shipped copies win over any system copy. That is also why
 * a copy older than the toolset the binaries were linked with is worse than none:
 * it would replace a newer system copy and break machines that work today. The
 * build therefore fails unless the redist it finds is at least the highest linker
 * version among the binaries it serves.
 *
 * Which DLLs to copy is read from the binaries' import tables, not listed here, so
 * an onnxruntime bump that imports another runtime DLL fails the gate instead of
 * shipping without it.
 */

/** The Visual C++ runtime DLL names. vcomp140 (OpenMP) is listed so an import of it
 *  is noticed: it lives in a different redist folder, so staging fails on it loudly. */
const MSVC_RUNTIME_DLL_PATTERN = /^(msvcp140(_\w+)?|vcruntime140(_\w+)?|concrt140|vccorlib140|vcomp140)\.dll$/i;

/** Portable executable extensions that can import the runtime. */
const PE_EXTENSIONS = new Set(['.dll', '.node']);

/** targetArch (electron-builder's names) to the redist folder's arch directory. */
const REDIST_ARCH_DIRS = { x64: 'x64', arm64: 'arm64', ia32: 'x86' };

/** What a developer needs when the build cannot find a new enough runtime. The
 *  version comes from the binaries, so the hint follows an onnxruntime toolset bump. */
function installHint(floor) {
  return (
    `Install a Visual Studio whose C++ redist is ${floor} or later (Visual Studio 2026, or 2022 at a version ` +
    'that ships that toolset, or either one\'s Build Tools) with the "Desktop development with C++" workload and ' +
    'its redistributable component, Microsoft.VisualStudio.Component.VC.Redist.14.Latest, which holds the CRT ' +
    'folders this step copies. Or run the build from a Developer Command Prompt so VCToolsRedistDir points at one.'
  );
}

function isMsvcRuntimeDll(name) {
  return MSVC_RUNTIME_DLL_PATTERN.test(name);
}

/** Map an RVA to a file offset through the section table, or -1 when no section holds it. */
function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return rva - section.virtualAddress + section.rawPointer;
    }
  }
  return -1;
}

function readCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return '';
  const end = buffer.indexOf(0, offset);
  return buffer.toString('latin1', offset, end === -1 ? buffer.length : end);
}

/**
 * The linker version and the imported DLL names (normal and delay-loaded) of a PE
 * file. Throws on a buffer that is not a PE image.
 *
 * @param {Buffer} buffer
 * @returns {{ linkerVersion: [number, number], imports: string[] }}
 */
function readPeInfo(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE image (no MZ header)');
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('not a PE image (no PE signature)');
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  const linkerVersion = [buffer[optionalHeader + 2], buffer[optionalHeader + 3]];
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96);

  const sections = [];
  const sectionTable = optionalHeader + optionalHeaderSize;
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(entry + 8),
      virtualAddress: buffer.readUInt32LE(entry + 12),
      rawSize: buffer.readUInt32LE(entry + 16),
      rawPointer: buffer.readUInt32LE(entry + 20),
    });
  }

  const imports = [];
  // Data directory 1: the import table, 20-byte descriptors, name RVA at +12.
  const importRva = buffer.readUInt32LE(dataDirectories + 8);
  if (importRva !== 0) {
    let descriptor = rvaToOffset(sections, importRva);
    while (descriptor >= 0 && descriptor + 20 <= buffer.length) {
      const nameRva = buffer.readUInt32LE(descriptor + 12);
      if (nameRva === 0) break;
      imports.push(readCString(buffer, rvaToOffset(sections, nameRva)));
      descriptor += 20;
    }
  }
  // Data directory 13: the delay-load table, 32-byte descriptors, name RVA at +4.
  const delayRva = buffer.readUInt32LE(dataDirectories + 13 * 8);
  if (delayRva !== 0) {
    let descriptor = rvaToOffset(sections, delayRva);
    while (descriptor >= 0 && descriptor + 32 <= buffer.length) {
      const nameRva = buffer.readUInt32LE(descriptor + 4);
      if (nameRva === 0) break;
      imports.push(readCString(buffer, rvaToOffset(sections, nameRva)));
      descriptor += 32;
    }
  }
  return { linkerVersion, imports: imports.filter((name) => name.length > 0) };
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(text) {
  return String(text).trim().split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * The runtime DLLs the binaries in `binaryDir` import, lower-cased and sorted, and
 * the highest linker version among the binaries that import one. Every `.dll` and
 * `.node` in the directory is read, staged runtime DLLs included, so a runtime DLL
 * that imports another (msvcp140 imports vcruntime140) is covered too.
 */
function requiredMsvcRuntime(binaryDir) {
  const required = new Set();
  let linkerFloor = [0, 0];
  for (const name of fs.readdirSync(binaryDir)) {
    if (!PE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const { linkerVersion, imports } = readPeInfo(fs.readFileSync(path.join(binaryDir, name)));
    const runtimeImports = imports.filter(isMsvcRuntimeDll).map((importName) => importName.toLowerCase());
    if (runtimeImports.length === 0) continue;
    for (const importName of runtimeImports) required.add(importName);
    // A runtime DLL's own linker version says nothing about what the app's binaries need.
    if (!isMsvcRuntimeDll(name) && compareVersions(linkerVersion, linkerFloor) > 0) linkerFloor = linkerVersion;
  }
  return { required: [...required].sort(), linkerFloor };
}

/** The `Microsoft.VC14x.CRT` directory under one redist version and arch, or null. */
function findCrtDir(redistVersionDir, archDir) {
  const archPath = path.join(redistVersionDir, archDir);
  if (!fs.existsSync(archPath)) return null;
  const crt = fs.readdirSync(archPath).find((name) => /^Microsoft\.VC14\d\.CRT$/i.test(name));
  return crt ? path.join(archPath, crt) : null;
}

/** Every Visual Studio install vswhere reports. No `-requires` filter: an install
 *  counts when its redist folder holds the target arch's CRT, which
 *  `locateVcRedist` checks on disk, so an ARM64-only toolchain is not missed.
 *  `-utf8`, because vswhere otherwise prints in the console code page and a
 *  non-ASCII install path would not be found. */
function defaultRunVswhere(env) {
  const programFilesX86 = env['ProgramFiles(x86)'] || env.ProgramFiles;
  if (!programFilesX86) return [];
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return [];
  const stdout = execFileSync(
    vswhere,
    ['-all', '-products', '*', '-utf8', '-property', 'installationPath'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Every MSVC redist this build machine has for `targetArch`, newest first. Reads
 * `VCToolsRedistDir` (a Developer Command Prompt sets it) and every Visual Studio
 * install vswhere reports. A vswhere that fails is noted in `searched` and the
 * candidates already found stand.
 *
 * @returns {{ candidates: Array<{ version: string, crtDir: string, source: string }>, searched: string[] }}
 */
function locateVcRedist({ targetArch, env = process.env, runVswhere = defaultRunVswhere }) {
  const archDir = REDIST_ARCH_DIRS[targetArch];
  if (!archDir) throw new Error(`[afterPack] MSVC runtime: no redist arch directory for target arch ${targetArch}`);
  const candidates = [];
  const searched = [];

  if (env.VCToolsRedistDir) {
    const redistVersionDir = env.VCToolsRedistDir.replace(/[\\/]+$/, '');
    searched.push(`VCToolsRedistDir=${redistVersionDir}`);
    const crtDir = findCrtDir(redistVersionDir, archDir);
    if (crtDir) candidates.push({ version: path.basename(redistVersionDir), crtDir, source: 'VCToolsRedistDir' });
  }

  let installationPaths = [];
  try {
    installationPaths = runVswhere(env);
  } catch (error) {
    const reason = String((error && error.message) || error).split(/\r?\n/)[0];
    searched.push(`vswhere failed (${reason})`);
  }
  for (const installationPath of installationPaths) {
    const versionFile = path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt');
    if (!fs.existsSync(versionFile)) {
      searched.push(`${installationPath} (no C++ redist version file)`);
      continue;
    }
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    const crtDir = findCrtDir(path.join(installationPath, 'VC', 'Redist', 'MSVC', version), archDir);
    // An install can name a redist version and still lack its CRT folders, when
    // the C++ tools are installed without the redistributable component.
    searched.push(crtDir ? installationPath : `${installationPath} (redist ${version} has no ${archDir} CRT folder)`);
    if (crtDir) candidates.push({ version, crtDir, source: installationPath });
  }

  candidates.sort((left, right) => compareVersions(parseVersion(right.version), parseVersion(left.version)));
  return { candidates, searched };
}

/**
 * Copy the MSVC runtime DLLs the onnxruntime binaries in `binaryDir` import into
 * `binaryDir`, from the newest redist on this machine. A staged runtime DLL can
 * import another one, so the directory is read again after each copy until no
 * new name appears. Windows only; logs the skip elsewhere. Throws when no redist
 * is found, when the newest is older than the binaries' linker version, or when
 * it lacks a DLL they import. `hostPlatform` is the build machine's, which is
 * where the redist is read from.
 */
function stageMsvcRuntime({
  binaryDir,
  platform,
  targetArch,
  locate = locateVcRedist,
  log = console.log,
  hostPlatform = process.platform,
}) {
  if (platform !== 'win32') {
    log(`[afterPack] MSVC runtime: not needed on ${platform}, nothing to stage`);
    return;
  }
  const { required, linkerFloor } = requiredMsvcRuntime(binaryDir);
  if (required.length === 0) {
    log(`[afterPack] MSVC runtime: no binary in ${binaryDir} imports it, nothing to stage`);
    return;
  }
  const floor = linkerFloor.join('.');
  const { candidates, searched } = locate({ targetArch });
  const newest = candidates[0];
  if (!newest) {
    const hostNote = hostPlatform === 'win32'
      ? ''
      : ` This build runs on ${hostPlatform}, and the redist is read from the build machine, so package Windows on Windows.`;
    throw new Error(
      `[afterPack] MSVC runtime: onnxruntime-node imports ${required.join(', ')}, and this machine has no ` +
        `${targetArch} Visual C++ redist to ship them from (searched: ${searched.join('; ') || 'nothing found'}). ` +
        `The packaged embed worker would fail with ERR_DLOPEN_FAILED on a machine without the runtime.${hostNote} ` +
        installHint(floor),
    );
  }
  if (compareVersions(parseVersion(newest.version), linkerFloor) < 0) {
    throw new Error(
      `[afterPack] MSVC runtime: the newest ${targetArch} redist here is ${newest.version} (${newest.crtDir}), but ` +
        `onnxruntime-node was linked with ${floor}. Shipped beside the binding, an older runtime would override a ` +
        `newer system copy and break machines that work today. ${installHint(floor)}`,
    );
  }
  const copied = new Set();
  let pending = required;
  while (pending.length > 0) {
    const absent = pending.filter((name) => !fs.existsSync(path.join(newest.crtDir, name)));
    if (absent.length > 0) {
      throw new Error(
        `[afterPack] MSVC runtime: ${newest.crtDir} has no ${absent.join(', ')}, which onnxruntime-node or a ` +
          'runtime DLL it imports needs. It ships in another redist folder (vcomp140 is in Microsoft.VC14x.OpenMP), ' +
          'which stageMsvcRuntime in build/msvc-runtime.js does not copy from yet.',
      );
    }
    for (const name of pending) {
      fs.copyFileSync(path.join(newest.crtDir, name), path.join(binaryDir, name));
      copied.add(name);
    }
    // Read again with the copies in place: a staged DLL's own runtime imports
    // are staged on the next pass. The copies never raise the floor.
    pending = requiredMsvcRuntime(binaryDir).required.filter((name) => !copied.has(name));
  }
  log(
    `[afterPack] MSVC runtime: copied ${[...copied].sort().join(', ')} (redist ${newest.version}, binaries linked with ` +
      `${floor}) from ${newest.crtDir} beside onnxruntime_binding.node`,
  );
}

/**
 * The gate: every MSVC runtime DLL any binary in `binaryDir` imports must sit in
 * `binaryDir`. Throws naming each one that does not; logs the passing branch.
 */
function verifyMsvcRuntimeBesideBinding({ binaryDir, platform, log = console.log }) {
  if (platform !== 'win32') {
    log(`[afterPack] MSVC runtime: not checked on ${platform}`);
    return;
  }
  const present = new Set(fs.readdirSync(binaryDir).map((name) => name.toLowerCase()));
  const { required } = requiredMsvcRuntime(binaryDir);
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] MSVC runtime: ${missing.join(', ')} not beside onnxruntime_binding.node in ${binaryDir}. ` +
        'The packaged embed worker would fail with ERR_DLOPEN_FAILED on a Windows machine without the ' +
        'Visual C++ runtime (Sentry DESKTOP-38).',
    );
  }
  log(`[afterPack] MSVC runtime: ${required.join(', ') || 'nothing'} beside onnxruntime_binding.node`);
}

module.exports = {
  // Exported for the test that keeps verify-unpacked-worker.js's inlined copy
  // (the embed runtime probe's foreignMsvcRuntimeModules) in step with it.
  MSVC_RUNTIME_DLL_PATTERN,
  readPeInfo,
  requiredMsvcRuntime,
  locateVcRedist,
  stageMsvcRuntime,
  verifyMsvcRuntimeBesideBinding,
};
