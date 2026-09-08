/**
 * Builds a minidump from scratch, for tests that drive the native crash reader.
 *
 * It deliberately hardcodes its own offsets instead of importing them from
 * src/main/analytics/native-crash-event.ts. If both sides agreed on a wrong
 * stride the suite would go green while production dropped every native crash,
 * which is the one failure these fixtures exist to make impossible. For the same
 * reason it writes the real VS_FIXEDFILEINFO signature at module offset 24,
 * exactly where a real dump puts it: a reader that mistakes 24 for the name RVA
 * then reads 0xFEEF04BD as an offset, runs off the end of the buffer, and fails
 * loudly instead of quietly producing empty module names.
 *
 * The layout was checked against real Electron Crashpad dumps (103 and 144
 * modules), not only against the specification.
 *
 * WHY NO REAL DUMP IS COMMITTED. The project's external-parser convention asks
 * for a captured sample of the real format. A minidump cannot be one: it is a
 * snapshot of process memory, so it carries whatever the crashed process held,
 * and it runs to tens of megabytes in a public repo. The synthetic builder is
 * the standing exception, and the offsets above are what a real dump is checked
 * against by hand when the format moves.
 */

const HEADER_SIZE = 32;
const DIRECTORY_ENTRY_SIZE = 12;
const MODULE_RECORD_SIZE = 108;
const MODULE_NAME_RVA_AT = 20;
const FIXED_FILE_INFO_AT = 24;
const FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;
const CRASHPAD_SIMPLE_ANNOTATIONS_AT = 36;
const CRASHPAD_MODULE_LIST_AT = 44;
const MODULE_LIST_STREAM_TYPE = 4;
const CRASHPAD_INFO_STREAM_TYPE = 1129316353;
const MINIDUMP_VERSION = 0xa793;

export interface MinidumpFixtureOptions {
  modules?: string[];
  simpleAnnotations?: Record<string, string>;
  /** Unix seconds, as the header stores it. */
  timeDateStamp?: number;
  /**
   * Right-justify the module array by four bytes, which the format allows. A
   * value other than 0 or 4 writes a stride the reader cannot explain, which is
   * what its slack guard exists to reject.
   */
  moduleListSlack?: number;
  annotationDictionarySlack?: 0 | 4;
  /** 44 stops after simple_annotations; 52 is the original struct; 64 is current Crashpad. */
  crashpadInfoSize?: 44 | 52 | 64;
  omitModuleList?: boolean;
  omitCrashpadInfo?: boolean;
  /** Declare a module name length that is not a whole number of UTF-16 units. */
  oddLengthModuleName?: boolean;
  signature?: string;
  /** Zero-padded floor, so a fixture clears the reader's truncated-upload check. */
  minSize?: number;
}

