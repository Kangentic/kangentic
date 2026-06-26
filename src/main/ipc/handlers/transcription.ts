import { ipcMain, systemPreferences } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type {
  DictationAudioChunk,
  DictationConfig,
  DictationMicPermission,
  DictationModelProgress,
  DictationStartOptions,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Ensure microphone access. On macOS we drive the TCC prompt via
 * `systemPreferences`; on Windows/Linux the renderer's `getUserMedia` plus the
 * app's `setPermissionRequestHandler` (src/main/index.ts) handle it, and an
 * actual OS-level denial surfaces as a `getUserMedia` rejection in the popup.
 */
async function requestMicrophone(): Promise<DictationMicPermission> {
  if (process.platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Voice-to-text dictation handlers. The renderer drives a push-to-talk
 * session: `start` opens it, the popup shows live `onPartial` text, and on
 * release/Send `stop` returns the finalized text which the renderer resolves a
 * target for and `commit`s (or auto-`submit`s) into the focused terminal.
 *
 * This wires every dictation channel: the session lifecycle (start / stop /
 * cancel), audio ingest (`TRANSCRIBE_AUDIO_CHUNK`), terminal injection
 * (commit / submit / live-write), model management (download / progress), and
 * the macOS mic-permission gate.
 */
export function registerTranscriptionHandlers(context: IpcContext): void {
  const { transcriptionService } = context;

  ipcMain.handle(IPC.TRANSCRIBE_START, (_event, options: DictationStartOptions) =>
    transcriptionService.start(options),
  );

  ipcMain.handle(IPC.TRANSCRIBE_STOP, (_event, dictationSessionId: string, expectedFrames?: number) =>
    transcriptionService.finalize(dictationSessionId, expectedFrames),
  );

  ipcMain.handle(IPC.TRANSCRIBE_CANCEL, (_event, dictationSessionId: string) => {
    transcriptionService.cancel(dictationSessionId);
  });

  ipcMain.handle(IPC.TRANSCRIBE_GET_INFO, (_event, config: DictationConfig) =>
    transcriptionService.getInfo(config),
  );

  ipcMain.handle(IPC.TRANSCRIBE_REQUEST_MIC, () => requestMicrophone());

  ipcMain.handle(IPC.TRANSCRIBE_DOWNLOAD_MODEL, (_event, config: DictationConfig) =>
    transcriptionService.downloadModel(config),
  );

  // Pre-load the engine for the selected config so the next press is instant
  // (the model load happens ahead of the press). Fire-and-forget; a `null`
  // config releases the warm engines (dictation disabled).
  ipcMain.on(IPC.TRANSCRIBE_PREWARM, (_event, config: DictationConfig | null) => {
    void transcriptionService.prewarm(config);
  });

  // Stream one PCM frame into the funnel. Fire-and-forget (ipcMain.on, no
  // round-trip) so rapid frames never block on a reply. This is the local
  // transport into the transport-agnostic ingest boundary; a future mobile
  // client feeds the same `ingest(...)`.
  ipcMain.on(IPC.TRANSCRIBE_AUDIO_CHUNK, (_event, chunk: DictationAudioChunk) => {
    transcriptionService.ingest(chunk.dictationSessionId, new Int16Array(chunk.pcm));
  });

  // Live experience: write raw bytes (text and/or \x7f backspaces) straight into
  // the focused terminal as the user speaks. Same ordered FIFO write path as
  // SESSION_WRITE, so it never fragments concurrent user typing.
  ipcMain.on(IPC.TRANSCRIBE_LIVE_WRITE, (_event, sessionId: string, payload: string) => {
    if (sessionId && payload) context.sessionManager.write(sessionId, payload);
  });

  // Inject finalized text into the focused terminal WITHOUT submitting. The
  // renderer resolves the single target session and passes it explicitly.
  // Newlines collapse to spaces so nothing accidentally submits; the user
  // presses Enter themselves. Writes go through the per-session ordered FIFO
  // queue (sessionManager.write), preserving byte order against concurrent
  // user typing - never `writeRaw`, never the paste engine (which submits).
  ipcMain.handle(IPC.TRANSCRIBE_COMMIT, (_event, sessionId: string, text: string): boolean => {
    const sanitized = text.replace(/[\r\n]+/g, ' ').trim();
    if (!sessionId || sanitized.length === 0) return false;
    context.sessionManager.write(sessionId, sanitized);
    return true;
  });

  // Auto-submit the finalized dictation. Erase the live preview, then paste +
  // submit the refined text through the robust paste engine (drain -> bracketed
  // paste -> output settle -> Enter via the queue -> submission evidence, retry
  // once). This is why appending a plain `\r` to the live text did NOT submit:
  // an Enter in the same write as the text is read by the TUI with stale state
  // (the text commits, the Enter handler misfires). The erase + submit run in
  // ONE handler so the backspaces and the paste cannot be reordered across IPC
  // channels (submitContent drains the queue before pasting, so the erase lands
  // first). Returns false if the paste engine could not confirm a submit; the
  // text is still in the input for the user to send manually.
  ipcMain.handle(
    IPC.TRANSCRIBE_SUBMIT,
    async (_event, sessionId: string, text: string, eraseCount: number): Promise<boolean> => {
      const sanitized = text.replace(/[\r\n]+/g, ' ').trim();
      if (!sessionId || sanitized.length === 0) return false;
      if (eraseCount > 0) context.sessionManager.write(sessionId, '\x7f'.repeat(eraseCount));
      try {
        await context.terminalSubmit.submitContent(sessionId, sanitized, { source: 'dictation' });
        return true;
      } catch {
        return false;
      }
    },
  );

  // Forward partial/final transcription results to the renderer popup, guarded
  // against a destroyed window during shutdown (mirrors the SESSION_DATA path).
  transcriptionService.on('partial', (dictationSessionId: string, text: string) => {
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.TRANSCRIBE_PARTIAL, dictationSessionId, text);
    }
  });

  transcriptionService.on('final', (dictationSessionId: string, text: string) => {
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.TRANSCRIBE_FINAL, dictationSessionId, text);
    }
  });

  // Model download progress (first-use auto-download) -> popup.
  transcriptionService.on('model-progress', (progress: DictationModelProgress) => {
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.TRANSCRIBE_MODEL_PROGRESS, progress);
    }
  });
}
