#!/usr/bin/env node
/**
 * Node-level wrapper around mock-claude.js that forces the bg-bash
 * branch on by mutating process.env in-process before requiring the
 * main mock. This avoids relying on cmd.exe's `set` keyword, which
 * does not propagate reliably under node-pty's Windows spawn path
 * (ConPTY) -- the batch `set` runs but the env mutation does not
 * reach node.exe when node-pty invokes the .cmd directly.
 */
process.env.MOCK_CLAUDE_BACKGROUND_BASH = '1';
require('./mock-claude.js');
