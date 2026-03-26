import fs from 'node:fs';
import path from 'node:path';
import { isGitRepo, isFileTracked } from '../../git/worktree-manager';

/**
 * Ensure `.kangentic/` and `.claude/settings.local.json` are listed in the
 * project's `.gitignore`.  Fully wrapped in try-catch -- a read-only project
 * directory or permission issue must never prevent the app from opening.
 */
export function ensureGitignore(projectPath: string): void {
  if (!isGitRepo(projectPath)) return;
  try {
    const gitignorePath = path.join(projectPath, '.gitignore');
    let content = '';
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
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
      fs.writeFileSync(gitignorePath, content);
    }

    // 2. Ensure .claude/settings.local.json is ignored -- but only if the project
    //    hasn't intentionally committed it (e.g. to accumulate permission allowlists).
    const linesAfter = content.split('\n');
    const settingsIgnored = linesAfter.some(
      (l) => l.trim() === '.claude/settings.local.json',
    );
    if (!settingsIgnored) {
      const settingsTracked = isFileTracked(projectPath, '.claude/settings.local.json');
      if (!settingsTracked) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        content = content + separator + '.claude/settings.local.json\n';
        fs.writeFileSync(gitignorePath, content);
      }
    }

    // 3. Ensure kangentic.local.json is ignored (personal board overrides)
    const linesAfterLocal = content.split('\n');
    const localConfigIgnored = linesAfterLocal.some(
      (l) => l.trim() === 'kangentic.local.json',
    );
    if (!localConfigIgnored) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(gitignorePath, content + separator + 'kangentic.local.json\n');
    }
  } catch (err) {
    // Non-fatal: log and continue. Project may be read-only or on a network drive.
    console.warn(`[PROJECT_OPEN] Could not update .gitignore at ${projectPath}:`, err);
  }
}
