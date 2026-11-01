#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * Does Claude Code run a third-party MCP tool while it plans when a
 * PermissionRequest hook allows the call? It is the evidence behind the plan
 * tool approval hook (`src/main/agent/adapters/claude/plan-tool-approval.ts`,
 * task #870).
 *
 * Plan mode prompts for every tool that is not read-only, and an MCP tool with
 * no `readOnlyHint` is not. An allow rule does not reach past that gate (see
 * `src/main/agent/mcp-http/annotations.ts`). Claude's docs say a PreToolUse
 * hook's allow has no effect there either, and are silent on PermissionRequest.
 *
 * Each run starts Claude against a local stand-in for the Messages API (reached
 * through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so no account is used and
 * nothing is billed), with one stdio MCP server, `probe`, whose one tool,
 * `lookup`, carries no annotations. The stand-in asks for that tool. The same
 * file is the stand-in, the MCP server (`--mcp-server`) and every hook
 * (`--hook`), so a run needs nothing but this script and a Claude binary.
 *
 * Runs:
 *   control   an allow rule for the tool, no approving hook
 *   hook      the allow rule plus a PermissionRequest hook that answers allow
 *   subagent  the hook run, with the call made by a subagent the main agent starts
 *   ask       an ask rule for the tool plus the approving hook
 *
 * Modes:
 *   print        `claude -p`. A prompt it cannot show is denied unless a hook decides.
 *   interactive  Claude's TUI in a node-pty terminal on the classic renderer
 *                (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1, which never arms the boot
 *                canary). Its working folder is a fresh temp folder, so the first
 *                screen is the trust prompt, which the probe accepts.
 *
 * Every hook records its stdin (tool, permission_mode, agent_id) with a
 * timestamp, so a run also shows when the catch-all PermissionRequest entry ran
 * against the approving one, which sizes the activity gate's hold.
 *
 * Usage:
 *   node scripts/probe-claude-plan-tool-approval.js [--claude <path>] [--modes print,interactive]
 *        [--runs control,hook,subagent,ask] [--out <results.jsonl>]
 *
 * On Windows `--claude` must name a `claude.exe`: an npm install's `claude.cmd`
 * shim cannot be started without a shell. Set PROBE_DUMP_DIR to an existing
 * folder to keep every API request the stand-in receives (`request-<n>.json`)
 * and every hook's raw stdin (`hook-<label>-<n>.json`), the source of the
 * sanitized captures under tests/fixtures/plan-exit/.
 *
 * The subagent run turns auto mode off (`permissions.disableAutoMode`). With it
 * on, plan mode sent the subagent's launch to the auto mode classifier, which
 * this stand-in cannot answer, so the launch was denied. The other runs keep
 * auto mode available, as a real session has it; their MCP call never reached
 * the classifier.
 *
 * Measured 2026-10-21 on Claude Code 2.1.306, Windows 11 build 26200, node-pty 1.1.0,
 * control, hook and ask with auto mode both available and off:
 *   control   print: denied, "Cannot call mcp__probe__lookup while in plan mode."
 *             interactive: "Do you want to proceed?" left open, the tool never ran
 *   hook      print and interactive: the tool ran, no one answered anything; the
 *             TUI says "Allowed by PermissionRequest hook"
 *   subagent  print and interactive: the subagent's call ran; its PermissionRequest
 *             carried permission_mode "plan" and the subagent's agent_id
 *   ask       print and interactive: the tool ran. A hook's allow outranks an ask
 *             rule, so a hook that should honor one has to leave the tool alone.
 *   Every PermissionRequest arrived with permission_mode "plan". The approving
 *   hook started 5 to 114 ms after the catch-all one.
 *
 * Measured 2026-10-31 on Claude Code 2.1.316, Windows, print mode, with a
 * built-in tool and no allow rule (`--tool Write --matcher "mcp__.*|Write"`,
 * task #952): control was refused, "Cannot write ... while in plan mode."; hook
 * ran the call, 29 ms after the catch-all PermissionRequest. `--tool Artifact`
 * cannot be measured here: the tool needs a claude.ai account, so the stand-in
 * never lists it.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const RUNS = ['control', 'hook', 'subagent', 'ask'];
const MODES = ['print', 'interactive'];
/**
 * The tool the stand-in asks for. The probe's own MCP `lookup` by default;
 * `--tool <name> --input <json> --matcher <regex>` asks for a built-in one
 * instead (task #952: Artifact reads and publishes, or Write as a built-in plan
 * mode always prompts for). A built-in call ran when its PostToolUse or
 * PostToolUseFailure hook fired: a failure after the prompt was answered (an
 * Artifact call with no claude.ai account behind it) still got past plan mode.
 */
const TOOL_NAME = argument('tool', 'mcp__probe__lookup');
const TOOL_INPUT = JSON.parse(argument('input', '{"query":"probe"}'));
const APPROVER_MATCHER = argument('matcher', 'mcp__.*');
const IS_MCP_TOOL = TOOL_NAME.startsWith('mcp__');
const PROBE_PATH = path.resolve(__filename).replace(/\\/g, '/');
const PRINT_TIMEOUT_MS = 120000;
const INTERACTIVE_TIMEOUT_MS = 60000;
// After a permission prompt opens, how long the run waits for a hook's answer
// to take the call through before it counts the dialog as left open.
const DIALOG_SETTLE_MS = 4000;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// --hook <log> <label> [allow]: records the hook's stdin; `allow` also answers.
// ---------------------------------------------------------------------------

function runHook() {
  const index = process.argv.indexOf('--hook');
  const [logPath, label, answer] = process.argv.slice(index + 1);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      payload = {};
    }
    if (process.env.PROBE_DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.PROBE_DUMP_DIR, `hook-${label}-${Date.now()}-${process.pid}.json`), input);
    }
    appendJsonLine(logPath, {
      at: Date.now(),
      label,
      tool: payload.tool_name ?? null,
      permissionMode: payload.permission_mode ?? null,
      agentId: payload.agent_id ?? null,
      agentType: payload.agent_type ?? null,
      notificationType: payload.notification_type ?? null,
      message: typeof payload.message === 'string' ? payload.message.slice(0, 160) : null,
      suggestions: Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions.length : null,
    });
    if (answer === 'allow') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// --mcp-server <calls>: one tool, `lookup`, with no annotations.
