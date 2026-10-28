import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import { POP_OUT_SURFACES, type PopOutChangesFileParams } from '../../../../../shared/pop-out';
import { useToastStore } from '../../../../stores/toast-store';
import { asSentence, describeIpcError } from '../../../../lib/ipc-error';

/**
 * Open one file's diff in its own 'changes-file' window, or focus the one
 * already open for it. Main enforces the cap (maxInstances) and resolves false
 * at it; a refused open and a failed one are reported as toasts. Shared by the
 * Changes panel's "Open in new window" and a file window's markdown preview
 * following a link to another file, so both report the same way.
 */
export async function openChangesFileWindow(params: PopOutChangesFileParams): Promise<void> {
  try {
    const opened = await window.electronAPI.popOut.open('changes-file', params);
    if (opened) return;
    // changes-file always declares a cap; the fallback only satisfies the type.
    const maxInstances = POP_OUT_SURFACES['changes-file'].maxInstances ?? 0;
    useToastStore.getState().addToast({
      title: i18n._(msg`Window limit reached`),
      message: i18n._(msg`${plural({ maxInstances }, {
        one: '# file diff window is open. Close it to open another.',
        other: '# file diff windows are open. Close one to open another.',
      })}`),
      variant: 'info',
    });
  } catch (error) {
    useToastStore.getState().addToast({
      title: i18n._(msg`Couldn't open file diff`),
      message: asSentence(describeIpcError(error, i18n._(msg`The window could not be created.`))),
      variant: 'error',
    });
  }
}
