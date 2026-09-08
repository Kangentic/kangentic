import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';
import {
  correctNativeCrashEvent,
  readMinidumpIdentity,
  type NativeCrashContext,
} from '../../src/main/analytics/native-crash-event';
import {
  buildMinidump,
  FFPROBE_MODULES,
  HEADLESS_SHELL_MODULES,
  LINUX_APP_MODULES,
  MACOS_APP_MODULES,
  WINDOWS_APP_MODULES,
} from '../fixtures/minidump-fixture';

const CRASH_TIME = '2026-09-08T14:46:43.000Z';
const CRASH_TIME_STAMP = Math.floor(Date.parse(CRASH_TIME) / 1000);

const MACOS_CONTEXT: NativeCrashContext = {
  installRoot: '/Applications/Kangentic.app/Contents',
  appExecutableName: 'Kangentic',
  appVersion: '0.39.0',
  caseInsensitivePaths: false,
};

const WINDOWS_CONTEXT: NativeCrashContext = {
  installRoot: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic',
  appExecutableName: 'Kangentic.exe',
  appVersion: '0.39.0',
  caseInsensitivePaths: true,
};

const LINUX_CONTEXT: NativeCrashContext = {
  installRoot: '/opt/Kangentic',
  appExecutableName: 'kangentic',
  appVersion: '0.39.0',
  caseInsensitivePaths: false,
};

function nativeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    level: 'fatal',
    platform: 'native',
    release: 'Kangentic@0.39.0',
    tags: { 'event.environment': 'native', 'event.process': 'unknown' },
    breadcrumbs: [
      { category: 'electron', message: 'powerMonitor.newListener', timestamp: 1 },
      { category: 'electron', message: 'browser-window-focus', timestamp: 2 },
    ],
    contexts: {
      app: {
        app_name: 'Kangentic',
        app_version: '0.39.0',
        app_start_time: '2026-09-08T15:07:52.573Z',
        app_memory: 343990272,
        free_memory: 13662547968,
        app_arch: 'x64',
      },
    },
    ...overrides,
  } as ErrorEvent;
}

describe('readMinidumpIdentity', () => {
  it('reads module names, crashpad simple annotations, and the crash time', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: MACOS_APP_MODULES,
        simpleAnnotations: { _productName: 'Kangentic', _version: '0.38.0', prod: 'Electron' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );

    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.moduleNames).toEqual(MACOS_APP_MODULES);
    expect(identity.mainModule).toBe('/Applications/Kangentic.app/Contents/MacOS/Kangentic');
    expect(identity.annotations._version).toBe('0.38.0');
    expect(identity.annotations._productName).toBe('Kangentic');
    expect(identity.crashTime?.toISOString()).toBe(CRASH_TIME);
  });

  it('accepts a module list right-justified by four bytes of padding', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: FFPROBE_MODULES, moduleListSlack: 4, annotationDictionarySlack: 4, simpleAnnotations: { _version: '0.38.0' } })
    );

    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.moduleNames).toEqual(FFPROBE_MODULES);
    expect(identity.annotations._version).toBe('0.38.0');
  });

  it('reads a crashpad info block that predates the address_mask field', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: MACOS_APP_MODULES,
        simpleAnnotations: { _version: '0.38.0' },
        crashpadInfoSize: 52,
      })
    );

    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.annotations._version).toBe('0.38.0');
  });

  it('treats a zeroed annotation dictionary as absent rather than following it', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: MACOS_APP_MODULES, simpleAnnotations: {} })
    );

    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.annotations).toEqual({});
    expect(identity.moduleNames).toEqual(MACOS_APP_MODULES);
  });

  it.each([
    ['a buffer under the truncated-upload floor', buildMinidump({ modules: FFPROBE_MODULES, minSize: 0 })],
    ['a wrong signature', buildMinidump({ modules: FFPROBE_MODULES, signature: 'PMDM' })],
    ['no module list stream', buildMinidump({ omitModuleList: true, simpleAnnotations: { _version: '0.38.0' } })],
    ['an odd module name length', buildMinidump({ modules: FFPROBE_MODULES, oddLengthModuleName: true })],
    ['pure garbage', Buffer.alloc(20000, 0x5a)],
  ])('refuses to decide on %s', (_label, data) => {
    const identity = readMinidumpIdentity(data);
    expect(identity.ok).toBe(false);
  });

  it('refuses a module list whose slack the record stride cannot explain', () => {
    // The format allows exactly zero or four bytes of right-justify padding
    // between the count and the array. A slack of two is neither, so the walk
    // must abort rather than read the array two bytes off. Pinning only
    // `ok: false` would also pass if the guard were deleted and the walk simply
    // failed some other way further down, so the reason is asserted too.
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: FFPROBE_MODULES, moduleListSlack: 2 })
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toMatch(/does not explain/);
  });
});