// ---------------------------------------------------------------------------

function runMcpServer() {
  const callsPath = process.argv[process.argv.indexOf('--mcp-server') + 1];
  let buffer = '';
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.id === undefined) continue;
      if (request.method === 'initialize') {
        send({ jsonrpc: '2.0', id: request.id, result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '1.0.0' },
        } });
      } else if (request.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: request.id, result: { tools: [{
          name: 'lookup',
          description: 'Look up a word in the probe dictionary.',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }] } });
      } else if (request.method === 'tools/call') {
        appendJsonLine(callsPath, { at: Date.now(), arguments: request.params?.arguments ?? null });
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'LOOKUP-RESULT' }] } });
      } else {
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The Messages API stand-in.
// ---------------------------------------------------------------------------

/**
 * Answers by the conversation it is sent:
 * - "PROBE-MAIN" or "PROBE-SUB-CALL" (a subagent's own prompt): load the tool
 *   through ToolSearch when it is deferred, call it, then "Done." once its
 *   result comes back, recording the result.
 * - "PROBE-SUBAGENT": start a subagent whose prompt is "PROBE-SUB-CALL".
 * - anything else (titles, background calls): "OK".
 */
class FakeAnthropicApi {
  constructor() {
    this.lookupResults = [];
    this.requests = [];
    this.toolNamesSeen = new Set();
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    this.server.close();
  }

  reset() {
    this.lookupResults = [];
    this.requests = [];
  }

  handle(request, response) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const route = (request.url ?? '').split('?')[0];
      if (request.method !== 'POST') return this.json(response, {});
      if (route.endsWith('/count_tokens')) return this.json(response, { input_tokens: 10 });
      if (!route.endsWith('/v1/messages')) return this.json(response, {});
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }
      if (process.env.PROBE_DUMP_DIR) {
        fs.writeFileSync(path.join(process.env.PROBE_DUMP_DIR, `request-${this.requests.length}.json`), JSON.stringify(payload, null, 2));
      }
      const parts = this.decide(payload);
      this.requests.push({ at: Date.now(), parts: parts.map((part) => part.kind === 'tool' ? part.name : 'text') });
      this.respond(response, payload, parts);
    });
  }

  decide(payload) {
    const toolNames = (payload.tools ?? []).map((tool) => tool.name);
    for (const name of toolNames) this.toolNamesSeen.add(name);
    const messages = payload.messages ?? [];
    const userText = messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => typeof message.content === 'string'
        ? [message.content]
        : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text))
      .join('\n');
    // Claude can follow a tool result with a user message of its own (a context
    // note), so the results are every user block after the last assistant turn.
    const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant');
    const results = messages.slice(lastAssistant + 1)
      .filter((message) => message.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
    const lastResult = results[results.length - 1];
    const resultText = (block) => typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((entry) => entry.text ?? '').join('');

    // The spawner first: once its subagent reports back, the main conversation
    // can carry the subagent's prompt too.
    const scenario = userText.includes('PROBE-SUBAGENT') ? 'spawner'
      : userText.includes('PROBE-SUB-CALL') ? 'sub'
        : userText.includes('PROBE-MAIN') ? 'main' : null;
    if (!scenario) return [{ kind: 'text', text: 'OK' }];

    if (scenario === 'spawner') {
      const agentStarted = messages.some((message) => message.role === 'assistant' && Array.isArray(message.content)
        && message.content.some((block) => block.type === 'tool_use' && String(block.id).includes('_agent_')));
      if (agentStarted) return [{ kind: 'text', text: 'Done.' }];
      const agentTool = toolNames.find((name) => name === 'Agent' || name === 'Task');
      if (!agentTool) return [{ kind: 'text', text: 'NO-AGENT-TOOL' }];
      return [{ kind: 'tool', name: agentTool, id: `toolu_probe_agent_${Date.now()}`, input: {
        description: 'Probe lookup',
        prompt: 'PROBE-SUB-CALL: call the lookup tool once.',
        subagent_type: 'general-purpose',
      } }];
    }

    if (lastResult && lastResult.tool_use_id.includes('_lookup_')) {
      this.lookupResults.push({ at: Date.now(), scenario, isError: lastResult.is_error === true, text: resultText(lastResult).slice(0, 300) });
      return [{ kind: 'text', text: 'Done.' }];
    }
    if (toolNames.includes(TOOL_NAME)) {
      return [{ kind: 'tool', name: TOOL_NAME, id: `toolu_probe_lookup_${scenario}_${Date.now()}`, input: TOOL_INPUT }];
    }
    if (toolNames.includes('ToolSearch') && !(lastResult && lastResult.tool_use_id.includes('_search_'))) {
      return [{ kind: 'tool', name: 'ToolSearch', id: `toolu_probe_search_${scenario}_${Date.now()}`, input: { query: `select:${TOOL_NAME}`, max_results: 1 } }];
    }
    return [{ kind: 'text', text: 'NO-LOOKUP-TOOL' }];
  }

  json(response, value) {
    const data = JSON.stringify(value);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    response.end(data);
  }

  respond(response, payload, parts) {
    const model = payload.model ?? 'claude-haiku';
    const stopReason = parts.some((part) => part.kind === 'tool') ? 'tool_use' : 'end_turn';
    const message = {
      id: `msg_probe_${Date.now()}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    };
    if (!payload.stream) {
      message.content = parts.map((part) => part.kind === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'tool_use', id: part.id, name: part.name, input: part.input });
      message.stop_reason = stopReason;
      return this.json(response, message);
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (name, data) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', { type: 'message_start', message });
    parts.forEach((part, index) => {
      if (part.kind === 'text') {
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } });
      } else {
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: part.id, name: part.name, input: {} } });
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input) } });
      }
      event('content_block_stop', { type: 'content_block_stop', index });
    });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', { type: 'message_stop' });
    response.end();
  }
}

// ---------------------------------------------------------------------------
// One run.
// ---------------------------------------------------------------------------

function hookCommand(logPath, label, answer) {
  const quote = (value) => `"${value.replace(/\\/g, '/')}"`;
  return ['node', quote(PROBE_PATH), '--hook', quote(logPath), label, ...(answer ? [answer] : [])].join(' ');
}

function writeRunFiles(runDir, run) {
  const hookLog = path.join(runDir, 'hooks.jsonl');
  const callsPath = path.join(runDir, 'calls.jsonl');
  const recorder = (label) => [{ matcher: '', hooks: [{ type: 'command', command: hookCommand(hookLog, label) }] }];
  const approves = run !== 'control';
  const settings = {
    permissions: {
      allow: [TOOL_NAME],
      ...(run === 'ask' ? { ask: [TOOL_NAME] } : {}),
      // With auto mode available, plan mode sends a subagent's launch to the
      // auto mode classifier, which this stand-in cannot answer, so the launch
      // was denied. The MCP call itself never reached the classifier, so the
      // other runs keep auto mode available, as a real session has it.
      ...(run === 'subagent' ? { disableAutoMode: 'disable' } : {}),
    },
    hooks: {
      PreToolUse: recorder('pre-tool'),
      PostToolUse: recorder('post-tool'),
      PostToolUseFailure: recorder('post-tool-failure'),
      PermissionDenied: recorder('permission-denied'),
      Notification: recorder('notification'),
      Stop: recorder('stop'),
      PermissionRequest: [
        ...recorder('permission'),
        ...(approves ? [{ matcher: APPROVER_MATCHER, hooks: [{ type: 'command', command: hookCommand(hookLog, 'approver', 'allow') }] }] : []),
      ],
    },
  };
  // A built-in call needs no allow rule: the hook's answer is the consent.
  if (!IS_MCP_TOOL) settings.permissions.allow = [];
  const settingsPath = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const mcpConfigPath = path.join(runDir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { probe: {
    type: 'stdio', command: process.execPath, args: [PROBE_PATH, '--mcp-server', callsPath],
  } } }, null, 2));
  return { hookLog, callsPath, settingsPath, mcpConfigPath };
}

/** Whether the probed call ran: the MCP server saw it, or a built-in's own post-tool hook fired. */
function probedToolRan(files) {
  if (readJsonLines(files.callsPath).length > 0) return true;
  return readJsonLines(files.hookLog).some((line) => (line.label === 'post-tool' || line.label === 'post-tool-failure') && line.tool === TOOL_NAME);
}

function runEnvironment(port) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^CLAUDE_?CODE/i.test(key) || key.startsWith('ANTHROPIC_')) continue;
    environment[key] = value;
  }
  environment.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  environment.ANTHROPIC_AUTH_TOKEN = 'probe-placeholder';
  environment.DISABLE_AUTOUPDATER = '1';
  environment.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  return environment;
}

function claudeArguments(files) {
  return [
    '--permission-mode', 'plan',
    '--settings', files.settingsPath,
    '--setting-sources', 'project,local',
    '--mcp-config', files.mcpConfigPath,
    '--strict-mcp-config',
    '--model', 'haiku',
  ];
}

function promptFor(run) {
  return run === 'subagent'
    ? 'PROBE-SUBAGENT: start one subagent to call the lookup tool.'
    : 'PROBE-MAIN: call the lookup tool once.';
}

function stripEscapes(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b./g, ' ');
}

// Asynchronous on purpose: the API stand-in answers from this same event loop,
// which a spawnSync would block.
function runPrint(claude, files, environment, runDir, prompt) {
  return new Promise((resolve) => {
    const child = spawn(claude, ['-p', prompt, ...claudeArguments(files)], { cwd: runDir, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // Closed at once: with stdin open and empty, `-p` waits for piped text.
    child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // On Windows a kill ends Claude alone, and the MCP server and hooks it
      // started would keep the run's folder locked.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill();
    }, PRINT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        stdoutTail: stdout.trim().slice(-300),
        stderrTail: stderr.trim().slice(-300),
      });
    });
  });
}

async function runInteractive(claude, files, environment, runDir, prompt) {
  const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
  const pty = require(nodePtyDir);
  const terminal = pty.spawn(claude, [...claudeArguments(files), '--', prompt], {
    name: 'xterm-256color', cols: 140, rows: 40, cwd: runDir, env: environment,
  });
  let output = '';
  let exited = false;
  terminal.onData((data) => { output += data; });
  terminal.onExit(() => { exited = true; });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const screen = () => stripEscapes(output).replace(/\s+/g, ' ');
  let trustAnswered = false;
  let dialogFirstSeenAt = null;
  const deadline = Date.now() + INTERACTIVE_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    await sleep(200);
    const text = screen();
    // The trust prompt's cursor starts on "No, exit" (2.1.306): move to "Yes".
    if (!trustAnswered && /trust this folder/i.test(text) && /Enter to confirm/i.test(text)) {
      trustAnswered = true;
      await sleep(500);
      terminal.write('\x1b[B');
      await sleep(400);
      terminal.write('\r');
      continue;
    }
    if (probedToolRan(files) && /Done\./.test(text)) break;
    const dialogOpen = /Do you want to proceed/i.test(text.slice(-1500));
    if (dialogOpen && dialogFirstSeenAt === null) dialogFirstSeenAt = Date.now();
    if (dialogFirstSeenAt !== null && Date.now() - dialogFirstSeenAt > DIALOG_SETTLE_MS) break;
  }
  const finalScreen = screen();
  // The console close is Claude's graceful exit on Windows
  // (.claude/rules/pty-teardown-grace.md); a POSIX kill is a hangup.
  terminal.kill();
  await sleep(1500);
  // The classic renderer appends every frame, so this says the dialog was drawn
  // at some point, not that it stayed open: a hook's answer can land after the
  // first frame. `toolRan` says whether the call went through.
  return {
    exitCode: null,
    timedOut: Date.now() >= deadline,
    trustAnswered,
    dialogDrawn: dialogFirstSeenAt !== null,
    answeredByHook: /by PermissionRequest hook/i.test(finalScreen),
    screenTail: finalScreen.slice(-600),
  };
}

async function runOne(claude, api, port, mode, run, version) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-plan-tool-probe-${run}-`));
  const files = writeRunFiles(runDir, run);
  api.reset();
  const startedAt = Date.now();
  const outcome = mode === 'print'
    ? await runPrint(claude, files, runEnvironment(port), runDir, promptFor(run))
    : await runInteractive(claude, files, runEnvironment(port), runDir, promptFor(run));
  const hooks = readJsonLines(files.hookLog);
  const calls = readJsonLines(files.callsPath);
  const permissionLines = hooks.filter((line) => line.label === 'permission' && line.tool === TOOL_NAME);
  const approverLines = hooks.filter((line) => line.label === 'approver');
  const firstPermission = permissionLines[0];
  const firstApprover = approverLines[0];
  const record = {
    at: new Date(startedAt).toISOString(),
    platform: process.platform,
    version,
    mode,
    run,
    tool: TOOL_NAME,
    toolRan: probedToolRan(files),
    toolCalls: calls.length,
    lookupResults: api.lookupResults,
    permissionRequests: permissionLines.map((line) => ({ permissionMode: line.permissionMode, agentId: line.agentId, agentType: line.agentType })),
    approverRuns: approverLines.length,
    approverMinusCatchAllMs: firstPermission && firstApprover ? firstApprover.at - firstPermission.at : null,
    preToolModes: hooks.filter((line) => line.label === 'pre-tool' && line.tool === TOOL_NAME).map((line) => line.permissionMode),
    denied: hooks.filter((line) => line.label === 'permission-denied').map((line) => line.tool),
    failures: hooks.filter((line) => line.label === 'post-tool-failure').map((line) => line.tool),
    notifications: hooks.filter((line) => line.label === 'notification').map((line) => line.notificationType ?? line.message),
    deferredTool: !api.toolNamesSeen.has(TOOL_NAME) ? 'never listed' : undefined,
    apiRequests: api.requests.map((request) => request.parts.join('+')),
    ...outcome,
  };
  // Best effort: on Windows the MCP server can still hold the folder for a moment.
  try {
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    record.cleanup = `left ${runDir}: ${error.code}`;
  }
  return record;
}

