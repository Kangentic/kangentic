import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import type { StopScriptFailedEvent } from '../../shared/types';
import { asSentence } from './ipc-error';

/**
 * The body of the "Stop script failed" toast: the task, and what happened to the
 * script in the script's own words. It gives no advice, since a diagnosis is a
 * guess and the error is always true. Resolved at call time, after the session's
 * catalog loads.
 */
export function stopScriptFailureBody({ taskTitle, failure }: Pick<StopScriptFailedEvent, 'taskTitle' | 'failure'>): string {
  switch (failure.kind) {
    case 'exit-code': {
      const { exitCode, detail } = failure;
      const line = i18n._(msg`"${{ taskTitle }}": exited with code ${{ exitCode }}.`);
      return detail ? `${line} ${asSentence(detail)}` : line;
    }
    case 'timeout': {
      const seconds = Math.round(failure.timeoutMs / 1000);
      if (seconds < 60) {
        return i18n._(msg`"${{ taskTitle }}": timed out after ${plural({ seconds }, { one: '# second', other: '# seconds' })}.`);
      }
      const minutes = Math.round(seconds / 60);
      return i18n._(msg`"${{ taskTitle }}": timed out after ${plural({ minutes }, { one: '# minute', other: '# minutes' })}.`);
    }
    case 'error': {
      const detail = asSentence(failure.detail);
      return i18n._(msg`"${{ taskTitle }}": ${{ detail }}`);
    }
    default: {
      const unknownFailure: never = failure;
      throw new Error(`unknown Stop script failure: ${JSON.stringify(unknownFailure)}`);
    }
  }
}
