import fs from 'node:fs';
import path from 'node:path';
import { isGitRepo, isFileTracked } from '../../git/git-checks';

/**
 * Ensure `.kangentic/` and `.claude/settings.local.json` are listed in the
 * project's `.gitignore`.  Fully wrapped in try-catch -- a read-only project
 * directory or permission issue must never prevent the app from opening.
 *
 * Async and safe to fire-and-forget: nothing downstream of a project open
 * reads its effect, and the git tracked-file probe used to run as a
 * synchronous subprocess on the switch critical path. Never rejects.
 */
export async function ensureGitignore(projectPath: string): Promise<void> {
  try {
    if (!isGitRepo(projectPath)) return;
    const gitignorePath = path.join(projectPath, '.gitignore');
    let content = '';
    try {
      content = await fs.promises.readFile(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore yet -- we'll create one
    }

    // 1. Ensure .kangentic/ is ignored
    const lines = content.split('\n');
    const kangenticIgnored = lines.some(
      (l) => l.trim() === '.kangentic' || l.trim() === '.kangentic/',
    );
    if (!kangenticIgnored) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      content = content + separator + '.kangentic/\n';
      await fs.promises.writeFile(gitignorePath, content);
    }

    // 2. Ensure .claude/settings.local.json is ignored -- but only if the project
    //    hasn't intentionally committed it (e.g. to accumulate permission allowlists).
    const linesAfter = content.split('\n');
    const settingsIgnored = linesAfter.some(
      (l) => l.trim() === '.claude/settings.local.json',
    );
    if (!settingsIgnored) {
      const settingsTracked = await isFileTracked(projectPath, '.claude/settings.local.json');
      if (!settingsTracked) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        content = content + separator + '.claude/settings.local.json\n';
        await fs.promises.writeFile(gitignorePath, content);
      }
    }

    // 3. Ensure kangentic.local.json is ignored (personal board overrides)
    const linesAfterLocal = content.split('\n');
    const localConfigIgnored = linesAfterLocal.some(
      (l) => l.trim() === 'kangentic.local.json',
    );
    if (!localConfigIgnored) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      content = content + separator + 'kangentic.local.json\n';
      await fs.promises.writeFile(gitignorePath, content);
    }

    // Note: the OpenCode activity plugin (`.opencode/plugins/kangentic-activity.mjs`)
    // is NOT ignored here. That entry is added lazily by the OpenCode adapter's
    // buildHooks() at spawn time, so projects that never use OpenCode never get
    // a stray ignore line.
  } catch (err) {
    // Non-fatal: log and continue. Project may be read-only or on a network drive.
    console.warn(`[PROJECT_OPEN] Could not update .gitignore at ${projectPath}:`, err);
  }
}
