#!/usr/bin/env node
/**
 * Fast-detach launcher for tests/e2e/task-process-reap.spec.ts.
 *
 * mock-claude.js starts this when MOCK_CLAUDE_FAST_DETACH_RESULT_FILE is set. It
 * is the "launcher" half of a fast detach, the shape of `nohup npm run dev &`
 * run from an agent's Bash tool: it starts a long-lived process, records who
 * started it, and exits at once. That leaves the survivor with no live parent,
 * so no parent-pid walk from the PTY (or from Kangentic) can reach it. The only
 * thing that still ties it to its task is the KANGENTIC_TASK_ID tag it inherited
 * from the PTY, which is exactly what the reap is supposed to key on.
 *
 * It deliberately passes no `env` to spawn, so the survivor inherits this
 * process's environment, tag included. Deleting KANGENTIC_TASK_ID from the
 * survivor's environment is the way to prove the spec can fail.
 *
 * argv: <resultFile> <agentPid> <survivorLifetimeMs>
 *
 * Writes <resultFile> atomically (temp file, then rename) so the spec never reads
 * half a JSON document:
 *   { agentPid, launcherPid, survivorPid, tag }
 *
 * The survivor is plain node with a bounded lifetime and no signal handlers. The
 * bound only limits what a failed run can leak; the spec kills a survivor it
 * still sees alive, and the reap is what is under test.
 *
 * Cross-platform on purpose: `cmd /c start /b` keeps the child on the
 * pseudoconsole, so closing the PTY could kill it and the mid-board "keeps
 * running" assertion would fail for a reason unrelated to the reap. A node child
 * started with `detached: true` has no console on Windows (DETACHED_PROCESS) and
 * its own session on POSIX (setsid).
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [resultFile, agentPidText, survivorLifetimeText] = process.argv.slice(2);
const survivorLifetimeMs = parseInt(survivorLifetimeText, 10);

// The survivor inherits the agent's working directory, inside the task's
// project, as a dev server does: the reap kills only processes working there.
// A survivor a failed run leaks is killed by the spec, which frees the temp
// project on Windows.
const survivor = spawn(
  process.execPath,
  ['-e', 'setTimeout(function(){},' + survivorLifetimeMs + ')'],
  { detached: true, stdio: 'ignore', windowsHide: true },
);
survivor.unref();

const result = {
  agentPid: parseInt(agentPidText, 10),
  launcherPid: process.pid,
  survivorPid: typeof survivor.pid === 'number' ? survivor.pid : -1,
  tag: process.env.KANGENTIC_TASK_ID || null,
};

const temporaryFile = resultFile + '.tmp';
fs.writeFileSync(temporaryFile, JSON.stringify(result));
fs.renameSync(temporaryFile, resultFile);

process.exit(0);
