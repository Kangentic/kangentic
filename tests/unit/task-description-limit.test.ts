/**
 * The limit a task description is saved under, against the limit its agent can
 * start with. A fresh start puts the description on the command line, so a field
 * longer than the line starts nothing: measured on a 40,000 character task, the
 * card showed a working agent for four minutes before it said anything.
 *
 * Drives every registered adapter's real builder, so raising
 * `TASK_DESCRIPTION_MAX_LENGTH`, or a builder growing past
 * `COMMAND_LINE_RESERVE`, fails here rather than on someone's board.
 *
 * Runtime checks over the real registry, since `tests/unit/` is not typechecked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod/v4';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { registerWorkflowTools } from '../../src/main/agent/mcp-http/workflow-tools';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { interpolateTaskTemplate } from '../../src/main/agent/shared/template-utils';
import { TASK_TEMPLATE_RESOLVERS } from '../../src/main/agent/shared/task-template-resolvers';
import {
  CMD_COMMAND_LINE_LIMIT,
  LINUX_ARGUMENT_BYTE_LIMIT,
  WINDOWS_COMMAND_LINE_LIMIT,
  commandFitsShell,
} from '../../src/main/pty/spawn/typed-launch';
import { COMMAND_LINE_RESERVE, freshPromptRidesCommandLine } from '../../src/main/transition-engine/resume-prompt-delivery';
import { TASK_DESCRIPTION_MAX_LENGTH, taskDescriptionOverage } from '../../src/shared/task-description-limit';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../src/shared/task-template-vars';
import type { Task } from '../../src/shared/types';

const SHELL = 'powershell';
const NATIVE_CLI = 'C:\\Users\\dev\\AppData\\Local\\Programs\\agent\\agent.exe';
const CMD_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\agent.cmd';
/** The attachment paths a full task carries, at a real attachment path's length. */
const ATTACHMENT_PATHS = Array.from({ length: 10 }, (_, index) =>
  `C:\\Users\\dev\\Documents\\project\\.kangentic\\tasks\\0f9c7d42-5b1e-4c3a-9a77-2d1f8e6b4c10\\attachments\\design-${index}.png`);

/** What a workflow task's prompt adds: the mechanics, its route and its neighbours. */
const WORKFLOW_FACTS = {
  title: 'Upgrade every dependency',
  route: ['Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done'],
  column: 'Planning',
  planExitTo: 'Executing',
  ownConversation: ['Code Review', 'Testing'],
  waitsFor: [{ number: 41, title: 'Pin the toolchain', column: 'Done', branch: 'pin-the-toolchain-1a2b3c4d', prUrl: 'https://github.com/owner/repo/pull/41' }],
  blocks: [{ number: 43, title: 'Rebuild the native modules', column: 'To Do' }],
};

/** The description, as the default column prompt renders it for a workflow task, the longest shape. */
function renderedPrompt(description: string): string {
  const task = { title: 'Upgrade every dependency', description } as Task;
  const context = {
    task, defaultBaseBranch: 'main', attachmentPaths: ATTACHMENT_PATHS, devPort: null,
    projectPath: null, projectName: null, move: null, workflow: WORKFLOW_FACTS,
  };
  const variables = Object.fromEntries(
    Object.entries(TASK_TEMPLATE_RESOLVERS).map(([name, resolve]) => [name, resolve(context)]),
  );
  return interpolateTaskTemplate(DEFAULT_SPAWN_PROMPT_TEMPLATE, variables);
}

const longestDescription = 'Update the package and confirm the build passes.\n'.repeat(1_000).slice(0, TASK_DESCRIPTION_MAX_LENGTH);

let workingFolder: string;
let sessionFolder: string;
const hostPlatform = process.platform;

// Builders branch on the platform, and CI's runner is Linux, so these build the
// Windows command the limits are about. The folders are as long as a real
// Windows worktree's and session's, which a temp folder on Linux is not.
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  workingFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-description-limit-cwd-at-the-length-of-a-windows-worktree-path-'));
  sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-description-limit-session-at-the-length-of-a-windows-session-path-'));
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform });
  fs.rmSync(workingFolder, { recursive: true, force: true });
  fs.rmSync(sessionFolder, { recursive: true, force: true });
});