describe('correctNativeCrashEvent: crashes that are not ours', () => {
  it('drops an ffprobe crash that inherited our crash handler', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: FFPROBE_MODULES, simpleAnnotations: { _version: '0.38.0' } })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('drop');
    if (decision.action !== 'drop') return;
    // A basename, never a path: the full one carries the crashing user's home.
    expect(decision.mainModule).toBe('ffprobe');
  });

  it('drops a headless browser crash', () => {
    const identity = readMinidumpIdentity(buildMinidump({ modules: HEADLESS_SHELL_MODULES }));
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('drop');
    if (decision.action !== 'drop') return;
    expect(decision.mainModule).toBe('chrome-headless-shell');
  });

  it('keeps a real macOS crash, which carries the same event.process tag as the two above', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: MACOS_APP_MODULES, simpleAnnotations: {} })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps a real Windows crash', () => {
    const identity = readMinidumpIdentity(buildMinidump({ modules: WINDOWS_APP_MODULES }));
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps a crash from an install that has since moved, on the executable name alone', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: ['/Users/dev/Applications/Kangentic.app/Contents/MacOS/Kangentic', '/usr/lib/dyld'] })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps a dump whose module list is empty, which is an absent answer not a negative one', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: [], simpleAnnotations: { _version: '0.38.0' } })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps the event when the dump could not be read, rather than assuming it is foreign', () => {
    const decision = correctNativeCrashEvent(
      nativeEvent(),
      readMinidumpIdentity(Buffer.alloc(20000, 0x5a)),
      MACOS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    // Nothing was corrected either: an unreadable dump is evidence of nothing.
    expect(decision.event.breadcrumbs).toHaveLength(2);
    expect(decision.event.release).toBe('Kangentic@0.39.0');
    expect(decision.event.contexts?.native_crash).toBeUndefined();
  });
});

