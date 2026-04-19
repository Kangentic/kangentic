#!/usr/bin/env node
/**
 * Event Bridge - Generic hook-to-JSONL bridge for all agent adapters.
 *
 * Agent CLIs invoke this script via hooks. Appends a single JSON line
 * to the events log. All agent-specific knowledge (field names, event
 * types, stdin formats) is passed via command-line directives from each
 * adapter's hook-manager.
 *
 * Usage:
 *   node event-bridge.js <events-file-path> <event-type> [directives...]
 *
 * Directives:
 *   tool:<field>                   Extract event.tool from ctx[field]
 *   detail:<f1>,<f2>,...           Extract event.detail from first non-null ctx[f]
 *   nested-detail:<p>:<f1>,<f2>,.. Extract event.detail from first non-null ctx[p][f]
 *   env:<key>=<ENV_VAR>            Capture env var into hookContext as key
 *   remap:<field>:<value>:<type>   If ctx[field]==value, change event.type to type
 *   remap-nested:<p>:<field>:<value>:<type>
 *                                  If ctx[p][field]==value, change event.type to type
 *   arg-detail                     Use argv[next] as event.detail (for inline values)
 *
 * Stdin: Agent CLIs pipe hook context as JSON. Directives control which
 * fields are extracted for each event type.
 */
// Stdout guard: Gemini CLI rejects any stdout output from hook scripts as
// malformed JSON (docs: "Strict JSON" rule). Codex/Claude tolerate noise on
// stdout but it still gets logged as hook output. We explicitly suppress
// stdout so a stray console.log added during debugging can never silently
// break hook parsing. All diagnostics must go to stderr.
process.stdout.write = () => true;

const fs = require('fs');
const outputPath = process.argv[2];
const eventType = process.argv[3] || 'idle';
const directives = process.argv.slice(4);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!outputPath) return;

  const event = { ts: Date.now(), type: eventType };

  // Parse stdin JSON once for all directives
  let ctx = null;
  if (input && input.length > 0) {
    try { ctx = JSON.parse(input); } catch { /* stdin not valid JSON */ }
  }

  // Process directives
  for (let i = 0; i < directives.length; i++) {
    const directive = directives[i];

    if (directive.startsWith('tool:')) {
      // tool:<field> - extract event.tool from ctx[field]
      const field = directive.slice(5);
      if (ctx && ctx[field] != null) event.tool = ctx[field];

    } else if (directive.startsWith('nested-detail:')) {
      // nested-detail:<parent>:<f1>,<f2>,... - extract detail from ctx[parent][f]
      const rest = directive.slice(14);
      const colonIndex = rest.indexOf(':');
      if (colonIndex > 0 && ctx) {
        const parent = rest.slice(0, colonIndex);
        const fields = rest.slice(colonIndex + 1).split(',');
        const container = ctx[parent];
        if (container && typeof container === 'object') {
          for (const field of fields) {
            const value = container[field];
            if (value != null) {
              event.detail = String(value).slice(0, 200);
              break;
            }
          }
        }
      }

    } else if (directive.startsWith('detail:')) {
      // detail:<f1>,<f2>,... - extract detail from first non-null ctx[f]
      if (!event.detail) {
        const fields = directive.slice(7).split(',');
        if (ctx) {
          for (const field of fields) {
            if (ctx[field] != null) {
              event.detail = String(ctx[field]).slice(0, 200);
              break;
            }
          }
        }
      }

    } else if (directive === 'arg-detail') {
      // arg-detail - use next argv as event.detail
      if (i + 1 < directives.length) {
        event.detail = String(directives[++i]).slice(0, 200);
      }

    } else if (directive.startsWith('remap-nested:')) {
      // remap-nested:<parent>:<field>:<value>:<new-type> - conditionally
      // change event.type based on a NESTED field value. Parse the three
      // leading colons; everything after the third colon is the new type.
      const rest = directive.slice(13);
      const firstColon = rest.indexOf(':');
      const secondColon = rest.indexOf(':', firstColon + 1);
      const thirdColon = rest.indexOf(':', secondColon + 1);
      if (firstColon > 0 && secondColon > firstColon && thirdColon > secondColon && ctx) {
        const parent = rest.slice(0, firstColon);
        const field = rest.slice(firstColon + 1, secondColon);
        const value = rest.slice(secondColon + 1, thirdColon);
        const newType = rest.slice(thirdColon + 1);
        const container = ctx[parent];
        if (container && typeof container === 'object' && String(container[field]) === value) {
          event.type = newType;
        }
      }

    } else if (directive.startsWith('remap:')) {
      // remap:<field>:<value>:<new-type> - conditionally change event.type.
      // Field and value cannot contain ':' but new-type can (uses last 2 colons).
      const rest = directive.slice(6);
      const firstColon = rest.indexOf(':');
      const secondColon = rest.indexOf(':', firstColon + 1);
      if (firstColon > 0 && secondColon > firstColon && ctx) {
        const field = rest.slice(0, firstColon);
        const value = rest.slice(firstColon + 1, secondColon);
        const newType = rest.slice(secondColon + 1);
        if (String(ctx[field]) === value) {
          event.type = newType;
        }
      }
    }
    // env: directives are handled below in the session_start block
  }

  // Build hookContext for adapter-specific session ID extraction.
  // Only on session_start events to avoid bloating the JSONL file.
  if (eventType === 'session_start') {
    const hookCtx = ctx ? { ...ctx } : {};
    // Capture env vars specified as env:<key>=<ENV_VAR> directives.
    for (const directive of directives) {
      if (directive.startsWith('env:')) {
        const rest = directive.slice(4);
        const eqIndex = rest.indexOf('=');
        if (eqIndex > 0) {
          const targetKey = rest.slice(0, eqIndex);
          const envName = rest.slice(eqIndex + 1);
          if (envName && process.env[envName] && !hookCtx[targetKey]) {
            hookCtx[targetKey] = process.env[envName];
          }
        }
      }
    }
    if (Object.keys(hookCtx).length > 0) {
      event.hookContext = JSON.stringify(hookCtx).slice(0, 2048);
    }
  }

  try {
    fs.appendFileSync(outputPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort - file may be locked or path may not exist
  }
});