function freshOptions(agentPath: string, prompt: string | undefined): SpawnCommandOptions {
  return {
    agentPath,
    taskId: 'description-limit-test-task',
    cwd: workingFolder,
    projectRoot: workingFolder,
    permissionMode: 'default',
    resume: false,
    prompt,
    statusOutputPath: path.join(sessionFolder, 'status.json'),
    eventsOutputPath: path.join(sessionFolder, 'events.jsonl'),
    shell: SHELL,
    mcpServerEnabled: true,
    mcpServerUrl: 'http://127.0.0.1:4100/mcp/0f9c7d42-5b1e-4c3a-9a77-2d1f8e6b4c10?session=7c1e1f0a-3b65-4d55-8f0a-52c2dc3f9a11',
    mcpServerToken: '0123456789abcdef0123456789abcdef',
    browserAutomationEnabled: true,
    ptySessionId: 'description-limit-test-session',
  };
}

const adapterNames = agentRegistry.list();

describe('a task description at the limit', () => {
  it('covers the registry', () => {
    expect(adapterNames.length).toBeGreaterThan(10);
  });

  it.each(adapterNames)('starts %s on a normal Windows install, whole, with attachments', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);
    const prompt = renderedPrompt(longestDescription);
    const command = adapter.buildCommand(freshOptions(NATIVE_CLI, prompt));

    expect(commandFitsShell({ command, shell: SHELL, platform: 'win32' }), `${adapterName}'s command does not fit`).toBe(true);
  });

  it('leaves the prompt measured, so a template that grows shows up here', () => {
    const prompt = renderedPrompt(longestDescription);

    expect(prompt.length).toBeGreaterThan(TASK_DESCRIPTION_MAX_LENGTH);
    expect(prompt).toContain('<workflow>');
    expect(prompt).toContain(ATTACHMENT_PATHS[9]);
  });

  it('rides a Linux launch at the limit, in three-byte text', () => {
    const prompt = renderedPrompt('界'.repeat(TASK_DESCRIPTION_MAX_LENGTH));

    expect(freshPromptRidesCommandLine({ prompt, agentPath: '/usr/local/bin/agent', shell: '/bin/bash', platform: 'linux' })).toBe(true);
  });

  it('does not fit a `.cmd` shim, so the engine does not leave it on that command line', () => {
    const prompt = renderedPrompt(longestDescription);

    expect(freshPromptRidesCommandLine({ prompt, agentPath: CMD_SHIM, shell: SHELL, platform: 'win32' })).toBe(false);
  });
});

describe('the engine and the spawn read one limit', () => {
  describe.each([
    ['a native program', NATIVE_CLI, WINDOWS_COMMAND_LINE_LIMIT],
    ['a `.cmd` shim', CMD_SHIM, CMD_COMMAND_LINE_LIMIT],
  ])('through %s', (_route, agentPath, limit) => {
    const longestRiding = 'x'.repeat(limit - COMMAND_LINE_RESERVE);

    it('holds the budget at the exact character', () => {
      expect(freshPromptRidesCommandLine({ prompt: longestRiding, agentPath, shell: SHELL, platform: 'win32' })).toBe(true);
      expect(freshPromptRidesCommandLine({ prompt: `${longestRiding}x`, agentPath, shell: SHELL, platform: 'win32' })).toBe(false);
    });

    // A prompt the engine lets ride and the spawn refuses would stop a task that
    // could have been typed in.
    it.each(adapterNames)('never refuses what it let ride on %s', (adapterName) => {
      const adapter = agentRegistry.getOrThrow(adapterName);
      const command = adapter.buildCommand(freshOptions(agentPath, longestRiding));

      expect(commandFitsShell({ command, shell: SHELL, platform: 'win32' })).toBe(true);
    });
  });
});

describe('a Linux launch, where quoting grows a prompt', () => {
  const LINUX_AGENT = '/usr/local/bin/agent';
  const BASH = '/bin/bash';
  const budget = LINUX_ARGUMENT_BYTE_LIMIT - COMMAND_LINE_RESERVE;
  /** Bash writes each `'` as `'\''`, so this sentence costs eight bytes in five characters. */
  const sentence = "it's ";
  const sentenceCost = 8;
  const longestRiding = `${sentence.repeat(Math.floor(budget / sentenceCost))}${'x'.repeat(budget % sentenceCost)}`;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  it('holds the budget at the exact byte, by what the prompt grows to', () => {
    expect(freshPromptRidesCommandLine({ prompt: longestRiding, agentPath: LINUX_AGENT, shell: BASH, platform: 'linux' })).toBe(true);
    expect(freshPromptRidesCommandLine({ prompt: `${longestRiding}x`, agentPath: LINUX_AGENT, shell: BASH, platform: 'linux' })).toBe(false);
  });

  // A prompt the engine lets ride and the spawn refuses would stop a task that
  // could have been typed in.
  it.each(adapterNames)('never refuses what it let ride on %s', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);
    const command = adapter.buildCommand({ ...freshOptions(LINUX_AGENT, longestRiding), shell: BASH });

    expect(commandFitsShell({ command, shell: BASH, platform: 'linux' })).toBe(true);
  });
});

