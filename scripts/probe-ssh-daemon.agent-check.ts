/**
 * Spike check for the #913 daemon probe: does the real agent registry load under plain
 * Node, and does `resolveAgent` work through a real `PtyHostCore`? Bundled on its own so
 * a failure here cannot block the survival runs. `scripts/probe-ssh-daemon.mjs` runs it
 * in the rig; every step prints one JSON line, and an import failure is the process's
 * own stack on stderr. `tsconfig.json` covers `src/` only, so `npm run typecheck` does
 * not see this file.
 */

import { agentRegistry } from '../src/main/agent/agent-registry';
import { PtyHostCore } from '../src/main/pty/host/pty-host-core';
import type { PtyHostEvent } from '../src/main/pty/host/protocol';

function report(step: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ step, value })}\n`);
}

const names = agentRegistry.list();
report('registry', { count: names.length, names });

const resolved: string[] = [];
const events: Record<string, number> = {};
const core = new PtyHostCore({
  emit: (event: PtyHostEvent) => {
    events[event.type] = (events[event.type] ?? 0) + 1;
  },
  resolveAgent: (_sessionId, agentName) => {
    if (agentName) resolved.push(agentName);
    return agentName ? agentRegistry.get(agentName) : undefined;
  },
  transcriptSinkFor: () => ({ appendChunk: () => undefined }),
  coalesceMs: 0,
});

async function run(): Promise<void> {
  const firstAgent = names[0];
  const result = await core.handleRequest('spawn', {
    ptyId: 1,
    sessionId: 'agent-check',
    projectId: 'agent-check',
    agentName: firstAgent,
    transient: false,
    file: '/bin/sh',
    args: ['-c', 'echo agent-check-output; sleep 0.5'],
    cwd: process.env.HOME ?? '/',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
  });
  report('spawn', { agentName: firstAgent, ok: result.ok });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  report('resolved', { resolved, events, scrollback: core.getRawScrollback('agent-check') });
  process.exit(0);
}

void run();
