---
type: Design
title: GPU process failures
description: Why an unusable GPU process kills the browser process (Chromium's fallback ladder, Linux zygote launch failures), why --disable-gpu alone does not help, and how the --in-process-gpu recovery, gpu-health.json records and the graphicsAccelerationEnabled setting work.
tags: [gpu, chromium, recovery, linux]
sources:
  - resource: src/main/diagnostics/gpu-health.ts
  - resource: src/main/diagnostics/linux-gpu-zygote.ts
---
# GPU process failures

The fatal is not a Linux problem, although one route to it is. DESKTOP-W is a `LOG(FATAL)`
browser-process kill via `OnProcessLaunchFailed`, seen on three Linux installs: Ubuntu 24.04,
NixOS and CachyOS. DESKTOP-15 is a recovered GPU death on the Ubuntu box three days later.
DESKTOP-18 is the identical `LOG(FATAL)` on Windows 10, via `OnProcessCrashed` with
`EXCEPTION_BREAKPOINT`, on an Intel UHD 630. The shipped code has never had a platform gate. The
launch-failure route is Linux's in practice, because of how Linux launches the GPU process (see
"Why a Linux launch failure left no trace before Electron 44" below).

DESKTOP-18 is worth reading for its timing rather than its stack. All seven of that install's
runs died between 8.3 and 12.0 seconds after their own `app_start_time`, so Chromium walked its
entire fallback ladder within nine seconds of boot, seven times, and the user never got in. That
rules out anything the app itself was doing: no agent, terminal, or embedding work exists that
early, and the software-GL rung does not touch the display driver at all. It is a host problem,
and the app's job is to survive it rather than diagnose it.

`--disable-gpu` (which `app.disableHardwareAcceleration()` appends, along with disabling the
GpuDataManager, and only before the app is ready) is still not a fix on its own, on either
platform. The reasoning is worth keeping so a future GPU issue does not re-derive it and ship the
flag that does not work.

