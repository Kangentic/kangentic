import type { ErrorEvent } from '@sentry/electron/main';

/**
 * Reads the two facts a native crash event needs but cannot carry, straight out
 * of the minidump the Sentry SDK attaches to it.
 *
 * WHY THIS EXISTS. `@sentry/electron` uploads every minidump Crashpad wrote into
 * our database, and Sentry's server derives the stack, the loaded-image list and
 * the `crashpad` context from that file AFTER upload. At `beforeSend` time the
 * event has none of them: no stack, no images, no crashed-build version. Two
 * defects follow.
 *
 * 1. On macOS a task's mach exception ports are inherited across exec, so a
 *    process spawned from a Kangentic PTY writes ITS crashes into our database
 *    and we report them as ours. DESKTOP-K is Homebrew ffmpeg's `ffprobe`
 *    failing to start; DESKTOP-N is a Puppeteer `chrome-headless-shell`;
 *    DESKTOP-Q is `/usr/local/share/dotnet/dotnet`. None loaded a single
 *    Kangentic image.
 * 2. A dump uploaded after an upgrade wears the UPLOADING build's release tag and
 *    scope. DESKTOP-M crashed on 0.38.0 and is filed under 0.39.0, with
 *    breadcrumbs from a launch 21 minutes after the crash.
 *
 * WHY NOT THE SDK'S OWN ANNOTATIONS. The SDK parses only Crashpad's per-module
 * annotation OBJECTS, and on macOS those come back empty for real crashes too:
 * DESKTOP-E is a genuine Kangentic crash that still tags `event.process:
 * unknown`. Filtering on that tag would delete real crashes. The crashed build's
 * version lives somewhere else again, in the process-level simple-annotation
 * dictionary the SDK never reads.
 *
 * So both answers come from the dump bytes. The layout below was verified field
 * by field against real Electron Crashpad dumps; `ModuleNameRva` in particular
 * sits at module offset 20, and offset 24 is the `VS_FIXEDFILEINFO` signature
 * (`0xFEEF04BD`), which a reader that guesses 24 will happily treat as an RVA
 * and turn every module name into an empty string with no error.
 *
 * Everything here fails OPEN. A parse this module does not fully trust returns
 * `ok: false`, and the caller then keeps the event untouched: a foreign crash
 * that slips through is noise, a real crash dropped by a parser bug is gone.
 */

const MINIDUMP_SIGNATURE = 'MDMP';

/**
 * The SDK refuses to parse anything under 10 KB as a truncated upload, and real
 * dumps run to tens of megabytes. Keeping the same floor means this reader never
 * disagrees with the loader about what is a dump.
 */
const MINIMUM_MINIDUMP_BYTES = 10000;

const HEADER_STREAM_COUNT_OFFSET = 8;
const HEADER_STREAM_DIRECTORY_RVA_OFFSET = 12;
const HEADER_TIME_DATE_STAMP_OFFSET = 20;
const DIRECTORY_ENTRY_SIZE = 12;

const MODULE_LIST_STREAM_TYPE = 4;
const CRASHPAD_INFO_STREAM_TYPE = 1129316353;

/**
 * `MINIDUMP_MODULE` is 108 bytes on disk for both 32-bit and 64-bit dumps
 * (`BaseOfImage` is a u64 either way). Never derive this from a struct size: the
 * embedded u64 tail-pads the C struct to 112 under some ABIs, which is the
 * classic way to walk a module list off alignment and read plausible garbage.
 */
const MODULE_RECORD_SIZE = 108;
const MODULE_NAME_RVA_OFFSET = 20;

/**
 * `MINIDUMP_CRASHPAD_INFO`: version u32, report_id GUID, client_id GUID, then
 * `simple_annotations` and `module_list`. The SDK pins `module_list` at 44,
 * which is only consistent with `simple_annotations` at 36.
 */
const CRASHPAD_SIMPLE_ANNOTATIONS_OFFSET = 36;

/**
 * Gate on the two location descriptors being present, never on an exact size:
 * current Crashpad appends `reserved` and `address_mask`, so real dumps report
 * 64 where the original struct was 52.
 */
const MINIMUM_CRASHPAD_INFO_BYTES = 44;

const ANNOTATION_ENTRY_SIZE = 8;

