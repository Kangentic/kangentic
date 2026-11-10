import fs from 'node:fs';

/**
 * What a stat of a path proves: `present`, `missing` (ENOENT and nothing else),
 * or `unknown` for any other failure, such as a permission error, a locked file
 * or a distro path this machine cannot read.
 */
export type FileState = 'present' | 'missing' | 'unknown';

export async function fileStateOf(filePath: string): Promise<FileState> {
  try {
    await fs.promises.stat(filePath);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/**
 * True only when the path does not exist (ENOENT). A permission error, a
 * locked file or any other failure is not proof of absence, so it answers
 * false. The resume check's verdicts rest on this one rule
 * (`resume-conversation-guard.ts`, each adapter's `proveConversationGone`).
 */
export async function isConfirmedMissing(filePath: string): Promise<boolean> {
  return (await fileStateOf(filePath)) === 'missing';
}
