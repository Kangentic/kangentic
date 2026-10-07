/**
 * Pulls the finder prompts a historical /code-review driver sent (its Agent tool calls) out of the
 * driver's session transcript, so Phase 0's arm A runs today's prompts verbatim instead of a
 * paraphrase.
 *
 * Usage: node scripts/review-eval/extract-finder-prompts.mjs <session.jsonl> <out dir>
 * Writes one file per Agent call, `<index>-<subagent type>.md`, holding the prompt exactly as sent,
 * plus `index.json` listing the index, subagent type, description, model override and prompt length.
 * The prompts name the historical pack path; the runner swaps in the replay pack's path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Every Agent (or legacy Task) tool call in a transcript, in order, deduped by tool-use id. */
export function extractAgentCalls(text) {
  const calls = [];
  const seenIds = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
    // A sidechain line belongs to a subagent, not the driver.
    if (entry.isSidechain === true) continue;
    for (const block of entry.message.content) {
      if (!block || block.type !== 'tool_use' || (block.name !== 'Agent' && block.name !== 'Task')) continue;
      if (seenIds.has(block.id)) continue;
      seenIds.add(block.id);
      const input = block.input || {};
      calls.push({
        subagentType: input.subagent_type || 'general-purpose',
        description: input.description || '',
        model: input.model || null,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        timestamp: entry.timestamp || null,
      });
    }
  }
  return calls;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: node scripts/review-eval/extract-finder-prompts.mjs <session.jsonl> <out dir>');
    return 2;
  }
  const [transcriptPath, outDirectory] = argv;
  const calls = extractAgentCalls(fs.readFileSync(transcriptPath, 'utf8'));
  fs.mkdirSync(outDirectory, { recursive: true });
  const index = calls.map((call, callIndex) => {
    const fileName = `${String(callIndex + 1).padStart(2, '0')}-${call.subagentType.replace(/[^A-Za-z0-9-]/g, '_')}.md`;
    fs.writeFileSync(path.join(outDirectory, fileName), call.prompt);
    return {
      index: callIndex + 1,
      file: fileName,
      subagentType: call.subagentType,
      description: call.description,
      model: call.model,
      promptChars: call.prompt.length,
      timestamp: call.timestamp,
    };
  });
  fs.writeFileSync(path.join(outDirectory, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`extracted ${calls.length} Agent calls to ${outDirectory}`);
  for (const item of index) console.log(`  ${item.file}  ${item.description}  (${item.promptChars} chars)`);
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
