#!/usr/bin/env node
/**
 * Event Bridge for Claude Code hooks → Kangentic Activity Log
 *
 * Claude Code invokes this script via hooks (PreToolUse, PostToolUse,
 * UserPromptSubmit, Stop). Appends a single JSON line to the events log.
 *
 * Usage:
 *   node event-bridge.js <events-file-path> <event-type>
 *
 * Event types:
 *   tool_start — from PreToolUse hook (reads tool name + input from stdin)
 *   tool_end   — from PostToolUse hook (reads tool name from stdin)
 *   prompt     — from UserPromptSubmit hook
 *   idle       — from Stop hook
 *
 * Stdin: Claude Code pipes hook context as JSON. We parse it to extract
 * the tool name and first argument for tool_start/tool_end events.
 */
const fs = require('fs');
const outputPath = process.argv[2];
const eventType = process.argv[3] || 'idle';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!outputPath) return;

  const event = { ts: Date.now(), type: eventType };

  // Parse stdin JSON to extract tool info for tool_start/tool_end
  if (eventType === 'tool_start' || eventType === 'tool_end') {
    try {
      const ctx = JSON.parse(input);
      // Claude Code hook context has tool_name at top level
      if (ctx.tool_name) event.tool = ctx.tool_name;
      // Extract a short detail from the tool input (first useful field)
      if (eventType === 'tool_start' && ctx.tool_input) {
        const ti = ctx.tool_input;
        // Common tool input patterns: file_path, command, query, pattern
        const detail = ti.file_path || ti.command || ti.query || ti.pattern
          || ti.url || ti.description || ti.content?.slice?.(0, 80);
        if (detail) event.detail = String(detail).slice(0, 200);
      }
    } catch {
      // Stdin wasn't valid JSON — still write the event without tool info
    }
  }

  try {
    fs.appendFileSync(outputPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort — file may be locked or path may not exist
  }
});
