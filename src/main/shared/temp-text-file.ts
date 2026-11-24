import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Call `run` with a temp file holding `text`, removed after. For text that must
 * not ride a command line: a commit message or a pull request body can be long,
 * hold newlines, and on Windows pass through cmd.exe.
 */
export async function withTempTextFile<T>(text: string, run: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kangentic-text-'));
  try {
    const filePath = path.join(directory, 'text.txt');
    await fs.promises.writeFile(filePath, text, 'utf8');
    return await run(filePath);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
      .catch(() => undefined); // report-ok: a leftover temp file costs nothing and the OS clears it
  }
}
