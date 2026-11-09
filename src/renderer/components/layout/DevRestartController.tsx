import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Plural, useLingui } from '@lingui/react/macro';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useKeybinding } from '../../hooks/useKeybinding';
import { countWorkingAgents, performDevRestart, setDevRestartRequester } from '../../utils/dev-restart';

/**
 * Dev only, main window only (mounted by AppLayout under `__KANGENTIC_DEV__`).
 * Mounting it is what lets this window show dev.js's "Main process changed"
 * notice; it binds the `app.restart` hotkey and asks before a restart that
 * would interrupt an agent mid-turn. The flow and the Vite listener live in
 * `utils/dev-restart.ts`.
 */
export function DevRestartController() {
  const { t } = useLingui();
  const [workingAgentCount, setWorkingAgentCount] = useState<number | null>(null);
  // While the confirm is up, a second press (hotkey or toast) waits for the
  // user's answer instead of restarting past the dialog.
  const confirmOpenRef = useRef(false);

  const closeConfirm = useCallback(() => {
    confirmOpenRef.current = false;
    setWorkingAgentCount(null);
  }, []);

  const startRestart = useCallback(() => {
    if (confirmOpenRef.current) return;
    const working = countWorkingAgents();
    if (working > 0) {
      confirmOpenRef.current = true;
      setWorkingAgentCount(working);
    } else {
      void performDevRestart();
    }
  }, []);

  useEffect(() => setDevRestartRequester(startRestart), [startRestart]);

  // Capture phase: the key must work with a terminal focused, which is where the
  // user's Ctrl+R went (#1052). In the bubble phase xterm turns the combo into
  // an escape sequence for the agent and stops the event before it gets here.
  useKeybinding('app.restart', startRestart, { capture: true });

  if (workingAgentCount === null) return null;
  return (
    <ConfirmDialog
      title={t`Restart Kangentic?`}
      message={(
        <Plural
          value={workingAgentCount}
          one="# agent is working. It pauses for the restart and resumes after, but its current turn stops."
          other="# agents are working. They pause for the restart and resume after, but their current turns stop."
        />
      )}
      confirmLabel={t({ message: 'Restart', context: 'Action' })}
      icon={<RotateCw className="text-accent-fg" />}
      testId="dev-restart-confirm"
      onConfirm={() => {
        closeConfirm();
        void performDevRestart();
      }}
      onCancel={closeConfirm}
    />
  );
}
