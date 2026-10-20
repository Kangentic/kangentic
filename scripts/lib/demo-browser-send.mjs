/**
 * The scratch-tree half of a recorded Browser pane Send (scripts/capture-demo-sessions.mjs, the
 * manifest's `browserSends`): the session's own edits put back on a freshly reset tree, so the
 * resumed conversation finds the code it says it wrote, and the project's `.kangentic/` kept out
 * of git's view while the screenshot the payload names sits under it.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write each changed file a recording carries (`changes` in its record, the shape git.diffFiles
 * returns) into `cwd`: its whole modified text, or a deletion. A binary or oversized file was
 * recorded with no text (scripts/capture-agent-scrollback.js, collectChanges), so writing it would
 * empty the file the conversation edited; it is left as the tree has it and named in `skipped`.
 */
export function applyRecordedChanges(recording, cwd) {
  const applied = [];
  const skipped = [];
  for (const file of recording.changes?.files ?? []) {
    if (file.binary) {
      skipped.push(file.path);
      continue;
    }
    const target = path.join(cwd, file.path);
    if (file.status === 'D') {
      fs.rmSync(target, { force: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.modified);
    }
    applied.push(file.path);
  }
  return { applied, skipped };
}

/**
 * Add `pattern` to the clone's own `.git/info/exclude`, so the agent's diff never shows what is
 * written there. Returns the function that puts the file back exactly as it was, missing included.
 */
export function excludeFromGit(cwd, pattern) {
  const excludePath = path.join(cwd, '.git', 'info', 'exclude');
  const existed = fs.existsSync(excludePath);
  const before = existed ? fs.readFileSync(excludePath, 'utf-8') : '';
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const separator = before === '' || before.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(excludePath, `${before}${separator}${pattern}\n`);
  return function restoreExclude() {
    if (existed) fs.writeFileSync(excludePath, before);
    else fs.rmSync(excludePath, { force: true });
  };
}
