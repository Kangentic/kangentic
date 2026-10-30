/**
 * Every adapter's `resumePromptDelivery` matches what its real builder does
 * (`AgentAdapter.resumePromptDelivery`, src/main/agent/agent-adapter.ts).
 *
 * The declaration decides whether a resume's message (a column's message, a
 * plan continuation, a handoff pointer, held messages) rides the command line
 * or is typed in. Five builders once dropped the prompt on a resume while the
 * spawn reported it sent, and the message never arrived. So this drives each
 * registered adapter's `buildCommand` for a resume carrying a marked prompt:
 *
 * - declared `'command-line'`: the prompt is in the resume command;
 * - declared `'typed'`: it is not (a builder that carries it should say so,
 *   or the message would arrive twice once the engine types it too);
 * - declared `'no-resume'`: the adapter has no way to resume at all, so every
 *   start is fresh.
 *
 * Runtime checks over the real registry, since `tests/unit/` is not typechecked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const PROMPT_MARKER = 'resume_prompt_marker_4b7e';
const SESSION_ID = '0f9c7d42-5b1e-4c3a-9a77-2d1f8e6b4c10';

let workingFolder: string;
let sessionFolder: string;

beforeEach(() => {
  workingFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-prompt-cwd-'));
  sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-prompt-session-'));
});

afterEach(() => {
  fs.rmSync(workingFolder, { recursive: true, force: true });
  fs.rmSync(sessionFolder, { recursive: true, force: true });
});

function resumeOptions(): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/agent-under-test',
    taskId: 'resume-prompt-test-task',
    cwd: workingFolder,
    projectRoot: workingFolder,
    permissionMode: 'default',
    sessionId: SESSION_ID,
    resume: true,
    prompt: PROMPT_MARKER,
    statusOutputPath: path.join(sessionFolder, 'status.json'),
    eventsOutputPath: path.join(sessionFolder, 'events.jsonl'),
    shell: 'bash',
    mcpServerEnabled: false,
  };
}

const adapterNames = agentRegistry.list();

describe('resumePromptDelivery declarations match the real builders', () => {
  it('covers the registry', () => {
    // A registry that failed to load would pass every case below vacuously.
    expect(adapterNames.length).toBeGreaterThan(10);
    const carrying = adapterNames.filter((name) => agentRegistry.getOrThrow(name).resumePromptDelivery === 'command-line');
    expect(carrying.length).toBeGreaterThan(0);
  });

  describe.each(adapterNames)('%s', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);

    it('declares one of the three values', () => {
      expect(['command-line', 'typed', 'no-resume']).toContain(adapter.resumePromptDelivery);
    });

    it('builds a resume command that carries the prompt exactly when it says so', () => {
      if (adapter.resumePromptDelivery === 'no-resume') {
        // Nothing gives it an id to resume by, so the engine never asks it to.
        expect(adapter.supportsCallerSessionId, `${adapterName} says it never resumes but takes a caller session id`).toBe(false);
        expect(adapter.createSessionId, `${adapterName} says it never resumes but creates session ids`).toBeUndefined();
        expect(adapter.capturesInteractiveSessionId ?? false, `${adapterName} says it never resumes but captures a session id`).toBe(false);
        expect(adapter.runtime.sessionId, `${adapterName} says it never resumes but reads a session id from its runtime`).toBeUndefined();
        return;
      }
      const command = adapter.buildCommand(resumeOptions());
      if (adapter.resumePromptDelivery === 'command-line') {
        expect(command, `${adapterName} says its resume carries the prompt, but the command drops it`).toContain(PROMPT_MARKER);
      } else {
        expect(command, `${adapterName} carries the prompt on resume but says it is typed`).not.toContain(PROMPT_MARKER);
      }
    });
  });
});