describe('correctNativeCrashEvent: isOurModule boundaries', () => {
  it('drops a sibling install whose path is a bare string prefix of ours but not a real subdirectory', () => {
    // A bare `startsWith` would read this as ours: '...\Programs\Kangentic' is a
    // string prefix of '...\Programs\KangenticBeta\...'. Neither module name
    // here matches the executable basename or carries 'Electron Framework', so
    // this only drops if the path-root check enforces a segment boundary.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: [
          'C:\\Users\\dev\\AppData\\Local\\Programs\\KangenticBeta\\KangenticBeta.exe',
          'C:\\Users\\dev\\AppData\\Local\\Programs\\KangenticBeta\\resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
        ],
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('drop');
  });

  it('keeps a module that is a genuine subdirectory of the install root', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: [
          'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
        ],
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps a crash whose only match is the Electron Framework substring', () => {
    // Every other fixture that carries 'Electron Framework' also carries our own
    // executable, which short-circuits the `.some()` first. This is our own
    // GPU helper process running from a relocated copy of the app, outside the
    // configured install root and with a basename that does not match the main
    // executable, so only the substring branch fires.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: [
          '/Users/dev/Downloads/Kangentic.app/Contents/Frameworks/Kangentic Helper (GPU).app/Contents/MacOS/Kangentic Helper (GPU)',
          '/Users/dev/Downloads/Kangentic.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
          '/usr/lib/dyld',
        ],
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, MACOS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('matches a Windows install path case-insensitively', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: [
          'c:\\users\\dev\\appdata\\local\\programs\\kangentic\\kangentic.exe',
          'C:\\WINDOWS\\SYSTEM32\\ntdll.dll',
        ],
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('keeps a real Linux crash', () => {
    const identity = readMinidumpIdentity(buildMinidump({ modules: LINUX_APP_MODULES }));
    const decision = correctNativeCrashEvent(nativeEvent(), identity, LINUX_CONTEXT);

    expect(decision.action).toBe('keep');
  });

  it('drops a foreign crash on Linux, the platform CI runs the unit tier on', () => {
    const identity = readMinidumpIdentity(buildMinidump({ modules: FFPROBE_MODULES }));
    const decision = correctNativeCrashEvent(nativeEvent(), identity, LINUX_CONTEXT);

    expect(decision.action).toBe('drop');
  });

  it('does not recognize a long-path-prefixed module as being under the install root', () => {
    // WINDOWS_APP_MODULES carries this same path, but its unprefixed executable
    // entry always matches first, so no existing test exercises this path alone.
    // The '\\?\' prefix defeats the install-root `startsWith`, the basename
    // 'conpty.node' does not match the app executable, and there is no
    // 'Electron Framework' substring, so the module drops. This pins the
    // CURRENT behavior; it is not a fix.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: [
          '\\\\?\\C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
        ],
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('drop');
    if (decision.action !== 'drop') return;
    expect(decision.mainModule).toBe('conpty.node');
  });
});

