/**
 * Collects each finder's final report out of its subagent transcript and writes it under an
 * anonymous id, so the blind scorer never sees which arm, shard or repetition produced it.
 *
 * Usage: node scripts/review-eval/collect-reports.mjs <runs.json> <experiment> <case id> <out dir>
 *   runs.json  the run ledger: { "transcriptDir": "<dir>", "<experiment>": { "<case id>": [{ "agentId",
 *              "arm", "rep", "shard" }] } }. A run's transcript is <transcriptDir>/agent-<agentId>.jsonl
 *              (Claude Code keeps subagent transcripts in <project transcripts>/<session id>/subagents/),
 *              or the run's own "transcript" path when it names one.
 * Writes <out dir>/<anonymous id>.md per run, and <out dir>.key.json (beside the folder, never inside
 * it) mapping ids back to runs. Give the scorer the folder; the key is for tallying afterwards.
 *
 * The report is the input of the transcript's last SubagentHandback call, or, when there is none,
 * the last assistant text block.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The final report a subagent handed back, from its transcript text. */
export function finalReportOf(text) {
  let handback = null;
  let lastText = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block && block.type === 'tool_use' && block.name === 'SubagentHandback' && block.input && typeof block.input.message === 'string') {
        handback = block.input.message;
      } else if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lastText = block.text;
      }
    }
  }
  return handback ?? lastText;
}

function main(argv) {
  if (argv.length !== 4) {
    console.error('usage: node scripts/review-eval/collect-reports.mjs <runs.json> <experiment> <case id> <out dir>');
    return 2;
  }
  const [runsPath, experiment, caseId, outDirectory] = argv;
  const ledger = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
  const runs = (ledger[experiment] || {})[caseId];
  if (!Array.isArray(runs) || runs.length === 0) {
    console.error(`no runs for ${experiment} ${caseId} in ${runsPath}`);
    return 2;
  }
  if (!ledger.transcriptDir && runs.some((run) => !run.transcript)) {
    console.error('runs.json needs "transcriptDir" or a "transcript" path on every run');
    return 2;
  }
  fs.mkdirSync(outDirectory, { recursive: true });
  const key = [];
  for (const run of runs) {
    const transcriptPath = run.transcript || path.join(ledger.transcriptDir, `agent-${run.agentId}.jsonl`);
    if (!fs.existsSync(transcriptPath)) {
      console.error(`missing transcript for ${run.agentId}: ${transcriptPath}`);
      return 1;
    }
    const report = finalReportOf(fs.readFileSync(transcriptPath, 'utf8'));
    if (report === null) {
      console.error(`no final report in ${transcriptPath}`);
      return 1;
    }
    const anonymousId = crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(path.join(outDirectory, `${anonymousId}.md`), report);
    key.push({ anonymousId, ...run, transcript: transcriptPath });
  }
  fs.writeFileSync(`${path.resolve(outDirectory)}.key.json`, JSON.stringify(key, null, 2) + '\n');
  console.log(`wrote ${key.length} anonymized reports to ${outDirectory}`);
  return 0;
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isEntrypoint()) {
  process.exitCode = main(process.argv.slice(2));
}
