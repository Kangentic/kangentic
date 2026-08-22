// Shared plumbing for the browser-contention rig: the preview devtools bridge,
// the product MCP server, and the test page server.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

/** Derived, never hardcoded: this file ships, and the repo is public. */
export const WORKTREE = path.resolve(fileURLToPath(import.meta.url), '../../../..');

// ── preview devtools bridge (plain HTTP: /eval, /command) ──────────────────

function lockfile() {
  const raw = fs.readFileSync(path.join(WORKTREE, '.kangentic', 'preview.lock'), 'utf8');
  return JSON.parse(raw);
}

async function bridge(routePath, body) {
  const { port } = lockfile();
  const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`bridge ${routePath} ${response.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Evaluate an expression in the preview's renderer. */
export async function evalInPreview(expression) {
  const result = await bridge('/eval', { expression });
  if (result && result.kind) throw new Error(`eval failed: ${JSON.stringify(result)}`);
  return result?.value !== undefined ? result.value : result;
}

/** Run a product MCP command handler inside the preview. */
export async function runCommand(command, params, projectId) {
  const result = await bridge('/command', { command, params, projectId });
  if (result && result.success === false) {
    throw new Error(`command ${command} failed: ${result.error}`);
  }
  return result;
}

// ── product MCP server, dialled the way a spawned agent dials it ───────────

/**
 * A JSON-RPC client for one caller identity.
 *
 * The whole point of the task-#8 reproduction is that concurrent subagents are
 * INDISTINGUISHABLE at this layer: they inherit the parent's mcp.json verbatim,
 * so every one of them presents the same `/mcp/<projectId>/<sessionId>` path.
 * The rig therefore builds N clients on ONE session id by default.
 */
export class McpClient {
  constructor({ url, token, label }) {
    this.url = url;
    this.token = token;
    this.label = label;
    this.nextId = 1;
  }

  async call(name, args) {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Kangentic-Token': this.token,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`mcp ${name} ${response.status}: ${text.slice(0, 500)}`);
    return parseJsonRpc(text, name);
  }
}

/** The transport answers as JSON or as a single SSE frame; accept both. */
function parseJsonRpc(text, name) {
  let payload = text.trim();
  if (payload.startsWith('event:') || payload.startsWith('data:')) {
    const dataLine = payload.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) throw new Error(`mcp ${name}: SSE frame with no data line`);
    payload = dataLine.slice('data:'.length).trim();
  }
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(`mcp ${name} error: ${JSON.stringify(parsed.error)}`);
  const content = parsed.result?.content ?? [];
  const textPart = content.find((part) => part.type === 'text')?.text ?? '';
  return { raw: parsed, text: textPart, isError: Boolean(parsed.result?.isError) };
}

// ── the page the panes drive ───────────────────────────────────────────────

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>contention rig</title></head>
<body style="font-family:system-ui;background:#111;color:#eee;padding:24px">
  <h1 id="who">lane: <span id="lane">unset</span></h1>
  <!-- Scenario A writes here. Concurrent drivers each type a distinct run of
       one repeated character; the assertion is that each run stays CONTIGUOUS.
       Interleaving shreds them, which is exactly what the per-guest FIFO
       prevents and what nothing prevented before it. -->
  <input id="shared" style="width:90%;font-size:18px" />
  <!-- APPEND-ONLY record of keystrokes in the order the page received them.
       Deliberately not the input's value: the type tool focuses by clicking the
       element's CENTRE, and once the field has text the centre is mid-text, so
       the caret lands inside an earlier run and the value shows a split that
       never happened at dispatch. That is a property of clicking to focus, not
       of the lock - so the observable has to be dispatch order, which this is.
       It is also a text node, so query_dom can read it without eval (off by
       default in Agent Browser, and it should stay off for this to mean
       anything). -->
  <pre id="mirror"></pre>
  <script>
    const params = new URLSearchParams(location.search);
    document.getElementById('lane').textContent = params.get('lane') || 'unset';
    const mirror = document.getElementById('mirror');
    document.getElementById('shared').addEventListener('keydown', (event) => {
      if (event.key && event.key.length === 1) mirror.textContent += event.key;
    });
  </script>
</body></html>`;

export function startPageServer(port) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind the unspecified address on purpose: it is the shape a real dev
    // server uses, and the shape the old bind-only probe could not see.
    server.listen({ port }, () => resolve({
      server,
      close: () => new Promise((done) => {
        // A lane holds a keep-alive socket, so a bare close() never resolves.
        server.closeAllConnections?.();
        server.close(() => done());
      }),
    }));
  });
}

export function ok(label) {
  console.log(`  PASS  ${label}`);
}
export function fail(label, detail) {
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  process.exitCode = 1;
}
export function info(label) {
  console.log(`        ${label}`);
}
