import { useCallback, useEffect, useRef } from 'react';
import { useConfigStore } from '../stores/config-store';
import { useDictationStore } from '../stores/dictation-store';
import { useKeybinding } from './useKeybinding';
import { resolveDictationTarget } from '../utils/dictation-target';
import { createDictationSink, type DictationSink } from '../utils/dictation-sink';
import { mayAutoSubmit } from '../utils/text-target';
import { probeGuestField, type GuestFieldProbe } from '../utils/guest-text-target';
import { startAudioCapture, type AudioCaptureHandle } from '../audio/audio-capture';
import { effectiveCombo, isMouseCombo, mouseComboToButton } from '../../shared/keybindings';
import { matchesCombo, matchesMouseRelease } from '../utils/keybindings';
import { isRebindCaptureActive } from '../utils/rebind-state';
import { resolveBrowserNavigationTarget } from '../utils/browser-navigation-registry';

const ACTION_ID = 'dictation.pushToTalk';

/**
 * Below this, a press is a CLICK rather than a hold, and means "navigate the
 * Browser pane" instead of "dictate".
 *
 * Mouse:Back is both push-to-talk and the near-universal browser Back button,
 * and the two are separable because push-to-talk is a hold. A tap this short
 * yields an utterance with no usable audio in it - it was already dead input -
 * so reclaiming it costs nothing. Dictation still STARTS on press, so a real
 * hold loses none of its first word; a short release cancels it and navigates.
 *
 * Only a MOUSE combo takes this path. A keyboard binding keeps the old
 * behaviour, since no browser navigates on a tapped key.
 */
const NAVIGATION_TAP_MS = 200;

/** How long the "still sending the last one" refusal stays up. Long enough to
 *  read, short enough that it is gone before the user's next attempt. */
const BUSY_NOTICE_MS = 1600;

/** `PointerEvent.button` for the forward mouse button (back is 3). Read from the
 *  keybindings registry rather than restated, so the gesture and the `Mouse:Forward`
 *  combo a user can bind can never disagree about which button they mean. */
const FORWARD_MOUSE_BUTTON = mouseComboToButton('Mouse:Forward');

/** Spoken phrases that clear the current dictation instead of committing it.
 *  Only a STANDALONE utterance equal to one of these clears (safe + predictable);
 *  the phrase appearing inside a longer sentence is committed verbatim. */
const CLEAR_PHRASES = ['scratch that', 'clear that', 'start over', 'clear'];

function isClearCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.,!?]+$/, '').trim();
  return CLEAR_PHRASES.includes(normalized);
}

/** Collapse CR/LF to spaces so a live-typed partial never accidentally submits. */
function sanitizeInline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/**
 * The streaming preview engine emits uppercase, unpunctuated tokens, which then
 * flip to the accurate model's sentence-cased, punctuated text on release - a
 * jarring change. Lowercase the live partial and capitalize its first letter so
 * the preview already reads like the final text (just without final punctuation).
 */
function toPreviewCase(text: string): string {
  return text.toLowerCase().replace(/[a-z]/, (char) => char.toUpperCase());
}

/**
 * Bridge so the popup / docked-bar Send / Clear / Cancel buttons reach the
 * single mounted hook instance, which owns the finalize + commit + clear logic.
 * Re-registered on every mount, so resetting on a Fast Refresh is correct.
 */
export const dictationPopupActions: { commit: () => void; clear: () => void; cancel: () => void } = {
  commit: () => undefined,
  clear: () => undefined,
  cancel: () => undefined,
};

/**
 * Push-to-talk orchestration. Mounted once from AppLayout. Press (held key /
 * mouse button) requests the mic, starts a dictation session, captures audio
 * (downsampled to 16 kHz mono PCM) and streams it to the main funnel. The live
 * surface (popup / docked bar / live) is chosen by the `experience` setting:
 * `live` types partials straight into the focused target; the others preview
 * and commit on release. Inert unless dictation is enabled in settings.
 *
 * The target may be a terminal, any focused text field in the app, a rich-text
 * host, or a field inside a browser guest page. Which it is, and how text
 * reaches it, is the SINK's business - see `utils/dictation-sink.ts`. This hook
 * never branches on it, so the lifecycle here is the same either way.
 */
