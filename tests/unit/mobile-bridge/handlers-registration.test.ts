/**
 * Locks that attachContext() (via registerCapabilityHandlers) registers a
 * handler for every one of the 9 Phase 2 capability verbs, exactly once
 * each. Each real handler module is mocked out here so this test exercises
 * only the registration wiring, not the handlers' own logic (each has its
 * own dedicated test file).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/main/mobile-bridge/handlers/read-stream', () => ({ handleReadStream: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/read-board', () => ({ handleReadBoard: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/read-diff', () => ({ handleReadDiff: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/send-user-message', () => ({ handleSendUserMessage: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/move-task', () => ({ handleMoveTask: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/interactive-terminal', () => ({ handleInteractiveTerminal: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/answer-permission-prompt', () => ({ handleAnswerPermissionPrompt: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/handlers/board-tool', () => ({ handleBoardTool: vi.fn() }));

import { CAPABILITY_VERBS } from '@kangentic/protocol';
import { registerCapabilityHandlers } from '../../../src/main/mobile-bridge/handlers';
import { CapabilityRouter } from '../../../src/main/mobile-bridge/capability-router';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { DiffWatcher } from '../../../src/main/git/diff-watcher';
import type { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

describe('registerCapabilityHandlers', () => {
  it('registers a handler for every verb in CAPABILITY_VERBS, exactly once', () => {
    const router = new CapabilityRouter();
    const registerSpy = vi.spyOn(router, 'register');

    registerCapabilityHandlers(router, {
      context: {} as IpcContext,
      diffWatcher: {} as DiffWatcher,
      getSubscriptions: () => ({}) as SubscriptionRegistry,
    });

    const registeredVerbs = registerSpy.mock.calls.map(([verb]) => verb);
    expect(new Set(registeredVerbs)).toEqual(new Set(CAPABILITY_VERBS));
    expect(registeredVerbs.length).toBe(CAPABILITY_VERBS.length);
  });
});