export function buildMinidump(options: MinidumpFixtureOptions = {}): Buffer {
  const modules = options.modules ?? [];
  const annotations = options.simpleAnnotations ?? {};
  const minSize = options.minSize ?? 10000;
  const crashpadInfoSize = options.crashpadInfoSize ?? 64;
  const buffer = Buffer.alloc(Math.max(minSize, 128 * 1024));

  const streamCount = (options.omitModuleList ? 0 : 1) + (options.omitCrashpadInfo ? 0 : 1);
  const directoryRva = HEADER_SIZE;
  let cursor = HEADER_SIZE + streamCount * DIRECTORY_ENTRY_SIZE;
  const align = (): void => {
    cursor += (4 - (cursor % 4)) % 4;
  };

  const nameRvas = modules.map((moduleName) => {
    align();
    const rva = cursor;
    const encoded = Buffer.from(moduleName, 'utf16le');
    buffer.writeUInt32LE(options.oddLengthModuleName ? encoded.length + 1 : encoded.length, cursor);
    encoded.copy(buffer, cursor + 4);
    cursor += 4 + encoded.length + 2; // the trailing UTF-16 NUL the length excludes
    return rva;
  });

  const writeUtf8String = (text: string): number => {
    align();
    const rva = cursor;
    const encoded = Buffer.from(text, 'utf8');
    buffer.writeUInt32LE(encoded.length, cursor);
    encoded.copy(buffer, cursor + 4);
    cursor += 4 + encoded.length + 1; // the trailing NUL the length excludes
    return rva;
  };
  const annotationEntries = Object.entries(annotations).map(([key, value]) => ({
    keyRva: writeUtf8String(key),
    valueRva: writeUtf8String(value),
  }));

  let dictionaryRva = 0;
  let dictionarySize = 0;
  if (annotationEntries.length > 0) {
    const dictionarySlack = options.annotationDictionarySlack ?? 0;
    align();
    dictionaryRva = cursor;
    buffer.writeUInt32LE(annotationEntries.length, cursor);
    cursor += 4 + dictionarySlack;
    for (const entry of annotationEntries) {
      buffer.writeUInt32LE(entry.keyRva, cursor);
      buffer.writeUInt32LE(entry.valueRva, cursor + 4);
      cursor += 8;
    }
    dictionarySize = 4 + dictionarySlack + annotationEntries.length * 8;
  }

  let moduleListRva = 0;
  let moduleListSize = 0;
  if (!options.omitModuleList) {
    const moduleSlack = options.moduleListSlack ?? 0;
    align();
    moduleListRva = cursor;
    buffer.writeUInt32LE(modules.length, cursor);
    cursor += 4 + moduleSlack;
    for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
      const recordOffset = cursor;
      buffer.writeBigUInt64LE(BigInt(0x140000000 + moduleIndex * 0x10000), recordOffset);
      buffer.writeUInt32LE(0x1000, recordOffset + 8);
      buffer.writeUInt32LE(nameRvas[moduleIndex], recordOffset + MODULE_NAME_RVA_AT);
      buffer.writeUInt32LE(FIXED_FILE_INFO_SIGNATURE, recordOffset + FIXED_FILE_INFO_AT);
      cursor += MODULE_RECORD_SIZE;
    }
    moduleListSize = 4 + moduleSlack + modules.length * MODULE_RECORD_SIZE;
  }

  let crashpadRva = 0;
  if (!options.omitCrashpadInfo) {
    align();
    crashpadRva = cursor;
    buffer.writeUInt32LE(1, crashpadRva);
    buffer.writeUInt32LE(dictionarySize, crashpadRva + CRASHPAD_SIMPLE_ANNOTATIONS_AT);
    buffer.writeUInt32LE(dictionaryRva, crashpadRva + CRASHPAD_SIMPLE_ANNOTATIONS_AT + 4);
    if (crashpadInfoSize >= CRASHPAD_MODULE_LIST_AT + 8) {
      buffer.writeUInt32LE(0, crashpadRva + CRASHPAD_MODULE_LIST_AT);
      buffer.writeUInt32LE(0, crashpadRva + CRASHPAD_MODULE_LIST_AT + 4);
    }
    cursor += crashpadInfoSize;
  }

  buffer.write(options.signature ?? 'MDMP', 0, 4, 'ascii');
  buffer.writeUInt32LE(MINIDUMP_VERSION, 4);
  buffer.writeUInt32LE(streamCount, 8);
  buffer.writeUInt32LE(directoryRva, 12);
  buffer.writeUInt32LE(options.timeDateStamp ?? 0, 20);

  let entryOffset = directoryRva;
  if (!options.omitModuleList) {
    buffer.writeUInt32LE(MODULE_LIST_STREAM_TYPE, entryOffset);
    buffer.writeUInt32LE(moduleListSize, entryOffset + 4);
    buffer.writeUInt32LE(moduleListRva, entryOffset + 8);
    entryOffset += DIRECTORY_ENTRY_SIZE;
  }
  if (!options.omitCrashpadInfo) {
    buffer.writeUInt32LE(CRASHPAD_INFO_STREAM_TYPE, entryOffset);
    buffer.writeUInt32LE(crashpadInfoSize, entryOffset + 4);
    buffer.writeUInt32LE(crashpadRva, entryOffset + 8);
  }

  return buffer.subarray(0, Math.max(cursor, minSize));
}

/** DESKTOP-K: Homebrew ffmpeg's ffprobe, which loaded none of our images. */
export const FFPROBE_MODULES = [
  '/opt/homebrew/bin/ffprobe',
  '/opt/homebrew/Cellar/ffmpeg/8.1.1/lib/libavcodec.62.28.101.dylib',
  '/opt/homebrew/Cellar/x264/r3222/lib/libx264.165.dylib',
  '/usr/lib/dyld',
];

/** DESKTOP-N: a Puppeteer headless browser started from an agent's PTY. */
export const HEADLESS_SHELL_MODULES = [
  '/Users/dev/.cache/puppeteer/chrome-headless-shell/mac_arm-151.0.7922.77/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  '/usr/lib/libobjc.A.dylib',
  '/usr/lib/dyld',
];

/**
 * DESKTOP-E: a real Kangentic crash on macOS. Its crashpad annotations are empty
 * and the SDK tags it `event.process: unknown`, exactly like the two above,
 * which is why that tag cannot be the discriminator.
 */
export const MACOS_APP_MODULES = [
  '/Applications/Kangentic.app/Contents/MacOS/Kangentic',
  '/Applications/Kangentic.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  '/Applications/Kangentic.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  '/usr/lib/dyld',
];

/**
 * A Kangentic crash on Linux, where the install is a flat directory rather than
 * a bundle. Present so the suite has a fixture for the platform CI runs on.
 */
export const LINUX_APP_MODULES = [
  '/opt/Kangentic/kangentic',
  '/opt/Kangentic/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
  '/usr/lib/x86_64-linux-gnu/libc.so.6',
];

/** DESKTOP-M and DESKTOP-C: a real Kangentic browser-process crash on Windows. */
export const WINDOWS_APP_MODULES = [
  'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\Kangentic.exe',
  '\\\\?\\C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
  'C:\\WINDOWS\\SYSTEM32\\ntdll.dll',
];