/**
 * A stream list may be right-justified with four bytes of padding between the
 * count and the array. rust-minidump tolerates exactly that and nothing else, so
 * any other leftover means the stride is wrong and the walk must abort.
 */
const STREAM_LIST_PADDING_BYTES = 4;

const MAX_STREAM_COUNT = 512;
/**
 * A real Electron module list runs to a few hundred entries (144 and 103 in the
 * dumps this was checked against), so the SDK's 1000 is too tight here: it
 * bounds crashpad module LINKS, where the real value is 1.
 */
const MAX_MODULE_COUNT = 4096;
const MAX_ANNOTATION_COUNT = 1000;
const MAX_STRING_LENGTH = 1024 * 100;

/** Crashpad's key for the app version, set by Electron's crashReporter. */
const CRASHED_VERSION_ANNOTATION = '_version';

/**
 * The macOS framework bundle. Present in every real Kangentic dump on that
 * platform and in no foreign process's image list.
 */
const ELECTRON_FRAMEWORK_MODULE = 'Electron Framework';

/**
 * The header's `time_date_stamp` has one-second resolution and truncates down,
 * so a start time inside the crash's own second must not read as "after".
 */
const CRASH_TIME_RESOLUTION_MS = 1000;

const utf16Decoder = new TextDecoder('utf-16le');
const utf8Decoder = new TextDecoder('utf-8');

interface LocationDescriptor {
  dataSize: number;
  rva: number;
}

export type MinidumpIdentity =
  | {
      ok: true;
      /** Every loaded image path the dump records, in module-list order. */
      moduleNames: string[];
      /** The crashed process's own executable, which the module list leads with. */
      mainModule: string | undefined;
      /** Crashpad's process-level simple annotations (`_version`, `_productName`, ...). */
      annotations: Record<string, string>;
      /** When Crashpad wrote the dump. */
      crashTime: Date | undefined;
    }
  | { ok: false; reason: string };

export interface NativeCrashContext {
  /** The directory every image of a healthy install sits under. */
  installRoot: string;
  /** The app executable's file name, with extension. */
  appExecutableName: string;
  /** The version of the build doing the uploading, which is not the crashed one. */
  appVersion: string;
  /** Whether module paths compare case-insensitively, which is Windows only. */
  caseInsensitivePaths: boolean;
}

export type NativeCrashDecision =
  | { action: 'drop'; mainModule: string }
  | { action: 'keep'; event: ErrorEvent };

function requireRange(totalBytes: number, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > totalBytes) {
    throw new Error(`${what} runs past the end of the minidump`);
  }
}

function readLocationDescriptor(view: DataView, offset: number): LocationDescriptor {
  return {
    dataSize: view.getUint32(offset, true),
    rva: view.getUint32(offset + 4, true),
  };
}

/**
 * Both stream lists in this file are a u32 count followed by fixed-size records,
 * optionally right-justified by four bytes. Returns where the array starts.
 */
function readStreamListStart(
  view: DataView,
  location: LocationDescriptor,
  count: number,
  recordSize: number,
  what: string
): number {
  const slack = location.dataSize - 4 - count * recordSize;
  if (slack !== 0 && slack !== STREAM_LIST_PADDING_BYTES) {
    throw new Error(`${what} has ${slack} bytes the ${recordSize}-byte stride does not explain`);
  }
  return location.rva + 4 + slack;
}

function readUtf16String(view: DataView, data: Uint8Array, rva: number): string {
  requireRange(data.byteLength, rva, 4, 'a module name length');
  const byteLength = view.getUint32(rva, true);
  if (byteLength > MAX_STRING_LENGTH) {
    throw new Error(`module name length ${byteLength} exceeds ${MAX_STRING_LENGTH}`);
  }
  if (byteLength % 2 !== 0) {
    throw new Error('module name length is not a whole number of UTF-16 units');
  }
  requireRange(data.byteLength, rva + 4, byteLength, 'a module name');
  return utf16Decoder.decode(data.subarray(rva + 4, rva + 4 + byteLength));
}

