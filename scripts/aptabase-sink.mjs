#!/usr/bin/env node
/**
 * Local Aptabase sink: see every analytics event the app sends, end to end,
 * without touching the production project or its event budget.
 *
 * The @aptabase/electron SDK picks its host from the middle segment of the app
 * key, and an `A-DEV-<digits>` key routes every event to http://localhost:3000.
 * Run this, then start Kangentic with
 *
 *   KANGENTIC_TELEMETRY=1
 *   KANGENTIC_APTABASE_APP_KEY=A-DEV-0000000000
 *   KANGENTIC_ERROR_REPORTING=0
 *
 * (the last one because error reporting inherits the telemetry switch, and a
 * dev build should not start sending real errors to Sentry just to watch
 * analytics) and each event prints here as it is POSTed: the name, then the
 * properties.
 * This is the acceptance test for anything in the quit path (nothing sent
 * from there can land, which is why app_launch reports the previous run) and
 * for the once-per-run events. See docs/analytics.md, "Local verification".
 */
import http from 'node:http';

const PORT = 3000;

function describeEvent(event) {
  const props = event && typeof event === 'object' && event.props ? event.props : {};
  return `${event?.eventName ?? '(no eventName)'} ${JSON.stringify(props)}`;
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const stamp = new Date().toISOString();
    try {
      const payload = JSON.parse(body);
      for (const event of Array.isArray(payload) ? payload : [payload]) {
        console.log(`${stamp} ${describeEvent(event)}`);
      }
    } catch {
      console.log(`${stamp} ${request.method} ${request.url} (unparsed) ${body}`);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});

// Loopback only. The SDK reaches this from the same machine, so binding the
// default (every interface) would put a sink that accepts and prints arbitrary
// posted JSON on the local network for no gain.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`aptabase-sink listening on http://localhost:${PORT}/api/v0/event`);
  console.log(
    'Start Kangentic with KANGENTIC_TELEMETRY=1 KANGENTIC_APTABASE_APP_KEY=A-DEV-0000000000 KANGENTIC_ERROR_REPORTING=0',
  );
});