/**
 * An absolute path for a bare command name: node-pty does not search PATH. On
 * Windows only an `.exe` will do, since neither `spawn` without a shell nor
 * node-pty can start an npm shim (`claude.cmd`, or its extensionless sibling).
 */
function resolveExecutable(command) {
  if (path.isAbsolute(command)) return command;
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' });
  const found = (lookup.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== 'win32') return found[0] ?? command;
  const executable = found.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  if (!executable) {
    throw new Error(`no ${command}.exe on PATH (found ${found.join(', ') || 'nothing'}); pass --claude <path to claude.exe>`);
  }
  return executable;
}

async function main() {
  const claude = resolveExecutable(argument('claude', 'claude'));
  const modes = argument('modes', 'print').split(',');
  const runs = argument('runs', RUNS.join(',')).split(',');
  const outPath = argument('out');
  for (const mode of modes) if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  for (const run of runs) if (!RUNS.includes(run)) throw new Error(`unknown run ${run}`);
  const versionResult = spawnSync(claude, ['--version'], { encoding: 'utf8', env: runEnvironment(1) });
  const version = (versionResult.stdout ?? '').trim().split(' ')[0];
  const api = new FakeAnthropicApi();
  const port = await api.listen();
  try {
    for (const mode of modes) {
      for (const run of runs) {
        const record = await runOne(claude, api, port, mode, run, version);
        const line = JSON.stringify(record);
        console.log(line);
        if (outPath) fs.appendFileSync(outPath, line + '\n');
      }
    }
  } finally {
    api.close();
  }
}

if (process.argv.includes('--hook')) {
  runHook();
} else if (process.argv.includes('--mcp-server')) {
  runMcpServer();
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
