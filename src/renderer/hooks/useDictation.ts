import { useCallback, useEffect, useRef } from 'react';
import { useConfigStore } from '../stores/config-store';
import { useDictationStore } from '../stores/dictation-store';
import { useKeybinding } from './useKeybinding';
import { resolveDictationTarget } from '../utils/dictation-target';
import { startAudioCapture, type AudioCaptureHandle } from '../audio/audio-capture';
import { effectiveCombo, isMouseCombo } from '../../shared/keybindings';
import { matchesCombo, matchesMouseRelease } from '../utils/keybindings';
import { isRebindCaptureActive } from '../utils/rebind-state';

const ACTION_ID = 'dictation.pushToTalk';

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
 * `live` types partials straight into the focused terminal; the others preview
 * and commit on release. Inert unless dictation is enabled in settings.
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
  // focused terminal. (The popup/docked surfaces are retired.)
  const experience: 'popup' | 'docked' | 'live' = 'live';
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[ACTION_ID]);
  const combo = effectiveCombo(ACTION_ID, override ? { [ACTION_ID]: override } : undefined);

  // `true` while the push-to-talk input is held. Guards against auto-repeat
  // keydowns starting a second session and tells the release handler to act.
  const activeRef = useRef(false);
  const partialUnsubscribeRef = useRef<(() => void) | null>(null);
  const finalUnsubscribeRef = useRef<(() => void) | null>(null);
  const captureRef = useRef<AudioCaptureHandle | null>(null);
  // The text currently typed into the PTY in the `live` experience, so we can
  // erase it (backspaces) on the next partial, on finalize, or on clear.
  const liveWrittenRef = useRef('');
  // How many PCM frames we have streamed for the current utterance. Passed to
  // `stop` as the drain target so finalize waits for the tail to be ingested
  // before decoding (the audio frames race the stop invoke over IPC).
  const framesSentRef = useRef(0);
  // True while an auto-submit paste is in flight in the main process. Blocks a
  // new push-to-talk from starting (and writing into the same PTY) until the
  // paste engine finishes, so fresh bytes never split the bracketed paste.
  const submittingRef = useRef(false);
  // True while the trailing-capture buffer is open (between release and the
  // actual capture stop). Blocks a new press from starting mid-window.
  const bufferingRef = useRef(false);
  // Latest config read by the press/release handlers without re-arming them.
  const optionsRef = useRef({ engineMode, modelId, liveModelId, punctuation, language, autoSubmit, releaseBufferMs, experience });
  optionsRef.current = { engineMode, modelId, liveModelId, punctuation, language, autoSubmit, releaseBufferMs, experience };

  const cleanupSubscriptions = useCallback(() => {
    partialUnsubscribeRef.current?.();
    partialUnsubscribeRef.current = null;
    finalUnsubscribeRef.current?.();
    finalUnsubscribeRef.current = null;
  }, []);

  const stopCapture = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  /** Erase whatever `live` mode typed into the terminal (backspaces). */
  const eraseLiveText = useCallback(() => {
    const { targetSessionId } = useDictationStore.getState();
    if (targetSessionId && liveWrittenRef.current.length > 0) {
      window.electronAPI.dictation.liveWrite(targetSessionId, '\x7f'.repeat(liveWrittenRef.current.length));
    }
    liveWrittenRef.current = '';
  }, []);

  const startDictation = useCallback(async (): Promise<void> => {
    // Ignore a press while recording, while the trailing-capture buffer is open,
    // or while a prior auto-submit paste is still landing (new live writes would
    // race the in-flight capture or split the bracketed paste).
    if (activeRef.current || submittingRef.current || bufferingRef.current) return;
    activeRef.current = true;
    liveWrittenRef.current = '';
    framesSentRef.current = 0;
    const targetSessionId = resolveDictationTarget();
    cleanupSubscriptions();
    partialUnsubscribeRef.current = window.electronAPI.dictation.onPartial((_dictationSessionId, text) => {
      const state = useDictationStore.getState();
      if (state.status !== 'recording') return;
      const preview = toPreviewCase(text);
      state.setPartial(preview);
      // Live experience: erase the previous partial and type the new one straight
      // into the focused terminal (append-only streaming engine feels live).
      if (optionsRef.current.experience === 'live' && state.targetSessionId) {
        const next = sanitizeInline(preview);
        const payload = '\x7f'.repeat(liveWrittenRef.current.length) + next;
        window.electronAPI.dictation.liveWrite(state.targetSessionId, payload);
        liveWrittenRef.current = next;
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
      useDictationStore.getState().beginRecording(result.dictationSessionId, targetSessionId);

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
    const { targetSessionId, finalText } = useDictationStore.getState();
    if (targetSessionId && finalText.trim().length > 0) {
      try {
        await window.electronAPI.dictation.commit(targetSessionId, finalText);
      } catch {
        // Best-effort injection; nothing actionable on failure.
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
      const { targetSessionId } = useDictationStore.getState();
      const eraseCount = liveWrittenRef.current.length;
      liveWrittenRef.current = '';
      if (targetSessionId) {
        const finalToType = sanitizeInline(finalText);
        if (optionsRef.current.autoSubmit && finalToType.trim().length > 0) {
          // Auto-submit: hand the refined text to the robust paste engine (in the
          // main process), which erases the live preview, pastes, and presses
          // Enter as a SEPARATE, settled, verified keystroke (retrying once). A
          // \r appended to a liveWrite does not submit - the TUI reads an Enter
          // in the same write as the text with stale state. Fire-and-forget so
          // the chip closes immediately; the guard blocks a new press until the
          // paste settles so fresh bytes never split the in-flight paste.
          submittingRef.current = true;
          void window.electronAPI.dictation
            .submit(targetSessionId, finalToType, eraseCount)
            .finally(() => {
              submittingRef.current = false;
            });
        } else {
          // Populate only: replace the preview with the refined text, no submit.
          window.electronAPI.dictation.liveWrite(
            targetSessionId,
            '\x7f'.repeat(eraseCount) + finalToType,
          );
        }
      }
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

  // Press half (keydown / pointerdown) via the central registry.
  useKeybinding(
    ACTION_ID,
    () => {
      void startDictation();
    },
    { enabled, capture: true, preventDefault: true, stopPropagation: true },
  );

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
      void finalizeOnRelease();
    };
    window.addEventListener(eventType, onRelease, true);
    return () => window.removeEventListener(eventType, onRelease, true);
  }, [enabled, combo, finalizeOnRelease]);

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
    },
    [cleanupSubscriptions, stopCapture],
  );
}