Chromium's own fallback ladder (`content/browser/gpu/gpu_data_manager_impl_private.cc`,
`GpuDataManagerImplPrivate::InitializeGpuModes`) pushes `DISPLAY_COMPOSITOR` and, if allowed,
`SOFTWARE_GL` onto `fallback_modes_` **before** checking `--disable-gpu`, and
`FallBackToNextGpuMode` pops from the back. So the full pop order is hardware GL ->
`SOFTWARE_GL` -> `DISPLAY_COMPOSITOR` -> empty list -> `LOG(FATAL)`
(`IntentionallyCrashBrowserForUnusableGpuProcess`, whose message - `"GPU process isn't usable.
Goodbye."` - is exactly what DESKTOP-W's minidump carried). A fallback driven by crashes or launch
failures goes through `FallBackToNextGpuModeDueToCrash`, which skips `SOFTWARE_GL` unless a feature
allows it. On Electron 41 that makes the fatal the sixth counted failure: three on hardware, then
three on `DISPLAY_COMPOSITOR` (measured on Linux, below). Either way the last rung is
`DISPLAY_COMPOSITOR`, which already runs without the display driver. `--disable-gpu` starts
Chromium lower in that same list: on `SOFTWARE_GL` where it is allowed, otherwise on
`DISPLAY_COMPOSITOR`. The Linux measurement below reads exactly like `DISPLAY_COMPOSITOR`, while
Windows reads like `SOFTWARE_GL`. Either way, a GPU process that cannot even launch reaches the
identical `LOG(FATAL)`, only faster. A launch failure is not something a rendering-mode flag can
route around. The same holds for DESKTOP-18's crash shape on Windows, because reaching the fatal at
all means the rungs below hardware had already been current and had already failed.

## Why a Linux launch failure left no trace before Electron 44

On Linux the GPU process is not launched directly. `GpuSandboxedProcessLauncherDelegate::GetZygote`
forks it from the unsandboxed zygote, so a GPU "launch failure" means
`ZygoteCommunication::ForkRequest` returned no process. When that zygote is gone, two things happen
at once:

- The running GPU process's death reads as a normal exit. `GetTerminationStatus` defaults to
  `TERMINATION_STATUS_NORMAL_TERMINATION` when the zygote cannot answer, and
  `BrowserChildProcessHostImpl::OnChildDisconnected` drops that status with no crash count and no
  observer call, so no `child-process-gone` fires.
- Every relaunch through the dead zygote fails to launch. Through Electron 41 none of those reached
  JS: `electron_api_app.cc` overrode `BrowserChildProcessCrashed` and `BrowserChildProcessKilled`
  but not `BrowserChildProcessLaunchFailed`. Electron 44 overrides it and emits
  `child-process-gone` with reason `launch-failed` for every relaunch Chromium survives. The one
  that ends in the fatal still does not reach JS, because Chromium runs the delegate that reaches
  the fatal before it notifies any observer.

Reproduced in Electron 41.10.7 on Ubuntu 24.04 under WSLg, with `--ignore-gpu-blocklist` so that
compositing starts on the GPU: SIGKILL the `--type=zygote --no-zygote-sandbox` process, then the GPU
process. The browser logged `Failed to send GetTerminationStatus message to zygote`, six
`GPU process launch failed: error_code=1002` inside 2 ms, and the fatal. JS saw no
`child-process-gone` at all. That is DESKTOP-W's stack, and it is why the 0.43.0 crash left
`gpu-health.json` empty. All three DESKTOP-W installs sent Sentry nothing but the fatal, 25 s,
3 min and 4 min into their runs. Why the zygote or its fork failed on those hosts is still unknown.
A dead zygote and a fork refused at the process limit produce the same stack, so each recorded
fallback on Linux now carries the answer (below).

The same steps on Electron 44.5.1, same machine (2026-10-04): six launch failures and the fatal
again, but the first five reached JS as `child-process-gone` with `launch-failed` (exit code 1002),
and `gpu-health.json` held all five as fault deaths when the process died. So on 44 the next launch
can see that the GPU ended the run, and the software-rendering recovery engages from the deaths
alone; `tests/unit/gpu-health.test.ts` pins that measured record. The fallback record below is
still what covers a machine that dies with no relaunch to fail.

What does reach JS is the fallback itself. Falling back to `DISPLAY_COMPOSITOR` calls
`OnGpuBlocked`, which notifies `gpu-info-update`, and `gpu_compositing` reads `disabled_software`
from then on. The notify is posted a full GPU launch round trip before the fatal, so the listener
runs first by queue order, not by a margin of time. In the reproduction, a synchronous write from
that listener was on disk before the process died, in the same millisecond as the fatal. Killing
the GPU process alone, with the zygote alive, walks the same ladder by crashes
instead: six SIGKILLs produced five `child-process-gone` events, the fallback's `gpu-info-update`
arrived 1 ms after the third, and the sixth kill, the fatal one, was never announced.

## The recovery

The switch that does work is `--in-process-gpu`: it removes the GPU child process entirely, so
`IntentionallyCrashBrowserForUnusableGpuProcess` is unreachable. It was deferred when DESKTOP-W
was the only evidence, on the grounds that it trades a GPU hang for an app hang. DESKTOP-18's seven
dead launches settled that trade: an app that hangs occasionally beats an app that cannot start.

Measured on Electron 41, booting a real window with both switches applied:

| | Platform | `app.getAppMetrics()` process types | `gpu_compositing` | `webgl` |
|---|---|---|---|---|
| Control | Windows | `Browser`, `GPU`, `Tab`, `Utility` | `enabled` | `enabled` |
| `--disable-gpu --in-process-gpu` | Windows | `Browser`, `Tab`, `Utility` | `disabled_software` | `unavailable_software` |
| Control, `--ignore-gpu-blocklist` | Linux (WSLg) | `Browser`, `GPU`, `Utility`, `Tab` | `enabled` | `enabled` |
| `--disable-gpu --in-process-gpu` | Linux (WSLg) | `Browser`, `Utility`, `Tab` | `disabled_software` | `disabled_off` |

Re-measured on Electron 44.5.1 (2026-10-04) with the same rig: all four rows read the same on both
platforms, and the recovery window painted on each (about 9,870 red pixels of the rotating box in a
page capture, against 9,864 for the Windows control).

No GPU process is spawned at all, which is the property the whole recovery path rests on. On Linux
the window still painted: a page capture found all 10,000 pixels of a 100 px animated box. The
Linux rows come from Ubuntu 24.04 under WSLg, whose GL is Mesa's d3d12 driver rather than a native
one, and which Chromium blocklists, so the control needed `--ignore-gpu-blocklist` to start on the
GPU. macOS has not been measured. `app.getGPUInfo('complete')` still settles under the switches
(1 ms on Windows), and still names the adapter, so the report loses nothing by running in this
mode. `webgl: unavailable_software` is why `terminal-webgl.ts` skips its attach entirely rather
than retrying on its usual schedule: in this mode the context is not blocked, it cannot exist.

What ships now, on every platform:

- `src/main/diagnostics/gpu-health.ts` records EVERY GPU `child-process-gone` death, not just a
  threshold breach, along with the Chromium GPU mode each one left behind. That is read after
  Chromium handled the death, so the death that triggers a fallback already reads the lower rung:
  three kills record `enabled`, `enabled`, `disabled_software` on both Windows and Linux. The threshold moved
  to report time. The reason is ordering: Chromium calls `GpuProcessHost::RecordProcessCrash` (and
  the `LOG(FATAL)` below it) from the delegate, BEFORE the observer notification Electron emits
  `child-process-gone` from, so the death that kills the app is one JS is never told about.
  Whatever is going to be on disk has to already be there.
- The same file records the fallback, from `gpu-info-update`: the moment `gpu_compositing` leaves
  the GPU after this run was seen compositing on it, and each later status change. Through
  Electron 41 a launch-failure ladder left nothing else, and on 44 the launch failure that ends in
  the fatal still leaves nothing else (see above), so the next launch's near-end check reads the latest
  FAULT, a fault death or a fallback, and counts it as what ended the run. A fallback does not
  count when a non-fault death (a kill, a session-teardown exit) came within 5 s before it, since
  that death is what Chromium was falling back from. A machine
  that never had GPU compositing normally writes nothing: our own software mode reads exactly like
  `DISPLAY_COMPOSITOR` from its first update, and a blocklisted driver churns its status at every
  boot.
- On Linux, `src/main/diagnostics/linux-gpu-zygote.ts` finds the unsandboxed zygote on the first
  `gpu-info-update`, while the GPU is healthy, and each recorded fallback carries a `linux` reading:
  whether that zygote is `alive`, `dead` (gone, a zombie, or its pid reused), or `unknown`, plus the
  system-wide thread count from `/proc/loadavg` and the soft `Max processes` limit. A dead zygote is
  never a normal state, so it also lifts the rule above that a machine that never had GPU compositing writes nothing: a blocklisted Linux box whose
  zygote dies is recorded too. Verified with the real modules bundled into the WSLg reproduction: on
  both a GPU-composited start and a blocklisted one, killing the zygote and then the GPU process
  wrote a `hardware-fallback` record with `zygote: dead` before the fatal, while killing the GPU
  process alone recorded `zygote: alive`. Three shapes stay uncovered: a machine that already sits
  on the last rung, since its fatal comes with no further `gpu-info-update`; a Linux machine that
  never composited on the GPU and whose zygote is alive but cannot fork, at the process limit for
  example; and a Windows or macOS machine that never composited on the GPU, where there is no
  zygote to check. On a kernel without the per-thread `children` files, finding the zygote falls
  back to one scan of every `/proc` entry, once per run.
- `src/main/index.ts` decides at MODULE SCOPE, before `app.whenReady()`, whether to start in
  software rendering, because `app.disableHardwareAcceleration()` THROWS once the app is ready
  rather than quietly doing nothing. It engages both that call and `--in-process-gpu`:
  `--in-process-gpu` removes the GPU child, and the `--disable-gpu` the API appends keeps the
  display driver out of the browser process that child's absence would otherwise pull it into.
  `--in-process-gpu` is set on every platform, unguarded, and has been verified on Windows and on
  Linux (under WSLg), not on macOS. That is deliberate rather than an oversight: the issues this
  path exists for came from Windows and Linux installs, and a platform gate would only weaken the
  recovery somewhere it has not been measured.
- Only GPU FAULTS engage it: a death with a fault reason and an exit code that does not mean the
  session was ending, or a fallback no non-fault death explains (`isGpuFaultDeath` and
  `gpuEndedPreviousRun` in `gpu-health.ts`). The session-teardown codes are Windows ones:
  `0xC000026B` (STATUS_DLL_INIT_FAILED_LOGOFF, which Chromium reports as `crashed`),
  `0x40010004` and `0xC000013A`. Without that filter, a Windows shutdown with the dev instance open
  read as a crash loop that killed the run, because Windows refuses to start a graphics process
  while the session ends and Chromium kept relaunching one. Kills and OOMs never count on any
  platform.
- The downgrade is a real user-visible setting (`graphicsAccelerationEnabled`, Settings > Performance),
  set to `off` once and never back on by us. A one-line callout says Kangentic did it. Nothing
  watches the driver version: we never established what killed the GPU process, so the app claims
  no cause and suggests no cure. Changing the setting restarts Kangentic behind a confirmation,
  because the mode is fixed before the app is ready in both directions.

See [Error reporting (Sentry)](../telemetry/error-reporting.md) for the reporting half.
