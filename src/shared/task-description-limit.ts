/**
 * The longest task description a save accepts.
 *
 * A fresh start puts the description on the agent's command line, where Windows
 * allows 32,766 characters and the rest of the prompt and the command take the
 * difference (`COMMAND_LINE_RESERVE` for the command's own flags). The task
 * envelope takes about 100, a workflow task's `<workflow>` block about 2,250, and
 * ten attachment paths about 1,200, so a task at this length fits every agent
 * with those on it. The longest task description on the dogfooding board is
 * 27,305. At three UTF-8 bytes a character it also stays under Linux's 128 KiB
 * per argument. `tests/unit/task-description-limit.test.ts` builds every adapter's
 * real command at this length and fails if the two limits drift apart.
 */
export const TASK_DESCRIPTION_MAX_LENGTH = 27_500;

/** What a refused save says, for an agent or a toast to act on. */
export function taskDescriptionTooLong(overage: number): string {
  return `The description is over the ${TASK_DESCRIPTION_MAX_LENGTH} character limit by ${overage}. Shorten it, or attach the rest as a file.`;
}

/**
 * How many characters over the limit a save would be, or 0 when it may go ahead.
 * A description that is already over and did not grow passes, so a longer task
 * from before this limit, or from a board import, keeps every other edit.
 */
export function taskDescriptionOverage(description: string, previousDescription: string | null): number {
  const overage = description.length - TASK_DESCRIPTION_MAX_LENGTH;
  if (overage <= 0) return 0;
  return previousDescription !== null && description.length <= previousDescription.length ? 0 : overage;
}

/** Why a save may not go ahead, or null when it may. */
export function taskDescriptionRefusal(description: string, previousDescription: string | null): string | null {
  const overage = taskDescriptionOverage(description, previousDescription);
  return overage > 0 ? taskDescriptionTooLong(overage) : null;
}
