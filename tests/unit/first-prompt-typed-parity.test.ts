/**
 * Which adapters may start a task's agent before its first prompt is ready
 * (`AgentAdapter.firstPromptMayBeTyped`, #955): the agent boots while its new
 * worktree runs its setup script, and the prompt is typed in once the script
 * ends. That is only the same first message when the CLI's promptless launch
 * is the same interactive session, so the verdict is per adapter and every
 * registered adapter must have one here. A new adapter fails until someone
 * decides.
 *
 * The verdicts come from each builder's promptless branch, the CLI's own help
 * text, and a promptless launch of each installed CLI
 * (docs/integrations/agents/adapter-interface.md lists the reasons).
 * Each declared adapter's fresh interactive command is also built with no
 * prompt, which must work and carry nothing of a prompt.
 *
 * Runtime checks over the real registry, since `tests/unit/` is not typechecked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

/**
 * A promptless launch opens the same interactive session at its input box, and
 * that was seen in a preview: the typed prompt landed there.
 */
const TYPED_FIRST_PROMPT = ['claude'];

/**
 * The spawn adopts an early agent only once its TUI has entered the alternate
 * screen, because a boot screen (an update offer, a sign-in, a folder trust or
 * MCP approval) takes the typed prompt's Enter as its answer. That tells the
 * two apart only for a CLI that draws its boot screens outside the alternate
 * screen and its input box inside. Measured 2026-10-31 by launching each
 * installed CLI with no prompt in a fresh git repository on Windows, 120x32,
 * and watching for the alternate screen for 14 s; no turn ran.
 */
const NEVER_ENTERS_ALTERNATE_SCREEN = 'its promptless launch never entered the alternate screen, so the spawn could never adopt it';
const BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN = 'it enters the alternate screen within 2.3 s and draws its boot screens there, so being in it does not mean the input box is up';

/** Each with the reason a prompt typed into its promptless launch is not the same first message. */
const COMMAND_LINE_FIRST_PROMPT: Record<string, string> = {
  aider: '`--message` sends one message and exits; without it Aider is an interactive chat, a different run',
  cursor: 'only its `default` permission mode is interactive; every other mode is a stream-json print run',
  ollama: 'a prompt is one turn that exits; without one `ollama run` opens a REPL',
  warp: '`oz agent run` is a one-shot runner with no input box',
  antigravity: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (its sign-in and folder trust)`,
  codex: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (its sign-in)`,
  copilot: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (a selection menu over its input box)`,
  droid: `${NEVER_ENTERS_ALTERNATE_SCREEN} (its sign-in is drawn on the main screen)`,
  gemini: `${NEVER_ENTERS_ALTERNATE_SCREEN} (its folder trust is drawn on the main screen)`,
  goose: 'not installed where this was measured; interactive with no prompt, but its first screen is unconfirmed',
  grok: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (its data-sharing opt-in)`,
  kimi: NEVER_ENTERS_ALTERNATE_SCREEN,
  opencode: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (its update offer)`,
  qwen: `${BOOT_SCREEN_INSIDE_ALTERNATE_SCREEN} (none showed in the run, but nothing is drawn before it, so its recorded update and MCP approval screens are too)`,
};

let workingFolder: string;
let sessionFolder: string;

beforeEach(() => {
  workingFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-first-prompt-cwd-'));
  sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-first-prompt-session-'));
});

afterEach(() => {
  fs.rmSync(workingFolder, { recursive: true, force: true });
  fs.rmSync(sessionFolder, { recursive: true, force: true });
});

function freshOptions(): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/agent-under-test',
    taskId: 'first-prompt-test-task',
    cwd: workingFolder,
    projectRoot: workingFolder,
    permissionMode: 'default',
    sessionId: '0f9c7d42-5b1e-4c3a-9a77-2d1f8e6b4c10',
    resume: false,
    prompt: undefined,
    statusOutputPath: path.join(sessionFolder, 'status.json'),
    eventsOutputPath: path.join(sessionFolder, 'events.jsonl'),
    shell: 'bash',
    mcpServerEnabled: false,
    ptySessionId: 'first-prompt-test-session',
  };
}

const adapterNames = agentRegistry.list();

describe('firstPromptMayBeTyped declarations', () => {
  it('covers the registry: every adapter has a verdict, and no verdict names a missing adapter', () => {
    expect(adapterNames.length).toBeGreaterThan(10);
    const classified = [...TYPED_FIRST_PROMPT, ...Object.keys(COMMAND_LINE_FIRST_PROMPT)].sort();
    expect([...adapterNames].sort()).toEqual(classified);
  });

  it.each(adapterNames)('%s declares the verdict listed here', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);
    expect(typeof adapter.firstPromptMayBeTyped === 'function').toBe(TYPED_FIRST_PROMPT.includes(adapterName));
  });

  it.each(TYPED_FIRST_PROMPT)('%s builds its fresh interactive command with no prompt', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);
    const command = adapter.buildCommand(freshOptions());
    expect(command.length).toBeGreaterThan(0);
    expect(command).not.toMatch(/undefined/);
  });
});