function readUtf8String(view: DataView, data: Uint8Array, rva: number): string {
  requireRange(data.byteLength, rva, 4, 'an annotation length');
  const byteLength = view.getUint32(rva, true);
  if (byteLength > MAX_STRING_LENGTH) {
    throw new Error(`annotation length ${byteLength} exceeds ${MAX_STRING_LENGTH}`);
  }
  requireRange(data.byteLength, rva + 4, byteLength, 'an annotation');
  return utf8Decoder.decode(data.subarray(rva + 4, rva + 4 + byteLength));
}

function readModuleNames(view: DataView, data: Uint8Array, location: LocationDescriptor): string[] {
  requireRange(data.byteLength, location.rva, location.dataSize, 'the module list stream');
  if (location.dataSize < 4) {
    throw new Error('the module list stream is too small to hold a count');
  }
  const count = view.getUint32(location.rva, true);
  if (count > MAX_MODULE_COUNT) {
    throw new Error(`module count ${count} exceeds ${MAX_MODULE_COUNT}`);
  }
  const arrayStart = readStreamListStart(
    view,
    location,
    count,
    MODULE_RECORD_SIZE,
    'the module list'
  );

  const moduleNames: string[] = [];
  for (let moduleIndex = 0; moduleIndex < count; moduleIndex += 1) {
    const recordOffset = arrayStart + moduleIndex * MODULE_RECORD_SIZE;
    // Module name RVAs point outside this stream's payload, so they resolve
    // against the whole file, never against the stream slice.
    const nameRva = view.getUint32(recordOffset + MODULE_NAME_RVA_OFFSET, true);
    moduleNames.push(readUtf16String(view, data, nameRva));
  }
  return moduleNames;
}

function readSimpleAnnotations(
  view: DataView,
  data: Uint8Array,
  location: LocationDescriptor
): Record<string, string> {
  requireRange(data.byteLength, location.rva, location.dataSize, 'the crashpad info stream');
  if (location.dataSize < MINIMUM_CRASHPAD_INFO_BYTES) {
    throw new Error('the crashpad info stream is too small to hold its location descriptors');
  }

  const dictionary = readLocationDescriptor(
    view,
    location.rva + CRASHPAD_SIMPLE_ANNOTATIONS_OFFSET
  );
  // Crashpad writes a zeroed descriptor when there are no simple annotations.
  // Following it would read the file signature as an entry count.
  if (dictionary.rva === 0 || dictionary.dataSize === 0) return {};

  requireRange(data.byteLength, dictionary.rva, dictionary.dataSize, 'the annotation dictionary');
  if (dictionary.dataSize < 4) {
    throw new Error('the annotation dictionary is too small to hold a count');
  }
  const count = view.getUint32(dictionary.rva, true);
  if (count > MAX_ANNOTATION_COUNT) {
    throw new Error(`annotation count ${count} exceeds ${MAX_ANNOTATION_COUNT}`);
  }
  const entriesStart = readStreamListStart(
    view,
    dictionary,
    count,
    ANNOTATION_ENTRY_SIZE,
    'the annotation dictionary'
  );

  const annotations: Record<string, string> = {};
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const entryOffset = entriesStart + entryIndex * ANNOTATION_ENTRY_SIZE;
    const key = readUtf8String(view, data, view.getUint32(entryOffset, true));
    const value = readUtf8String(view, data, view.getUint32(entryOffset + 4, true));
    annotations[key] = value;
  }
  return annotations;
}

/**
 * Read the loaded-image list, Crashpad's simple annotations, and the crash time
 * out of a raw minidump. Never throws: an unreadable dump comes back as
 * `ok: false` so the caller can leave the event alone.
 */
