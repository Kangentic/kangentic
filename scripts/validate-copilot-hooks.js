#!/usr/bin/env node
/**
 * Validate that Copilot hooks are firing in your real Kangentic install.
 *
 * Usage:
 *   1. Open Kangentic (npm start or your installed build)
 *   2. Spawn a Copilot task in any swimlane (move a task to a column with
 *      a Copilot agent action, or create one fresh)
 *   3. Run this script with the task's session ID:
 *
 *        node scripts/validate-copilot-hooks.js <session-id>
 *
 *      Or pass --latest to auto-pick the most recent session in
 *      the current project:
 *
 *        node scripts/validate-copilot-hooks.js --latest
 *
 * The script reads the events.jsonl file from the session directory and
 * tells you exactly which hooks fired, with timestamps. If the file is
 * empty, the hook bridge is not working - check the diagnostic output.
 *
 * This is the gold-standard validation: it uses real Copilot auth, real
 * project state, and the real Kangentic hook configuration. If this
 * shows events, hooks work in production.
 */
const fs = require('node:fs');
const path = require('node:path');

function findProjectRoot() {
  // Walk up from CWD looking for .kangentic/sessions/
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.kangentic', 'sessions'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function listSessions(projectRoot) {
  const sessionsDir = path.join(projectRoot, '.kangentic', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .map((name) => {
      const directory = path.join(sessionsDir, name);
      const stat = fs.statSync(directory);
      if (!stat.isDirectory()) return null;
      const eventsPath = path.join(directory, 'events.jsonl');
      const hasEvents = fs.existsSync(eventsPath);
      const eventsSize = hasEvents ? fs.statSync(eventsPath).size : 0;
      // Check if this is a Copilot session by looking for copilot-config dir
      const hasCopilotConfig = fs.existsSync(path.join(directory, 'copilot-config'));
      return {
        sessionId: name,
        directory,
        eventsPath,
        hasEvents,
        eventsSize,
        hasCopilotConfig,
        mtime: stat.mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const projectRoot = findProjectRoot();

  if (!projectRoot) {
    console.error('ERROR: No .kangentic/sessions/ directory found in CWD or any parent.');
    console.error('Run this script from inside a Kangentic project directory.');
    process.exit(1);
  }

  console.log(`Project root: ${projectRoot}`);

  const allSessions = listSessions(projectRoot);
  if (allSessions.length === 0) {
    console.error('ERROR: No sessions found in .kangentic/sessions/.');
    console.error('Spawn a task in Kangentic first, then re-run this script.');
    process.exit(1);
  }

  // Filter to Copilot sessions (have copilot-config directory)
  const copilotSessions = allSessions.filter((session) => session.hasCopilotConfig);
  const sessions = copilotSessions.length > 0 ? copilotSessions : allSessions;

  if (copilotSessions.length > 0) {
    console.log(`Found ${copilotSessions.length} Copilot session(s) (${allSessions.length} total).`);
  } else {
    console.log(`No Copilot-specific sessions found. Showing all ${allSessions.length} sessions.`);
  }

  let target;
  if (args[0] === '--latest' || args.length === 0) {
    target = sessions[0];
    console.log(`Using most recent session: ${target.sessionId}`);
  } else {
    target = allSessions.find((session) => session.sessionId === args[0]);
    if (!target) {
      console.error(`ERROR: Session "${args[0]}" not found. Available:`);
      for (const session of sessions.slice(0, 10)) {
        const tag = session.hasEvents ? `${session.eventsSize}B` : 'no events.jsonl';
        const copilotTag = session.hasCopilotConfig ? ' [copilot]' : '';
        console.error(`  ${session.sessionId}  (${tag})${copilotTag}`);
      }
      process.exit(1);
    }
  }

  console.log(`Session dir: ${target.directory}`);
  console.log(`Events path: ${target.eventsPath}`);

  // Check for copilot-config directory and its contents
  const copilotConfigDir = path.join(target.directory, 'copilot-config');
  if (fs.existsSync(copilotConfigDir)) {
    console.log(`Copilot config: ${copilotConfigDir}`);
    const configPath = path.join(copilotConfigDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const hookCount = config.hooks ? Object.keys(config.hooks).length : 0;
        const hasStatusLine = !!config.statusLine;
        console.log(`  hooks: ${hookCount} event(s) configured`);
        console.log(`  statusLine: ${hasStatusLine ? 'yes' : 'no'}`);
        console.log(`  banner: ${config.banner || '(not set)'}`);
        if (config.hooks) {
          for (const [event, hook] of Object.entries(config.hooks)) {
            const hookEntry = hook;
            const isOurs = hookEntry.command && hookEntry.command.includes('.kangentic');
            console.log(`    ${event}: ${isOurs ? 'kangentic bridge' : 'user hook'}`);
          }
        }
      } catch {
        console.log('  (config.json exists but could not be parsed)');
      }
    }
  } else {
    console.log('Copilot config: not found (session may not be Copilot-based)');
  }
  console.log('');

  // Check for status.json
  const statusPath = path.join(target.directory, 'status.json');
  if (fs.existsSync(statusPath)) {
    try {
      const statusRaw = fs.readFileSync(statusPath, 'utf-8');
      const status = JSON.parse(statusRaw);
      console.log('Status file found:');
      if (status.model) console.log(`  model: ${status.model.id || status.model.display_name || JSON.stringify(status.model)}`);
      if (status.context_window) console.log(`  context: ${status.context_window.used_percentage || 0}% used`);
      console.log('');
    } catch {
      console.log('Status file found but could not be parsed.');
      console.log('');
    }
  }

  if (!target.hasEvents) {
    console.error('FAIL: events.jsonl does NOT exist for this session.');
    console.error('');
    console.error('Diagnostics:');
    console.error('  - Was the session spawned with eventsOutputPath set?');
    console.error('    (Production transition-engine.ts always passes it.)');
    console.error('  - Did the Copilot adapter write its hook config?');
    console.error(`    Look for ${copilotConfigDir}/config.json`);
    console.error('    It should contain hooks with ".kangentic" and "event-bridge" in commands.');
    console.error('  - Is Copilot CLI actually reading the --config-dir?');
    console.error('    Check that --config-dir points to the copilot-config directory.');
    process.exit(2);
  }

  const events = readEvents(target.eventsPath);
  console.log(`Events file size: ${target.eventsSize} bytes, parsed ${events.length} events.`);
  console.log('');

  if (events.length === 0) {
    console.error('FAIL: events.jsonl exists but contains zero parseable events.');
    console.error('');
    console.error('Raw contents (first 500 chars):');
    console.error(fs.readFileSync(target.eventsPath, 'utf-8').slice(0, 500));
    process.exit(3);
  }

  // Group by event type for a clean summary.
  const byType = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
  }

  console.log('Event type breakdown:');
  for (const type of Object.keys(byType).sort()) {
    console.log(`  ${type.padEnd(20)} ${byType[type]}`);
  }
  console.log('');

  console.log('First 5 events (chronological):');
  for (const event of events.slice(0, 5)) {
    const timestamp = new Date(event.ts).toISOString().slice(11, 23);
    const extras = Object.keys(event)
      .filter((key) => key !== 'ts' && key !== 'type')
      .map((key) => `${key}=${JSON.stringify(event[key])}`)
      .join(' ');
    console.log(`  ${timestamp}  ${event.type.padEnd(18)} ${extras}`);
  }
  console.log('');

  // Verdict
  const sawTool = Object.keys(byType).some((type) => type.startsWith('tool_'));
  const sawIdle = byType.idle > 0;
  const sawCompact = byType.compact > 0;

  if (sawTool || sawIdle) {
    console.log('PASS: Copilot hook bridge is firing events end-to-end.');
    console.log(`  tool_*:   ${sawTool ? 'yes' : 'no'}`);
    console.log(`  idle:     ${sawIdle ? 'yes' : 'no'}`);
    console.log(`  compact:  ${sawCompact ? 'yes' : 'no'}`);
    process.exit(0);
  } else {
    console.warn('PARTIAL: events fired but none of the expected types (tool_*, idle).');
    console.warn('The bridge is wired but Copilot may not be reaching the hook events you expect.');
    console.warn('This could mean:');
    console.warn('  - The session was too short for any tool use');
    console.warn('  - Copilot CLI is not reading hooks from --config-dir');
    console.warn('  - The hook event names differ from what we expected');
    process.exit(0);
  }
}

main();
