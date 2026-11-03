#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * What does Claude Code do with a third-party browser MCP tool that a
 * PreToolUse hook denies? It is the evidence behind the browser policy hook
 * (`src/main/agent/browser-policy-bridge.js`, task #977).
 *
 * Three questions:
 * 1. Which hooks fire after the deny. Kangentic's event bridge has already
 *    written a `tool_start` from its own PreToolUse entry by then; if nothing
 *    closes it, the task reads as thinking until the activity watchdog.
 * 2. Whether the deny holds in every permission mode, `bypassPermissions`
 *    included (the docs say deny RULES do, and are silent on a hook's deny).
 * 3. Whether the deny reason reaches the model as the tool result.
 *
 * Each run starts Claude against a local stand-in for the Messages API (reached
 * through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so no account is used and
 * nothing is billed), with one stdio MCP server named `playwright` whose one
 * tool is `browser_navigate`. The stand-in asks for that tool. The same file is
 * the stand-in, the MCP server (`--mcp-server`) and every hook (`--hook`).
 *
 * Runs:
 *   main      the main agent calls the tool
 *   subagent  a subagent the main agent starts calls it
 *
 * Usage:
 *   node scripts/probe-claude-browser-deny.js [--claude <path>] [--mode print|interactive]
 *        [--permission-modes default,acceptEdits,plan,bypassPermissions]
 *        [--runs main,subagent] [--no-deny] [--out <results.jsonl>]
 *
 * `--no-deny` registers the recorder hooks only: the control, where the tool runs.
 * `--append-file` passes `--append-system-prompt-file` with a marker, and
 * `--append-inline` passes `--append-system-prompt` with it; the record says
 * which requests' system prompts carried it (main, spawner, sub).
 * `--no-chrome-flag` passes `--no-chrome`, to check Claude accepts it.
 * `--kangentic-bridge --kangentic-spec <file> [--kangentic-matcher <regex>]
 * [--agent-browser on|off]` runs the shipped `browser-policy-bridge.js` with a
 * spec built by `claudeBrowserPolicySpec` instead of the probe's own deny.
 * On Windows `--claude` must name a `claude.exe`. Set PROBE_DUMP_DIR to an
 * existing folder to keep every API request and every hook's raw stdin.
 *
 * Measured 2026-11-03 on Claude Code 2.1.317, Windows 11 build 26200, print mode:
 * - The deny held in default, acceptEdits, plan and bypassPermissions, for the
 *   main agent and for a subagent. The tool never ran.
 * - The model got the reason as an error tool result:
 *   "PreToolUse:mcp__playwright__browser_navigate hook error: <reason>".
 * - No PostToolUse or PostToolUseFailure fired for the denied call. The hook
 *   sequence was PreToolUse, the deny, then Stop (a subagent's: its own
 *   SubagentStop). So the event bridge's `tool_start` stays open until the
 *   turn's Stop, where the activity engine clears it.
 * - `--append-system-prompt-file` and `--append-system-prompt` text each
 *   reached the main agent's requests and not the subagent's. `--no-chrome`
 *   was accepted. An unknown option ends Claude before the run ("error:
 *   unknown option"), and the file form is missing from `claude --help`, so
 *   Kangentic passes the inline form.
 * - With `--kangentic-bridge` (the shipped bridge and spec, the matcher
 *   `browserPolicyMatcher` builds): denied in default and bypassPermissions,
 *   main agent and subagent, with "Kangentic blocked <tool>: ... Call
 *   kangentic_browser_open_pane" as the result. With `--agent-browser off` the
 *   same hook let the call run ("NAVIGATED").
 * - `--mode interactive` (the TUI in node-pty, classic renderer), default and
 *   bypassPermissions, main agent and subagent, with `--append-inline` and
 *   `--no-chrome-flag`: the same deny and reason, and the appended text in the
 *   main agent's requests and not the subagent's.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const RUNS = ['main', 'subagent'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const TOOL_NAME = 'mcp__playwright__browser_navigate';
const DENY_REASON = 'PROBE-DENY-REASON: use kangentic_browser_open_pane instead.';
/** Written to the file `--append-system-prompt-file` names, then looked for in each request's system prompt. */
const APPENDED_MARKER = 'PROBE-APPENDED-POLICY';
const PROBE_PATH = path.resolve(__filename).replace(/\\/g, '/');
const PRINT_TIMEOUT_MS = 120000;

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

// --hook <log> <label> [deny]: records the hook's stdin; `deny` also answers.
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
      event: payload.hook_event_name ?? null,
      tool: payload.tool_name ?? null,
      toolUseId: payload.tool_use_id ?? null,
      permissionMode: payload.permission_mode ?? null,
      agentId: payload.agent_id ?? null,
      error: typeof payload.error === 'string' ? payload.error.slice(0, 200) : null,
      isInterrupt: payload.is_interrupt ?? null,
    });
    if (answer === 'deny') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
      }));
    }
  });
}