export function readMinidumpIdentity(data: Uint8Array): MinidumpIdentity {
  try {
    if (data.byteLength < MINIMUM_MINIDUMP_BYTES) {
      return { ok: false, reason: `minidump is only ${data.byteLength} bytes` };
    }

    // A big-endian dump fails this too, which is why it comes first.
    const signature = String.fromCharCode(...data.subarray(0, 4));
    if (signature !== MINIDUMP_SIGNATURE) {
      return { ok: false, reason: `signature is '${signature}', not '${MINIDUMP_SIGNATURE}'` };
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const streamCount = view.getUint32(HEADER_STREAM_COUNT_OFFSET, true);
    if (streamCount > MAX_STREAM_COUNT) {
      return { ok: false, reason: `stream count ${streamCount} exceeds ${MAX_STREAM_COUNT}` };
    }
    const streamDirectoryRva = view.getUint32(HEADER_STREAM_DIRECTORY_RVA_OFFSET, true);
    requireRange(
      data.byteLength,
      streamDirectoryRva,
      streamCount * DIRECTORY_ENTRY_SIZE,
      'the stream directory'
    );
    const timeDateStamp = view.getUint32(HEADER_TIME_DATE_STAMP_OFFSET, true);

    let moduleNames: string[] | undefined;
    let annotations: Record<string, string> | undefined;

    for (let streamIndex = 0; streamIndex < streamCount; streamIndex += 1) {
      const entryOffset = streamDirectoryRva + streamIndex * DIRECTORY_ENTRY_SIZE;
      const streamType = view.getUint32(entryOffset, true);
      if (streamType !== MODULE_LIST_STREAM_TYPE && streamType !== CRASHPAD_INFO_STREAM_TYPE) {
        continue;
      }
      const location = readLocationDescriptor(view, entryOffset + 4);
      if (streamType === MODULE_LIST_STREAM_TYPE) {
        moduleNames = readModuleNames(view, data, location);
      } else {
        annotations = readSimpleAnnotations(view, data, location);
      }
    }

    // Without the image list there is no ownership question to answer, so this
    // is a refusal to decide rather than a verdict of "not ours".
    if (!moduleNames) {
      return { ok: false, reason: 'minidump carries no module list stream' };
    }

    return {
      ok: true,
      moduleNames,
      mainModule: moduleNames[0],
      annotations: annotations ?? {},
      crashTime: timeDateStamp > 0 ? new Date(timeDateStamp * 1000) : undefined,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unreadable minidump' };
  }
}

/**
 * The last path segment, splitting on either separator. `path.basename` splits
 * on the HOST's separator, and these paths come from the crashed machine, so a
 * Windows dump read on a Linux CI runner would come back whole.
 */
function moduleBasename(modulePath: string): string {
  const separator = Math.max(modulePath.lastIndexOf('/'), modulePath.lastIndexOf('\\'));
  return separator === -1 ? modulePath : modulePath.slice(separator + 1);
}

/**
 * A prefix match that stops at a path-segment boundary. A bare `startsWith`
 * would read a sibling install as ours: `...\Programs\Kangentic` is a string
 * prefix of `...\Programs\KangenticBeta\injected.dll`, which shares no
 * directory with us at all. Both separators are accepted because the path being
 * tested comes from the crashed machine, not this one.
 */
function isUnderPathRoot(candidatePath: string, root: string): boolean {
  if (root.length === 0 || !candidatePath.startsWith(root)) return false;
  if (root.endsWith('/') || root.endsWith('\\')) return true;
  const characterAfterRoot = candidatePath.charAt(root.length);
  return characterAfterRoot === '' || characterAfterRoot === '/' || characterAfterRoot === '\\';
}

function isOurModule(modulePath: string, context: NativeCrashContext): boolean {
  const comparablePath = context.caseInsensitivePaths ? modulePath.toLowerCase() : modulePath;
  const comparableRoot = context.caseInsensitivePaths
    ? context.installRoot.toLowerCase()
    : context.installRoot;
  if (isUnderPathRoot(comparablePath, comparableRoot)) return true;

  // A basename match survives the app being moved between the crash and the
  // upload, which a path prefix on its own would not. It cannot collide with a
  // Kangentic checkout in the path either, because there `kangentic` is always a
  // directory component and never the file name.
  const comparableExecutable = context.caseInsensitivePaths
    ? context.appExecutableName.toLowerCase()
    : context.appExecutableName;
  if (comparableExecutable.length > 0 && moduleBasename(comparablePath) === comparableExecutable) {
    return true;
  }

  return modulePath.includes(ELECTRON_FRAMEWORK_MODULE);
}

/**
 * Swap the version in `Kangentic@0.39.0` while keeping whatever prefix is there,
 * so the bundler plugins stay the single source of the release naming.
 *
 * A release with no `@` is left alone rather than replaced with a bare version:
 * that would file the event under a release name no build ever published, which
 * is worse than the wrong-but-real tag. `native_crash.crashed_version` still
 * carries the truth in that case.
 */
function withReleaseVersion(release: string, version: string): string {
  const separator = release.lastIndexOf('@');
  return separator === -1 ? release : `${release.slice(0, separator + 1)}${version}`;
}

function startedAfterCrash(appStartTime: unknown, crashTime: Date | undefined): boolean {
  if (typeof appStartTime !== 'string' || !crashTime) return false;
  const startedAt = Date.parse(appStartTime);
  if (Number.isNaN(startedAt)) return false;
  return startedAt > crashTime.getTime() + CRASH_TIME_RESOLUTION_MS;
}

/**
 * Decide what to do with a native crash event, given what its minidump says.
 *
 * Drops a crash that loaded none of our images. Otherwise corrects the event in
 * place: the breadcrumbs and, where they provably describe the uploading run
 * rather than the crashed one, the release tag and the app context.
 */
export function correctNativeCrashEvent(
  event: ErrorEvent,
  identity: MinidumpIdentity,
  context: NativeCrashContext
): NativeCrashDecision {
  // An unreadable dump is not evidence of anything. Keep the event.
  if (!identity.ok) return { action: 'keep', event };

  if (
    identity.moduleNames.length > 0 &&
    !identity.moduleNames.some((moduleName) => isOurModule(moduleName, context))
  ) {
    return {
      action: 'drop',
      // The basename only: a full path carries the crashing user's home directory.
      mainModule: moduleBasename(identity.mainModule ?? '') || 'unknown',
    };
  }

  // Normalized once, because three separate guards below read this and two of
  // them test truthiness while a third tested only `undefined`. An empty
  // `_version` would have passed the third, deleting the app context's memory
  // and start-time fields and reporting `scope_corrected` while leaving the
  // version it was supposed to correct untouched.
  const crashedVersion = identity.annotations[CRASHED_VERSION_ANNOTATION] || undefined;

  // Only a dump FOUND AT STARTUP describes a process this one did not watch die.
  // The SDK's other two native paths fire from `render-process-gone` and
  // `child-process-gone` in the running session: they build the event fresh, so
  // its scope really is the crashed session's, and they are the only paths that
  // stamp `exit.reason`. The startup scan is the one that replays a stored
  // previous-run scope, and the one whose scope can therefore belong to a
  // different run entirely. Correcting the other two would delete a good trail.
  const foundAtStartup = event.tags?.['exit.reason'] === undefined;

  let releaseCorrected = false;
  let scopeCorrected = false;

  if (foundAtStartup) {
    // The SDK applies the stored previous-run scope and then the CURRENT scope's
    // breadcrumbs on top, so a startup-found event carries some of the uploading
    // session's trail and the two runs cannot be separated after the fact.
    delete event.breadcrumbs;

    if (crashedVersion && event.release) {
      const correctedRelease = withReleaseVersion(event.release, crashedVersion);
      if (correctedRelease !== event.release) {
        event.release = correctedRelease;
        releaseCorrected = true;
      }
    }

    // Unlike breadcrumbs this block comes wholesale from one run, so it is either
    // the crashed run's and worth keeping, or the uploader's and worth correcting.
    const appContext = event.contexts?.app;
    if (appContext) {
      const describesTheUploader =
        startedAfterCrash(appContext.app_start_time, identity.crashTime) ||
        (crashedVersion !== undefined &&
          typeof appContext.app_version === 'string' &&
          appContext.app_version !== crashedVersion);
      if (describesTheUploader) {
        if (crashedVersion) appContext.app_version = crashedVersion;
        delete appContext.app_start_time;
        delete appContext.app_memory;
        delete appContext.free_memory;
        scopeCorrected = true;
      }
    }
  }

  event.contexts = {
    ...event.contexts,
    native_crash: {
      crash_time: identity.crashTime?.toISOString(),
      crashed_version: crashedVersion,
      uploaded_by_version: context.appVersion,
      main_module: identity.mainModule ? moduleBasename(identity.mainModule) : undefined,
      module_count: identity.moduleNames.length,
      found_at_startup: foundAtStartup,
      release_corrected: releaseCorrected,
      scope_corrected: scopeCorrected,
    },
  };

  return { action: 'keep', event };
}
