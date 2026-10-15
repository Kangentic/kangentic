import fs from 'node:fs';

/**
 * True only when the path does not exist (ENOENT). A permission error, a
 * locked file or any other failure is not proof of absence, so it answers
 * false. The resume check's verdicts rest on this one rule
 * (`resume-conversation-guard.ts`, each adapter's `proveConversationGone`).
 */
export async function isConfirmedMissing(filePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