// --mcp-server <calls>: one tool, `browser_navigate`.
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
          serverInfo: { name: 'playwright', version: '1.0.0' },
        } });
      } else if (request.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: request.id, result: { tools: [{
          name: 'browser_navigate',
          description: 'Navigate to a URL.',
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          annotations: { readOnlyHint: true },
        }] } });
      } else if (request.method === 'tools/call') {
        appendJsonLine(callsPath, { at: Date.now(), arguments: request.params?.arguments ?? null });
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'NAVIGATED' }] } });
      } else {
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      }
    }
  });
}

/**
 * Answers by the conversation it is sent:
 * - "PROBE-MAIN" or "PROBE-SUB-CALL": load the tool through ToolSearch when it
 *   is deferred, call it, then "Done." once its result comes back, recording it.
 * - "PROBE-SUBAGENT": start a subagent whose prompt is "PROBE-SUB-CALL".
 * - anything else: "OK".
 */
class FakeAnthropicApi {
  constructor() {
    this.toolResults = [];
    this.requests = [];
    this.systemMentionsChrome = false;
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
    this.toolResults = [];
    this.requests = [];
    this.systemMentionsChrome = false;
    this.toolNamesSeen = new Set();
    this.lastScenario = null;
    this.appendedPromptSeen = {};
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
      const systemText = JSON.stringify(payload.system ?? '');
      if (/claude-in-chrome/i.test(systemText)) this.systemMentionsChrome = true;
      const parts = this.decide(payload);
      if (this.lastScenario) {
        const seen = this.appendedPromptSeen[this.lastScenario] ?? false;
        this.appendedPromptSeen[this.lastScenario] = seen || systemText.includes(APPENDED_MARKER);
      }
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
    const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant');
    const results = messages.slice(lastAssistant + 1)
      .filter((message) => message.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
    const lastResult = results[results.length - 1];
    const resultText = (block) => typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((entry) => entry.text ?? '').join('');

    const scenario = userText.includes('PROBE-SUBAGENT') ? 'spawner'
      : userText.includes('PROBE-SUB-CALL') ? 'sub'
        : userText.includes('PROBE-MAIN') ? 'main' : null;
    this.lastScenario = scenario;
    if (!scenario) return [{ kind: 'text', text: 'OK' }];

    if (scenario === 'spawner') {
      const agentStarted = messages.some((message) => message.role === 'assistant' && Array.isArray(message.content)
        && message.content.some((block) => block.type === 'tool_use' && String(block.id).includes('_agent_')));
      if (agentStarted) return [{ kind: 'text', text: 'Done.' }];
      const agentTool = toolNames.find((name) => name === 'Agent' || name === 'Task');
      if (!agentTool) return [{ kind: 'text', text: 'NO-AGENT-TOOL' }];
      return [{ kind: 'tool', name: agentTool, id: `toolu_probe_agent_${Date.now()}`, input: {
        description: 'Probe navigate',
        prompt: 'PROBE-SUB-CALL: call the navigate tool once.',
        subagent_type: 'general-purpose',
      } }];
    }

    if (lastResult && lastResult.tool_use_id.includes('_navigate_')) {
      this.toolResults.push({ at: Date.now(), scenario, isError: lastResult.is_error === true, text: resultText(lastResult).slice(0, 300) });
      return [{ kind: 'text', text: 'Done.' }];
    }
    if (toolNames.includes(TOOL_NAME)) {
      return [{ kind: 'tool', name: TOOL_NAME, id: `toolu_probe_navigate_${scenario}_${Date.now()}`, input: { url: 'https://example.com' } }];
    }
    if (toolNames.includes('ToolSearch') && !(lastResult && lastResult.tool_use_id.includes('_search_'))) {
      return [{ kind: 'tool', name: 'ToolSearch', id: `toolu_probe_search_${scenario}_${Date.now()}`, input: { query: `select:${TOOL_NAME}`, max_results: 1 } }];
    }
    return [{ kind: 'text', text: 'NO-NAVIGATE-TOOL' }];
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

function hookCommand(logPath, label, answer) {
  const quote = (value) => `"${value.replace(/\\/g, '/')}"`;
  return ['node', quote(PROBE_PATH), '--hook', quote(logPath), label, ...(answer ? [answer] : [])].join(' ');
}

/**
 * `--kangentic-bridge`: the shipped bridge and its spec in place of the probe's
 * own deny hook, the way the Claude adapter registers it. The spec is the one
 * `claudeBrowserPolicySpec` builds, read back from a spec file the caller
 * writes (`--kangentic-spec <file>`), with its config path pointed at the run's
 * own config file, which `--agent-browser off` writes with the switch off.
 */
function kangenticDenier(runDir) {
  const specPath = argument('kangentic-spec');
  if (!specPath) throw new Error('--kangentic-bridge needs --kangentic-spec <file holding the spec JSON>');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  spec.configPath = path.join(runDir, 'config.json');
  fs.writeFileSync(spec.configPath, JSON.stringify({ browserAutomation: { enabled: argument('agent-browser', 'on') !== 'off' } }));
  const bridge = path.resolve(__dirname, '..', 'src', 'main', 'agent', 'browser-policy-bridge.js').replace(/\\/g, '/');
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return { matcher: argument('kangentic-matcher', 'mcp__.*playwright.*'), command: `node "${bridge}" ${encoded}` };
}

function writeRunFiles(runDir, deny) {
  const hookLog = path.join(runDir, 'hooks.jsonl');
  const callsPath = path.join(runDir, 'calls.jsonl');
  const recorder = (label) => [{ matcher: '', hooks: [{ type: 'command', command: hookCommand(hookLog, label) }] }];
  const denier = process.argv.includes('--kangentic-bridge')
    ? kangenticDenier(runDir)
    : { matcher: 'mcp__playwright__.*', command: hookCommand(hookLog, 'denier', 'deny') };
  const settings = {
    permissions: { allow: [TOOL_NAME], disableAutoMode: 'disable' },
    hooks: {
      PreToolUse: [
        ...recorder('pre-tool'),
        ...(deny ? [{ matcher: denier.matcher, hooks: [{ type: 'command', command: denier.command }] }] : []),
      ],
      PostToolUse: recorder('post-tool'),
      PostToolUseFailure: recorder('post-tool-failure'),
      PermissionDenied: recorder('permission-denied'),
      PermissionRequest: recorder('permission'),
      Stop: recorder('stop'),
      SubagentStop: recorder('subagent-stop'),
    },
  };
  const settingsPath = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const mcpConfigPath = path.join(runDir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { playwright: {
    type: 'stdio', command: process.execPath, args: [PROBE_PATH, '--mcp-server', callsPath],
  } } }, null, 2));
  const appendedPromptPath = path.join(runDir, 'appended.md');
  fs.writeFileSync(appendedPromptPath, `${APPENDED_MARKER}: the Agent Browser is the only browser.\n`);
  return { hookLog, callsPath, settingsPath, mcpConfigPath, appendedPromptPath };
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
  return environment;
}

function claudeArguments(files, permissionMode) {
  return [
    '--permission-mode', permissionMode,
    '--settings', files.settingsPath,
    '--setting-sources', 'project,local',
    '--mcp-config', files.mcpConfigPath,
    '--strict-mcp-config',
    '--model', 'haiku',
    ...(process.argv.includes('--append-file') ? ['--append-system-prompt-file', files.appendedPromptPath] : []),
    ...(process.argv.includes('--append-inline') ? ['--append-system-prompt', `${APPENDED_MARKER}: the Agent Browser is the only browser.`] : []),
    ...(process.argv.includes('--no-chrome-flag') ? ['--no-chrome'] : []),
  ];
}

function stripEscapes(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b./g, ' ');
}

