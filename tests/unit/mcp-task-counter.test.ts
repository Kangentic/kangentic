import { describe, it, expect, vi } from 'vitest';

// handler-helpers imports `commandHandlers` from ../commands, which transitively
// loads better-sqlite3 (a native module). makeTaskCounter is a pure function with
// no such dependency, so stub the commands barrel to keep this a pure unit test
// that exercises the REAL counter (the broader mcp-task-session-tools suite mocks
// the whole handler-helpers module and so cannot cover makeTaskCounter itself).
vi.mock('../../src/main/agent/commands', () => ({ commandHandlers: {} }));

import { makeTaskCounter, DEFAULT_MAX_TASK_CREATE_PER_LAUNCH } from '../../src/main/agent/mcp-http/handler-helpers';
import { DEFAULT_CONFIG } from '../../src/shared/types';

// The runaway-loop ceiling is user-configurable (mcpServer.maxTaskCreatePerLaunch),
// with DEFAULT_MAX_TASK_CREATE_PER_LAUNCH as the fallback default used when no
// configured value is available at startup. limit() reports whichever ceiling the
// counter was built with.
describe('makeTaskCounter (configurable runaway-loop ceiling)', () => {
  it('reports the default ceiling via limit() when none is supplied', () => {
    const counter = makeTaskCounter();
    expect(counter.limit()).toBe(DEFAULT_MAX_TASK_CREATE_PER_LAUNCH);
  });

  it('honors a configured ceiling: reserves up to it, then refuses', () => {
    const ceiling = 3;
    const counter = makeTaskCounter(ceiling);
    expect(counter.limit()).toBe(ceiling);

    for (let reserved = 0; reserved < ceiling; reserved++) {
      expect(counter.tryReserve()).toBe(true);
    }
    // The ceiling is reached: the next reservation is refused.
    expect(counter.tryReserve()).toBe(false);
    // And stays refused (the count does not roll over).
    expect(counter.tryReserve()).toBe(false);
  });

  it('each counter accumulates independently of others', () => {
    const first = makeTaskCounter();
    const second = makeTaskCounter();
    expect(first.tryReserve()).toBe(true);
    // A reservation on one counter does not advance the other.
    expect(second.tryReserve()).toBe(true);
  });

  // The fallback default MUST be derived from DEFAULT_CONFIG, not a second
  // hardcoded literal, so the shipped default and the startup fallback can never
  // drift apart (the design intent documented in handler-helpers.ts).
  //
  // Red-green: change DEFAULT_MAX_TASK_CREATE_PER_LAUNCH in handler-helpers.ts
  // from `DEFAULT_CONFIG.mcpServer.maxTaskCreatePerLaunch` to a bare literal that
  // differs from the config default (e.g. `500`) and this fails.
  it('derives the default ceiling from DEFAULT_CONFIG (no drift)', () => {
    expect(DEFAULT_MAX_TASK_CREATE_PER_LAUNCH).toBe(DEFAULT_CONFIG.mcpServer.maxTaskCreatePerLaunch);
  });

  // A ceiling of 0 (which the UI guard forbids, but which a hand-edited config
  // file could still supply) must refuse every reservation rather than allowing
  // one through off-by-one.
  it('refuses all reservations when built with a ceiling of 0', () => {
    const counter = makeTaskCounter(0);
    expect(counter.limit()).toBe(0);
    expect(counter.tryReserve()).toBe(false);
  });
});
