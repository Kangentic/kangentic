#!/usr/bin/env node
/**
 * Node-level wrapper around mock-claude.js for the workflow engine guard
 * (tests/e2e/workflow-engine.spec.ts). It forces three branches on by mutating
 * process.env in-process before requiring the main mock, for the reason
 * mock-claude-turnend.js gives: a cmd.exe `set` does not reliably reach node.exe
 * when node-pty launches the .cmd under ConPTY.
 *
 * - MOCK_CLAUDE_TURN_END: a fresh session plays one finished turn.
 * - MOCK_CLAUDE_TURN_ON_INPUT: so does a resume with a prompt, and a typed line.
 * - MOCK_CLAUDE_CONDITION_ANSWER: a --print run answers the Automation agent's
 *   condition check (yes, unless the task's title contains "needs-you").
 */
process.env.MOCK_CLAUDE_TURN_END = '1';
process.env.MOCK_CLAUDE_TURN_ON_INPUT = '1';
process.env.MOCK_CLAUDE_CONDITION_ANSWER = '1';
require('./mock-claude.js');