/**
 * Claude's TUI in a node-pty terminal on the classic renderer
 * (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1, which never arms the boot canary).
 * The run folder is fresh, so the first screen is the trust prompt, which the
 * probe accepts. Done once the stand-in has answered the tool result ("Done.").
 */
async function runInteractive(claude, files, environment, runDir, prompt, permissionMode, api) {
  const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
  const pty = require(nodePtyDir);
  const terminal = pty.spawn(claude, [...claudeArguments(files, permissionMode), '--', prompt], {
    name: 'xterm-256color', cols: 140, rows: 40, cwd: runDir,
    env: { ...environment, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
  });
  let output = '';
  let exited = false;
  terminal.onData((data) => { output += data; });
  terminal.onExit(() => { exited = true; });
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const screen = () => stripEscapes(output).replace(/\s+/g, ' ');
  let trustAnswered = false;
  let bypassAccepted = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !exited) {
    await sleep(200);
    const text = screen();
    // bypassPermissions first asks to accept the mode; the cursor starts on "No, exit".
    if (!bypassAccepted && /Yes, I accept/i.test(text) && /Enter to confirm/i.test(text.slice(-300))) {
      bypassAccepted = true;
      await sleep(500);
      terminal.write('\x1b[B');
      await sleep(400);
      terminal.write('\r');
      continue;
    }
    // The trust prompt's cursor starts on "No, exit": move to "Yes".
    if (!trustAnswered && /trust this folder/i.test(text) && /Enter to confirm/i.test(text)) {
      trustAnswered = true;
      await sleep(500);
      terminal.write('\x1b[B');
      await sleep(400);
      terminal.write('\r');
      continue;
    }
    // Every run makes one navigate call, by the main agent or its subagent.
    if (api.toolResults.length >= 1 && /Done\./.test(text)) break;
  }
  // The console close is Claude's graceful exit on Windows and the hangup on
  // POSIX (.claude/rules/pty-teardown-grace.md).
  terminal.kill();
  await sleep(1500);
  return { exitCode: null, timedOut: Date.now() >= deadline, trustAnswered, screenTail: screen().slice(-300) };
}

