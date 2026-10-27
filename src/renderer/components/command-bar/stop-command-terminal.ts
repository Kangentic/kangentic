/**
 * Stop a Command Terminal from the desktop: its header's Stop, or its Stop in
 * the panel rail's Running list while another terminal is expanded. Both end
 * the same way, so they share this.
 *
 * The kill scrubs the slot's pairing before it reaches main
 * (`killTransientSessionBySlot`), so main's removal push reads as this
 * terminal's own end and closes nothing a second time. Only a kill that FAILED
 * is said out loud; the caller closes the window on every outcome, because the
 * user asked for this terminal to go away (see `handleTerminate` in
 * CommandTerminalWindow.tsx for why 'no-session' stays quiet).
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import type { TransientKillOutcome } from '../../stores/session-store/transient-session-slice';

export async function killCommandTerminalInSlot(slot: string): Promise<void> {
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  let outcome: TransientKillOutcome = 'no-session';
  try {
    if (currentProjectId) {
      outcome = await useSessionStore.getState().killTransientSessionBySlot(currentProjectId, slot);
    }
  } catch {
    outcome = 'failed';
  }
  if (outcome === 'failed') {
    useToastStore.getState().addToast({
      title: i18n._(msg`Couldn't stop the terminal`),
      message: i18n._(msg`Its process may still be running.`),
      variant: 'error',
    });
  }
}