describe('correctNativeCrashEvent: the uploading run is not the crashed run', () => {
  it('reattributes a dump uploaded by a later build to the build that crashed', () => {
    // DESKTOP-M: crashed on 0.38.0 at 14:46, uploaded by 0.39.0 at 15:07.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: WINDOWS_APP_MODULES,
        simpleAnnotations: { _productName: 'Kangentic', _version: '0.38.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(nativeEvent(), identity, WINDOWS_CONTEXT);

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.release).toBe('Kangentic@0.38.0');
    expect(decision.event.contexts?.app?.app_version).toBe('0.38.0');
    expect(decision.event.contexts?.app?.app_start_time).toBeUndefined();
    expect(decision.event.contexts?.app?.app_memory).toBeUndefined();
    expect(decision.event.contexts?.app?.free_memory).toBeUndefined();
    // The fields that describe the machine rather than the run survive.
    expect(decision.event.contexts?.app?.app_arch).toBe('x64');
    expect(decision.event.contexts?.native_crash).toMatchObject({
      crashed_version: '0.38.0',
      uploaded_by_version: '0.39.0',
      main_module: 'Kangentic.exe',
      release_corrected: true,
      scope_corrected: true,
    });
  });

  it('leaves the release alone when the crashed build is the one reporting', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: WINDOWS_APP_MODULES,
        simpleAnnotations: { _version: '0.39.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({
        contexts: { app: { app_version: '0.39.0', app_start_time: '2026-09-08T08:12:26.709Z' } },
      }),
      identity,
      WINDOWS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.release).toBe('Kangentic@0.39.0');
    expect(decision.event.contexts?.app?.app_start_time).toBe('2026-09-08T08:12:26.709Z');
    expect(decision.event.contexts?.native_crash).toMatchObject({
      release_corrected: false,
      scope_corrected: false,
    });
  });

  it('corrects the app context on a version mismatch alone, when the start time is not after the crash', () => {
    // describesTheUploader is startedAfterCrash(...) OR a version mismatch.
    // Every other test in this file satisfies both disjuncts at once, so this
    // isolates the version-mismatch half: the app started well before the
    // crash, which keeps startedAfterCrash false, yet the version still
    // differs from what the dump says crashed.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: WINDOWS_APP_MODULES,
        simpleAnnotations: { _version: '0.38.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({
        contexts: {
          app: { app_version: '0.39.0', app_start_time: '2026-09-08T08:12:26.709Z' },
        },
      }),
      identity,
      WINDOWS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.contexts?.app?.app_version).toBe('0.38.0');
    expect(decision.event.contexts?.app?.app_start_time).toBeUndefined();
    expect(decision.event.contexts?.native_crash).toMatchObject({ scope_corrected: true });
  });

  it('does not treat a start time inside the crash second as after the crash', () => {
    // The header's time_date_stamp truncates to whole seconds, so a start time
    // a few hundred milliseconds after the crash must not read as "after". The
    // app_version here equals the dump's _version so the version disjunct
    // cannot also fire and mask the boundary.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: WINDOWS_APP_MODULES,
        simpleAnnotations: { _version: '0.38.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({
        contexts: {
          app: { app_version: '0.38.0', app_start_time: '2026-09-08T14:46:43.400Z' },
        },
      }),
      identity,
      WINDOWS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.contexts?.app?.app_start_time).toBe('2026-09-08T14:46:43.400Z');
    expect(decision.event.contexts?.native_crash).toMatchObject({ scope_corrected: false });
  });

  it('keeps whatever prefix the release name already uses', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: WINDOWS_APP_MODULES, simpleAnnotations: { _version: '0.38.0' } })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({ release: 'kangentic-desktop@0.39.0' }),
      identity,
      WINDOWS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.release).toBe('kangentic-desktop@0.38.0');
  });

  it('leaves a release with no version separator alone rather than inventing a name', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({ modules: WINDOWS_APP_MODULES, simpleAnnotations: { _version: '0.38.0' } })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({ release: '9f3a1c2' }),
      identity,
      WINDOWS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    // A bare '0.38.0' would file the event under a release no build published.
    expect(decision.event.release).toBe('9f3a1c2');
    expect(decision.event.contexts?.native_crash).toMatchObject({
      crashed_version: '0.38.0',
      release_corrected: false,
    });
  });

  it('leaves a crash the running session watched happen entirely alone', () => {
    // A `render-process-gone` or `child-process-gone` event is built fresh in the
    // session that crashed, never from a stored previous-run scope, so its
    // breadcrumbs and app context are the crashed session's and correcting them
    // would delete a good trail. Those are the two paths that stamp exit.reason.
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: MACOS_APP_MODULES,
        simpleAnnotations: { _version: '0.38.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({
        tags: { 'event.environment': 'native', 'event.process': 'renderer', 'exit.reason': 'crashed' },
      }),
      identity,
      MACOS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    expect(decision.event.breadcrumbs).toHaveLength(2);
    expect(decision.event.release).toBe('Kangentic@0.39.0');
    expect(decision.event.contexts?.app?.app_start_time).toBe('2026-09-08T15:07:52.573Z');
    expect(decision.event.contexts?.native_crash).toMatchObject({
      found_at_startup: false,
      release_corrected: false,
      scope_corrected: false,
    });
  });

  it('still checks ownership on a live crash event, which can pick up a stray foreign dump', () => {
    const identity = readMinidumpIdentity(buildMinidump({ modules: FFPROBE_MODULES }));
    const decision = correctNativeCrashEvent(
      nativeEvent({
        tags: { 'event.environment': 'native', 'event.process': 'renderer', 'exit.reason': 'crashed' },
      }),
      identity,
      MACOS_CONTEXT
    );

    expect(decision.action).toBe('drop');
  });

  it('drops the breadcrumbs on every kept startup-found event, corrected or not', () => {
    const identity = readMinidumpIdentity(
      buildMinidump({
        modules: MACOS_APP_MODULES,
        simpleAnnotations: { _version: '0.39.0' },
        timeDateStamp: CRASH_TIME_STAMP,
      })
    );
    const decision = correctNativeCrashEvent(
      nativeEvent({
        contexts: { app: { app_version: '0.39.0', app_start_time: '2026-09-08T08:12:26.709Z' } },
      }),
      identity,
      MACOS_CONTEXT
    );

    expect(decision.action).toBe('keep');
    if (decision.action !== 'keep') return;
    // The SDK merges the CURRENT scope's crumbs on top of the stored previous
    // run's, so the two runs cannot be told apart after the fact.
    expect(decision.event.breadcrumbs).toBeUndefined();
  });
});