describe('an imported description past the limit', () => {
  const longerThanAnArgument = '界'.repeat(45_000);

  it.each([
    ['on Linux', '/bin/bash', 'linux'],
    ['in a WSL distro', 'wsl -d Ubuntu', 'win32'],
  ] as const)('does not ride the command line %s, where `exec` would refuse it', (_where, shell, platform) => {
    expect(Buffer.byteLength(longerThanAnArgument, 'utf8')).toBeGreaterThan(LINUX_ARGUMENT_BYTE_LIMIT);
    expect(freshPromptRidesCommandLine({ prompt: longerThanAnArgument, agentPath: '/usr/local/bin/agent', shell, platform })).toBe(false);
  });

  it('rides on macOS, which has no limit per argument', () => {
    expect(freshPromptRidesCommandLine({ prompt: longerThanAnArgument, agentPath: '/usr/local/bin/agent', shell: '/bin/zsh', platform: 'darwin' })).toBe(true);
  });
});

describe('the MCP tools over the limit', () => {
  /** The real tool schemas, off a live registration, so the agent's error is the one it would get. */
  function toolSchemas(): Map<string, ZodType> {
    const schemas = new Map<string, ZodType>();
    const server = {
      registerTool: (toolName: string, toolConfig: { inputSchema: ZodType }) => {
        schemas.set(toolName, toolConfig.inputSchema);
      },
    };
    registerTaskTools(server as never, {} as never, {} as never);
    registerWorkflowTools(server as never, {} as never);
    return schemas;
  }

  it('kangentic_create_task says how far over, so an agent can fix it in one more call', () => {
    const parsed = toolSchemas().get('kangentic_create_task')!.safeParse({ title: 'Too long', description: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 7) });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toContain(`${TASK_DESCRIPTION_MAX_LENGTH} character limit by 7`);
  });

  // The handler holds this one, because a task from before the limit may shrink
  // and still be over it.
  it('kangentic_update_task leaves a long description to its handler', () => {
    const parsed = toolSchemas().get('kangentic_update_task')!.safeParse({ taskId: '42', description: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 7) });

    expect(parsed.success).toBe(true);
  });

  // The workflow tools carry the same description onto a board task, so the same
  // limit holds at their schema, where an agent gets the error before a save.
  describe('kangentic_save_workflow, for a planned task description', () => {
    const plannedTask = (description: string) => ({ key: 'api', title: 'Build the API', description });

    it('refuses a description one character past the limit', () => {
      const parsed = toolSchemas().get('kangentic_save_workflow')!.safeParse({ tasks: [plannedTask('x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 1))] });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].path).toEqual(['tasks', 0, 'description']);
    });

    it('accepts a description exactly at the limit', () => {
      const parsed = toolSchemas().get('kangentic_save_workflow')!.safeParse({ tasks: [plannedTask('x'.repeat(TASK_DESCRIPTION_MAX_LENGTH))] });

      expect(parsed.success).toBe(true);
    });
  });

  describe('kangentic_add_workflow_task', () => {
    const addedTask = (description: string) => ({ workflow: 'Upgrade', title: 'Build the API', description });

    it('refuses a description one character past the limit', () => {
      const parsed = toolSchemas().get('kangentic_add_workflow_task')!.safeParse(addedTask('x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 1)));

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].path).toEqual(['description']);
    });

    it('accepts a description exactly at the limit', () => {
      const parsed = toolSchemas().get('kangentic_add_workflow_task')!.safeParse(addedTask('x'.repeat(TASK_DESCRIPTION_MAX_LENGTH)));

      expect(parsed.success).toBe(true);
    });
  });
});

describe('taskDescriptionOverage', () => {
  const atLimit = 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH);

  it('passes a description at the limit, and counts one past it', () => {
    expect(taskDescriptionOverage(atLimit, null)).toBe(0);
    expect(taskDescriptionOverage(`${atLimit}x`, null)).toBe(1);
  });

  it('lets a longer task from before the limit keep its other edits, but not grow', () => {
    const older = `${atLimit}older text`;

    expect(taskDescriptionOverage(older, older)).toBe(0);
    expect(taskDescriptionOverage(`${atLimit}older`, older)).toBe(0);
    expect(taskDescriptionOverage(`${older}!`, older)).toBe('older text!'.length);
  });
});