export function useDictation(): void {
  const enabled = useConfigStore((state) => state.globalConfig.dictation?.enabled ?? false);
  const engineMode = useConfigStore((state) => state.globalConfig.dictation?.engineMode ?? 'auto');
  const modelId = useConfigStore((state) => state.globalConfig.dictation?.modelId ?? null);
  const liveModelId = useConfigStore((state) => state.globalConfig.dictation?.liveModelId ?? null);
  const punctuation = useConfigStore((state) => state.globalConfig.dictation?.punctuation ?? true);
  const language = useConfigStore((state) => state.globalConfig.dictation?.language ?? 'en');
  const autoSubmit = useConfigStore((state) => state.globalConfig.dictation?.autoSubmit ?? true);
  const releaseBufferMs = useConfigStore((state) => state.globalConfig.dictation?.releaseBufferMs ?? 250);
  // Live is the only experience now: the transcript types straight into the
  // resolved target. (The popup/docked surfaces are retired.)
  const experience: 'popup' | 'docked' | 'live' = 'live';
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[ACTION_ID]);
  const combo = effectiveCombo(ACTION_ID, override ? { [ACTION_ID]: override } : undefined);
  // Which mouse button push-to-talk actually holds. Both are rebindable, so
  // neither direction may be assumed: the guest path already branches on the
  // reported button, and the window paths below read these for the same reason.
  // A button push-to-talk does NOT hold is a bare navigation button; one it DOES
  // hold has to go through tap-vs-hold arbitration instead.
  const boundToMouseBack = !!combo && isMouseCombo(combo) && combo.split('+').includes('Mouse:Back');
  const boundToMouseForward = !!combo && isMouseCombo(combo) && combo.split('+').includes('Mouse:Forward');

  // `true` while the push-to-talk input is held. Guards against auto-repeat
  // keydowns starting a second session and tells the release handler to act.
  const activeRef = useRef(false);
  const partialUnsubscribeRef = useRef<(() => void) | null>(null);
  const finalUnsubscribeRef = useRef<(() => void) | null>(null);
  const captureRef = useRef<AudioCaptureHandle | null>(null);
  // Where this utterance's text goes, resolved once at press time. Held in a ref
  // rather than in the store because an input target is a live DOM node: it
  // cannot be snapshotted across a Fast Refresh, and parking one in a global
  // store would keep a detached node alive after its pane closed. The store
  // carries only what the chip needs to render (see `targetKind`).
  const sinkRef = useRef<DictationSink | null>(null);
  // How many PCM frames we have streamed for the current utterance. Passed to
  // `stop` as the drain target so finalize waits for the tail to be ingested
  // before decoding (the audio frames race the stop invoke over IPC).
  const framesSentRef = useRef(0);
  /** Terminal sessions with an auto-submit paste in flight in the main process.
   *
   *  A SET of session ids, not a boolean. What the paste has to be protected from
   *  is fresh bytes splitting its bracketed content, and only a write to the SAME
   *  PTY can do that - a different terminal, a text input, the note field, and a
   *  guest page are all incapable of it. As one global flag this blocked them
   *  all, which is what made push-to-talk go dead after dictating into a terminal
   *  and then clicking over to the Browser pane.
   *
   *  The window is longer than it sounds. `terminal-submit.ts` deliberately waits
   *  for the TUI to settle rather than sleeping a fixed amount (`SETTLE_CAP_MS`
   *  1200, plus an Esc handshake and a verify poll), because a fixed delay breaks
   *  on a busy machine. So it is fast when the machine is idle and stretches past
   *  two seconds when it is not - measured at 2.1s of dead push-to-talk on a
   *  loaded box, which is why this read as "works sometimes". */
  const submittingSessionsRef = useRef<Set<string>>(new Set());
  // True while the trailing-capture buffer is open (between release and the
  // actual capture stop). Blocks a new press from starting mid-window.
  const bufferingRef = useRef(false);
  /** When a GUEST-forwarded press landed, in MAIN's `Date.now()` clock.
   *
   *  Separate from `pressedAtRef` because the two are different time origins and
   *  must never be subtracted from each other: window events carry a
   *  `performance.now()`-based `timeStamp`, guest events carry main's wall
   *  clock. */
  const guestPressedAtRef = useRef<number | null>(null);
  /** When the current press landed, for telling a navigation TAP from a hold.
   *
   *  The EVENT's timestamp, not `Date.now()` at handler time. The press kicks off
   *  `startDictation`, whose mic permission, engine start, and AudioWorklet load
   *  congest the event loop for a few hundred milliseconds - measured at 414ms of
   *  wall clock for an 80ms timer. A handler-time clock would read that congestion
   *  as part of the user's press and misfile a real tap as a hold. `timeStamp` is
   *  stamped when the browser created the event, so it measures the finger. */
  const pressedAtRef = useRef<number | null>(null);
  // Latest config read by the press/release handlers without re-arming them.
  const optionsRef = useRef({ engineMode, modelId, liveModelId, punctuation, language, autoSubmit, releaseBufferMs, experience });
  optionsRef.current = { engineMode, modelId, liveModelId, punctuation, language, autoSubmit, releaseBufferMs, experience };

  /** Drop this utterance's transient handles. Called on every path that ends a
   *  dictation - commit, cancel, release, an abandoned start, and unmount - so
   *  it is also where the sink is released, which keeps an input target's DOM
   *  node from being held alive by this ref after its pane has closed. */
  const cleanupSubscriptions = useCallback(() => {
    partialUnsubscribeRef.current?.();
    partialUnsubscribeRef.current = null;
    finalUnsubscribeRef.current?.();
    finalUnsubscribeRef.current = null;
    sinkRef.current = null;
  }, []);

  const stopCapture = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  /** Erase whatever `live` mode typed into the target. */
  const eraseLiveText = useCallback(() => {
    sinkRef.current?.clear();
  }, []);

  const startDictation = useCallback(async (): Promise<void> => {
    // Ignore a press while already recording or while the trailing-capture
    // buffer is open: both mean a capture for THIS press is already in hand.
    if (activeRef.current || bufferingRef.current) return;
    // Resolved BEFORE the paste guard below, which needs to know the target to
    // decide whether the guard even applies. Still synchronous, and still the
    // first thing after the cheap latches: this runs inside the capture-phase
    // press handler that preventDefaults, so `document.activeElement` is what
    // the user was in when they pressed, before the press can move focus.
    const target = resolveDictationTarget();
    // Only the terminal whose paste is still landing is off limits.
    if (target?.kind === 'terminal' && submittingSessionsRef.current.has(target.sessionId)) {
      // Say so. Silently dropping the press is what made a two-second wait read
      // as a broken button.
      useDictationStore.getState().setBusy(target.sessionId);
      // Self-clearing, because nothing transitions OUT of a refusal: no capture
      // was started, so no release will arrive to end it. Guarded on the status
      // still being `busy` so a press that succeeds in the meantime is not reset
      // out from under itself.
      window.setTimeout(() => {
        if (useDictationStore.getState().status === 'busy') useDictationStore.getState().reset();
      }, BUSY_NOTICE_MS);
      return;
    }
    activeRef.current = true;
    framesSentRef.current = 0;
    // Before the sink is built: `cleanupSubscriptions` releases the sink too, so
    // building first would hand the fresh one straight back.
    cleanupSubscriptions();
    // A guest target needs a round trip into the `<webview>` to learn WHICH field
    // has focus, so the sink for it is built after the probe below rather than
    // here. Everything else resolves synchronously and is built now, so the very
    // first partial has somewhere to go.
    if (target && target.kind !== 'guest' && target.kind !== 'refused') {
      const submittingSessionId = target.kind === 'terminal' ? target.sessionId : null;
      sinkRef.current = createDictationSink(target, {
        onSubmitStarted: () => {
          if (submittingSessionId) submittingSessionsRef.current.add(submittingSessionId);
        },
        onSubmitSettled: () => {
          if (submittingSessionId) submittingSessionsRef.current.delete(submittingSessionId);
        },
      });
    }
    partialUnsubscribeRef.current = window.electronAPI.dictation.onPartial((_dictationSessionId, text) => {
      const state = useDictationStore.getState();
      if (state.status !== 'recording') return;
      const preview = toPreviewCase(text);
      state.setPartial(preview);
      // Live experience: replace the previous partial with the new one straight
      // in the focused target (an append-only streaming engine feels live).
      if (optionsRef.current.experience === 'live') {
        sinkRef.current?.write(sanitizeInline(preview));
      }
    });
    finalUnsubscribeRef.current = window.electronAPI.dictation.onFinal((_dictationSessionId, text) => {
      useDictationStore.setState({ finalText: text });
    });

    // The dictation session id once `start` returns, so the catch can cancel a
    // session created before a later mic-capture failure (otherwise the
    // main-process engine stays pinned by a leaked active entry).
    let startedSessionId: string | null = null;
    try {
      const permission = await window.electronAPI.dictation.requestMic();
      if (permission !== 'granted') {
        activeRef.current = false;
        cleanupSubscriptions();
        useDictationStore.getState().setError(
          permission === 'denied'
            ? 'Microphone access was denied. Enable it in your OS settings.'
            : 'No microphone is available.',
        );
        return;
      }
      // The key may have been released during the permission await.
      if (!activeRef.current) {
        cleanupSubscriptions();
        useDictationStore.getState().reset();
        return;
      }

      const result = await window.electronAPI.dictation.start({
        engineMode: optionsRef.current.engineMode,
        modelId: optionsRef.current.modelId,
        liveModelId: optionsRef.current.liveModelId,
        punctuation: optionsRef.current.punctuation,
        language: optionsRef.current.language,
      });
      startedSessionId = result.dictationSessionId;
      // Released during the start await: abandon the freshly-created session.
      if (!activeRef.current) {
        await window.electronAPI.dictation.cancel(result.dictationSessionId);
        cleanupSubscriptions();
        useDictationStore.getState().reset();
        return;
      }
      // The guest round trip happens HERE, after the mic and engine are up, so
      // its 1-2ms rides in the gap that already exists rather than adding to the
      // press latency. Only now can we know whether the guest's own focus is on
      // a writable field - if it is not, this resolves to no target, which is
      // honest: the user is focused on a page, not on somewhere to type.
      let guestProbe: GuestFieldProbe | null = null;
      if (target?.kind === 'guest') {
        guestProbe = await probeGuestField(target.webview);
        if (guestProbe?.eligible) {
          sinkRef.current = createDictationSink(target, {
            // Never called: a guest field is filled, never submitted, so there is
            // no paste to protect. Present only to satisfy the shared shape.
            onSubmitStarted: () => {},
            onSubmitSettled: () => {},
            guestAnchor: {
              baseValue: guestProbe.value,
              anchorStart: guestProbe.selectionStart,
              anchorEnd: guestProbe.selectionEnd,
              richText: guestProbe.richText === true,
            },
          });
        }
      }
      // A guest whose own focus is not writable resolves to NO target, exactly as
      // if nothing were focused - except that the reason travels with it, so the
      // chip can say "password" rather than the untrue "nothing focused".
      const resolved = target?.kind === 'guest' && !guestProbe?.eligible ? null : target;
      const refusal: 'password' | null = target?.kind === 'refused'
        ? target.reason
        : guestProbe?.reason === 'password' ? 'password' : null;

      useDictationStore.getState().beginRecording(result.dictationSessionId, {
        sessionId: resolved?.kind === 'terminal' ? resolved.sessionId : null,
        kind: resolved && resolved.kind !== 'refused'
          // Both a guest field and a rich-text host report as 'input': the chip
          // only asks "is there somewhere to type", and both answer yes. The
          // sink already holds the real target, so nothing downstream loses the
          // distinction.
          ? (resolved.kind === 'terminal' ? 'terminal' : 'input')
          : null,
        element: resolved?.kind === 'input' ? resolved.element : null,
        contentEditableElement: resolved?.kind === 'contenteditable' ? resolved.element : null,
        refusal,
        // Anchored even on a refusal, so the explanation appears against the
        // field the user is looking at rather than in a far corner.
        // Narrowed on `target.kind` rather than cast: the two facts (a probe ran,
        // so the target was a guest) are tied together here instead of resting on
        // an invariant a later edit could break silently.
        guestRect: guestProbe?.rect && target?.kind === 'guest'
          ? { webview: target.webview, rect: guestProbe.rect }
          : null,
        // What release will ACTUALLY do, so the chip's hint is not a promise the
        // sink then refuses to keep: a field inside a multi-field form never
        // auto-submits, whatever the setting says, and a guest field never
        // auto-submits at all (see `guest-text-target.ts`'s header for why).
        willSubmit: !!resolved && resolved.kind !== 'refused' && optionsRef.current.autoSubmit && (
          resolved.kind === 'terminal'
            ? true
            : resolved.kind === 'input'
              ? mayAutoSubmit(resolved.element)
              // Enter in a rich-text editor is a newline, never a commit; and a
              // GUEST field is only ever filled, never submitted.
              : false
        ),
      });

      // Start capturing and streaming audio frames into the funnel. The frame
      // counter is the drain target passed to `stop` on release.
      const handle = await startAudioCapture((pcm) => {
        window.electronAPI.dictation.sendAudioChunk({
          dictationSessionId: result.dictationSessionId,
          seq: framesSentRef.current++,
          pcm,
        });
      });
      captureRef.current = handle;
      // Released while the audio graph was starting: tear it back down. The
      // release handler already finalized; just stop the now-orphaned capture.
      if (!activeRef.current) {
        stopCapture();
      }
    } catch (error) {
      activeRef.current = false;
      stopCapture();
      // The session may have been created before the throw (mic capture failed
      // after `start`): cancel it so the main-process engine is not pinned by a
      // leaked active entry.
      if (startedSessionId) {
        void window.electronAPI.dictation.cancel(startedSessionId).catch(() => undefined);
      }
      cleanupSubscriptions();
      useDictationStore.getState().setError(
        error instanceof Error ? error.message : 'Dictation failed to start',
      );
    }
  }, [cleanupSubscriptions, stopCapture]);

  const commitFinal = useCallback(async (): Promise<void> => {
    const { targetSessionId, targetKind, finalText } = useDictationStore.getState();
    if (finalText.trim().length > 0) {
      if (targetKind === 'input') {
        // An input is written in this renderer, so there is no commit IPC for it.
        sinkRef.current?.submit(sanitizeInline(finalText), optionsRef.current.autoSubmit);
      } else if (targetSessionId) {
        try {
          await window.electronAPI.dictation.commit(targetSessionId, finalText);
        } catch {
          // Best-effort injection; nothing actionable on failure.
        }
      }
    }
    cleanupSubscriptions();
    useDictationStore.getState().reset();
  }, [cleanupSubscriptions]);

  const cancelDictation = useCallback(async (): Promise<void> => {
    activeRef.current = false;
    stopCapture();
    const { dictationSessionId } = useDictationStore.getState();
    if (dictationSessionId) {
      try {
        await window.electronAPI.dictation.cancel(dictationSessionId);
      } catch {
        // ignore
      }
    }
    cleanupSubscriptions();
    useDictationStore.getState().reset();
  }, [cleanupSubscriptions, stopCapture]);

  /** Clear / start over: wipe any live-typed text from the terminal and abort the
   *  current utterance (the user redoes it on the next press). Used by the Clear
   *  button and the "scratch that" voice command. */
  const clearDictation = useCallback(async (): Promise<void> => {
    eraseLiveText();
    await cancelDictation();
  }, [eraseLiveText, cancelDictation]);

  const finalizeOnRelease = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    activeRef.current = false;
    // Trailing-capture buffer: keep the mic open a beat so the tail of the last
    // word (still being voiced as the user releases) is captured instead of
    // clipped. Frames keep streaming during the window; the drain barrier in
    // `stop` then decodes the COMPLETE utterance. bufferingRef blocks a new press
    // from starting mid-window (its live writes would race this capture).
    const bufferMs = optionsRef.current.releaseBufferMs;
    if (bufferMs > 0 && captureRef.current) {
      bufferingRef.current = true;
      await new Promise<void>((resolve) => setTimeout(resolve, bufferMs));
      bufferingRef.current = false;
    }
    stopCapture();
    const { dictationSessionId } = useDictationStore.getState();
    if (!dictationSessionId) {
      cleanupSubscriptions();
      useDictationStore.getState().reset();
      return;
    }
    useDictationStore.getState().setFinalizing();
    let finalText = '';
    try {
      // Pass the sent-frame count so finalize drains the tail before decoding.
      finalText = await window.electronAPI.dictation.stop(dictationSessionId, framesSentRef.current);
    } catch {
      // ignore; finalText stays empty
    }
    useDictationStore.setState({ finalText });

    // Voice command: a standalone "scratch that" / "clear" discards everything.
    if (isClearCommand(finalText)) {
      await clearDictation();
      return;
    }

    const isLive = optionsRef.current.experience === 'live';
    if (isLive) {
      // Replace the live preview with the refined text and, when auto-submit is
      // on, commit it. What "commit" means is the sink's business: for a terminal
      // it is the main-process paste engine, which presses Enter as a SEPARATE,
      // settled, verified keystroke (a \r appended to a liveWrite does not
      // submit - the TUI reads an Enter in the same write with stale state); for
      // an input it is an Enter on the field itself.
      sinkRef.current?.submit(sanitizeInline(finalText), optionsRef.current.autoSubmit);
      cleanupSubscriptions();
      useDictationStore.getState().reset();
      return;
    }
  }, [cleanupSubscriptions, clearDictation, stopCapture]);

  // Wire the surface buttons to this instance.
  useEffect(() => {
    dictationPopupActions.commit = () => {
      void commitFinal();
    };
    dictationPopupActions.clear = () => {
      void clearDictation();
    };
    dictationPopupActions.cancel = () => {
      void cancelDictation();
    };
    return () => {
      dictationPopupActions.commit = () => undefined;
      dictationPopupActions.clear = () => undefined;
      dictationPopupActions.cancel = () => undefined;
    };
  }, [commitFinal, clearDictation, cancelDictation]);

  // Surface first-use model download progress in the popup. `done` clears it.
  useEffect(() => {
    if (!enabled) return;
    return window.electronAPI.dictation.onModelProgress((progress) => {
      useDictationStore.getState().setModelProgress(progress.status === 'done' ? null : progress);
    });
  }, [enabled]);

  // Pre-load the engine so the FIRST push-to-talk is instant: the model load
  // (the 631 MB Parakeet ONNX takes seconds) happens ahead of the press, not
  // during it. Re-warm whenever the engine / model selection changes so the warm
  // engine always matches the current choice, and release the warm engines when
  // dictation is turned off. Debounced so rapid setting changes do not thrash the
  // loader; the main-process warm cache keeps the previous model too, so an A/B
  // switch back to it stays instant.
  useEffect(() => {
    if (!enabled) {
      window.electronAPI.dictation.prewarm(null);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI.dictation.prewarm({ engineMode, modelId, liveModelId, punctuation, language });
    }, 300);
    return () => clearTimeout(timer);
  }, [enabled, engineMode, modelId, liveModelId, punctuation, language]);

  /**
   * Start, and never fail SILENTLY.
   *
   * `startDictation` runs its guards, resolves the target, and wires its
   * subscriptions before its own try/catch begins, so anything thrown in that
   * region escapes - and `void` then swallows it. The result is push-to-talk
   * that does nothing at all: no chip, no error, no recording. That is
   * indistinguishable from a dead hotkey, and it cost a full debugging session
   * to tell apart once. An unexpected throw now says so and releases the latch,
   * so the next press can still work.
   */
  const startDictationSafely = useCallback((): void => {
    void startDictation().catch((error: unknown) => {
      activeRef.current = false;
      useDictationStore.getState().setError(
        error instanceof Error
          ? `Dictation could not start: ${error.message}`
          : 'Dictation could not start.',
      );
    });
  }, [startDictation]);

  // Press half (keydown / pointerdown) via the central registry.
  useKeybinding(
    ACTION_ID,
    (event) => {
      pressedAtRef.current = event.timeStamp;
      startDictationSafely();
    },
    { enabled, capture: true, preventDefault: true, stopPropagation: true },
  );

  /**
   * A press too short to be a hold: cancel the dictation it optimistically
   * started and navigate the Browser pane instead.
   *
   * Returns whether it handled the release, so the normal finalize path knows to
   * stand down. Only fires for a MOUSE combo over an active pane that can
   * actually go back - so a tap with no pane under the pointer, or at the start
   * of history, still finalizes as a (empty) dictation rather than silently
   * doing nothing different.
   */
  const handleNavigationTap = useCallback((forward: boolean, releasedAt: number): boolean => {
    const pressedAt = pressedAtRef.current;
    pressedAtRef.current = null;
    if (pressedAt === null || releasedAt - pressedAt >= NAVIGATION_TAP_MS) return false;
    const pane = resolveBrowserNavigationTarget();
    if (!pane) return false;
    if (forward ? !pane.canGoForward() : !pane.canGoBack()) return false;
    // Cancel BEFORE navigating, so the engine session is torn down and the chip
    // dismissed rather than left recording into a page that just changed.
    void cancelDictation();
    if (forward) pane.goForward();
    else pane.goBack();
    return true;
  }, [cancelDictation]);

  /**
   * Mouse FORWARD navigates the active pane on PRESS, with no threshold - but
   * only while push-to-talk is not bound to that same button.
   *
   * The gate is load-bearing rather than defensive. `Mouse:Forward` is a
   * first-class rebindable token, and this listener and `useKeybinding`'s press
   * handler both sit on `window` in the capture phase, where `stopPropagation`
   * does NOT stop a sibling listener on the same node. So without it, a user who
   * rebinds push-to-talk to Forward gets BOTH on every press: dictation starts
   * and the pane navigates out from under it. A button push-to-talk holds must
   * go through the tap-vs-hold arbitration on release instead, which is exactly
   * what the guest path already does.
   *
   * Bound here rather than in the pane because the pane never sees the event:
   * with focus inside the guest, a mouse-forward press goes to the guest's
   * widget, and the host only learns about it from a window-level listener.
   */
  useEffect(() => {
    if (!enabled || boundToMouseForward) return;
    const onForward = (event: PointerEvent): void => {
      // A rebind capture owns every input while it is open. Without this, a
      // capture-phase `window` listener consumes the press before the Hotkeys
      // capture widget (on `document`) can record it, so the user cannot bind
      // this button at all while a pane happens to be active.
      if (isRebindCaptureActive()) return;
      if (event.button !== FORWARD_MOUSE_BUTTON) return;
      const pane = resolveBrowserNavigationTarget();
      if (!pane || !pane.canGoForward()) return;
      event.preventDefault();
      event.stopPropagation();
      pane.goForward();
    };
    window.addEventListener('pointerdown', onForward, true);
    return () => window.removeEventListener('pointerdown', onForward, true);
  }, [enabled, boundToMouseForward]);

  /**
   * Mouse back / forward pressed inside a Browser pane's guest page.
   *
   * These arrive over IPC rather than as DOM events, because a guest consumes
   * the mouse outright: measured on a live guest, one real back press produced
   * 31 events inside the page and ZERO on the host window. So while the page has
   * focus, the window listeners above are blind and this is the only path. Main
   * reports a true down/up PAIR, which is what lets a hold stay a hold.
   *
   * Gated on the user's ACTUAL binding: someone who rebound push-to-talk to a key
   * must not have the back button start dictating at them. A back press with no
   * dictation binding still navigates, which is the behaviour they asked for.
   */
  useEffect(() => {
    if (!enabled) return;
    const subscribe = window.electronAPI?.browser?.onGuestMouseButton;
    if (!subscribe) return;
    return subscribe((event) => {
      const boundToThisButton = event.button === 'back' ? boundToMouseBack : boundToMouseForward;

      if (event.phase === 'down') {
        if (!boundToThisButton) return;
        guestPressedAtRef.current = event.at;
        startDictationSafely();
        return;
      }

      // Release. A button with no dictation binding navigates on its own; one
      // that IS bound goes through the same tap-vs-hold arbitration as the
      // window path, so a hold dictates and a tap navigates.
      if (!boundToThisButton) {
        const pane = resolveBrowserNavigationTarget();
        if (!pane) return;
        if (event.button === 'forward' ? pane.canGoForward() : pane.canGoBack()) {
          if (event.button === 'forward') pane.goForward();
          else pane.goBack();
        }
        return;
      }

      const pressedAt = guestPressedAtRef.current;
      guestPressedAtRef.current = null;
      const wasTap = pressedAt !== null && event.at - pressedAt < NAVIGATION_TAP_MS;
      if (wasTap) {
        const pane = resolveBrowserNavigationTarget();
        const canNavigate = pane
          && (event.button === 'forward' ? pane.canGoForward() : pane.canGoBack());
        if (canNavigate) {
          void cancelDictation();
          if (event.button === 'forward') pane.goForward();
          else pane.goBack();
          return;
        }
      }
      void finalizeOnRelease();
    });
  }, [enabled, boundToMouseBack, boundToMouseForward, startDictationSafely, finalizeOnRelease, cancelDictation]);

  // Release half is hand-wired because useKeybinding only fires on the press.
  // This capture-phase paired listener reads the SAME effective combo. This is
  // the documented keybindings-registry hold-semantics exception (like the
  // xterm clipboard and BaseDialog Escape hand-wired handlers).
  useEffect(() => {
    if (!enabled || !combo) return;
    const eventType: 'keyup' | 'pointerup' = isMouseCombo(combo) ? 'pointerup' : 'keyup';
    const onRelease = (event: Event): void => {
      if (isRebindCaptureActive()) return;
      if (!activeRef.current) return;
      const inputEvent = event as KeyboardEvent | PointerEvent;
      // Mouse: a chord releases when ANY of its buttons lifts (pointerup).
      // Keyboard: match the combo on keyup.
      const released = isMouseCombo(combo)
        ? matchesMouseRelease(inputEvent as PointerEvent, combo)
        : matchesCombo(inputEvent, combo);
      if (!released) return;
      inputEvent.preventDefault();
      inputEvent.stopPropagation();
      // A mouse TAP means "navigate the Browser pane", not "dictate". Keyboard
      // holds never take this path: no browser navigates on a tapped key. The
      // direction is read from the BOUND button, not assumed: a chord holding
      // both resolves to Back, matching what that button means everywhere else.
      if (isMouseCombo(combo)
        && handleNavigationTap(boundToMouseForward && !boundToMouseBack, inputEvent.timeStamp)) return;
      void finalizeOnRelease();
    };
    window.addEventListener(eventType, onRelease, true);
    return () => window.removeEventListener(eventType, onRelease, true);
  }, [enabled, combo, boundToMouseBack, boundToMouseForward, finalizeOnRelease, handleNavigationTap]);

  // Tear down any in-flight session when dictation is turned off.
  useEffect(() => {
    if (enabled) return;
    // activity-state-ok: the dictation store's own status enum, not ActivityState
    if (activeRef.current || useDictationStore.getState().status !== 'idle') {
      void cancelDictation();
    }
  }, [enabled, cancelDictation]);

  // Drop subscriptions and any live capture on unmount.
  useEffect(
    () => () => {
      // Signal any in-flight startDictation (awaiting startAudioCapture) that the
      // mount is gone, so its post-await guard tears the capture down instead of
      // orphaning the AudioContext + MediaStream (a stuck-on mic after a remount).
      activeRef.current = false;
      stopCapture();
      cleanupSubscriptions();
      // The store OUTLIVES this hook: it is pinned in `import.meta.hot.data`, so
      // a Fast Refresh remount of AppLayout (which is where this hook is called,
      // and the boundary every non-component module in this graph propagates up
      // to) gives a fresh `activeRef` a store still reading `recording`. Release
      // then hits `if (!activeRef.current) return` and does nothing, so the chip
      // is stuck for the rest of the dev session and its rAF loop keeps
      // measuring every frame. Reconcile the two rather than leave the orphan.
      // activity-state-ok: the dictation store's own status enum, not ActivityState
      const { status, dictationSessionId } = useDictationStore.getState();
      if (status === 'idle') return;
      if (dictationSessionId) {
        void window.electronAPI.dictation.cancel(dictationSessionId).catch(() => undefined);
      }
      useDictationStore.getState().reset();
    },
    [cleanupSubscriptions, stopCapture],
  );
}