function runPrint(claude, files, environment, runDir, prompt, permissionMode) {
  return new Promise((resolve) => {
    const child = spawn(claude, ['-p', prompt, ...claudeArguments(files, permissionMode)], { cwd: runDir, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill();
    }, PRINT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdoutTail: stdout.trim().slice(-300), stderrTail: stderr.trim().slice(-300) });
    });
  });
}

async function runOne(claude, api, port, permissionMode, run, deny, version) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-browser-deny-probe-${run}-`));
  const files = writeRunFiles(runDir, deny);
  api.reset();
  const prompt = run === 'subagent'
    ? 'PROBE-SUBAGENT: start one subagent to call the navigate tool.'
    : 'PROBE-MAIN: call the navigate tool once.';
  const startedAt = Date.now();
  const interactive = argument('mode', 'print') === 'interactive';
  const outcome = interactive
    ? await runInteractive(claude, files, runEnvironment(port), runDir, prompt, permissionMode, api)
    : await runPrint(claude, files, runEnvironment(port), runDir, prompt, permissionMode);
  const hooks = readJsonLines(files.hookLog).filter((line) => line.tool === TOOL_NAME || line.tool === null);
  const record = {
    at: new Date(startedAt).toISOString(),
    platform: process.platform,
    version,
    mode: interactive ? 'interactive' : 'print',
    permissionMode,
    run,
    deny,
    toolRan: readJsonLines(files.callsPath).length > 0,
    toolResults: api.toolResults,
    reasonReachedModel: api.toolResults.some((result) => result.text.includes('PROBE-DENY-REASON') || result.text.includes('kangentic_browser_open_pane')),
    hookSequence: hooks.map((line) => `${line.label}${line.agentId ? '(sub)' : ''}${line.toolUseId ? `:${line.toolUseId.slice(-6)}` : ''}`),
    failureErrors: hooks.filter((line) => line.label === 'post-tool-failure').map((line) => line.error),
    appendedPromptSeen: api.appendedPromptSeen,
    systemMentionsChrome: api.systemMentionsChrome,
    chromeToolsListed: [...api.toolNamesSeen].filter((name) => name.startsWith('mcp__claude-in-chrome__')).length,
    apiRequests: api.requests.map((request) => request.parts.join('+')),
    ...outcome,
  };
  try {
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    record.cleanup = `left ${runDir}: ${error.code}`;
  }
  return record;
}

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
  const permissionModes = argument('permission-modes', PERMISSION_MODES.join(',')).split(',');
  const runs = argument('runs', RUNS.join(',')).split(',');
  const deny = !process.argv.includes('--no-deny');
  const outPath = argument('out');
  for (const run of runs) if (!RUNS.includes(run)) throw new Error(`unknown run ${run}`);
  const versionResult = spawnSync(claude, ['--version'], { encoding: 'utf8', env: runEnvironment(1) });
  const version = (versionResult.stdout ?? '').trim().split(' ')[0];
  const api = new FakeAnthropicApi();
  const port = await api.listen();
  try {
    for (const permissionMode of permissionModes) {
      for (const run of runs) {
        const record = await runOne(claude, api, port, permissionMode, run, deny, version);
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
