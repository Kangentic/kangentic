import fs from 'node:fs';
import path from 'node:path';

export const WORKFLOWS_DIR = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows');

/** A workflow's text with LF endings, so a line-anchored regex reads a Windows checkout the same. */
export function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}
