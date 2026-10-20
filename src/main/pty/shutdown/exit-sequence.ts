import type { ExitSequenceStep } from '../../../shared/types';

/**
 * Write an agent's exit sequence, honoring its pauses.
 *
 * Keys up to the first pause are written at once; the rest follow on timers.
 * Each write is attempted on its own and a throw is swallowed: the PTY may die
 * between writes (the agent took the first keys and exited), and whoever
 * asked has a force-kill or a grace that follows either way.
 */
export function writeExitSteps(
  write: (data: string) => void,
  steps: readonly ExitSequenceStep[],
  schedule: (callback: () => void, delayMs: number) => unknown = setTimeout,
): void {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (typeof step === 'string') {
      try {
        write(step);
      } catch {
        // The PTY may already be gone.
      }
      continue;
    }
    const rest = steps.slice(index + 1);
    if (rest.length > 0) schedule(() => writeExitSteps(write, rest, schedule), step.delayMs);
    return;
  }
}
