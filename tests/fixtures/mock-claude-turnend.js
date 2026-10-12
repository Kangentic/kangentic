#!/usr/bin/env node
/**
 * Node-level wrapper around mock-claude.js that forces the turn-end branch on
 * by mutating process.env in-process before requiring the main mock. Same
 * reason as mock-claude-bgbash.js: a cmd.exe `set` does not reliably reach
 * node.exe when node-pty launches the .cmd under ConPTY.
 */
process.env.MOCK_CLAUDE_TURN_END = '1';
require('./mock-claude.js');
