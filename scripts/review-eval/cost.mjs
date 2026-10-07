/**
 * Token and cost tally for Phase 0 finder runs, read from Claude Code subagent transcripts
 * (the JSONL an Agent launch names as its output file, or the files under
 * <project transcripts>/<session id>/subagents/). Never Read those files into a session: they are
 * large, and this script exists so only the totals reach the context.
 *
 * Usage: node scripts/review-eval/cost.mjs --prices <prices.json> <transcript.jsonl>...
 *   prices.json  { "<model id prefix>": { "input": usd, "cacheWrite5m": usd, "cacheWrite1h": usd,
 *                  "cacheRead": usd, "output": usd } } per million tokens, looked up from the
 *                  claude-api skill on the day of the run (record the date beside the results; never
 *                  hardcode prices here). Cache writes are split by TTL from `usage.cache_creation`;
 *                  a write with no split is priced at the 1-hour rate, the conservative reading.
 * Prints one JSON object: per transcript and in total, tokens by class and model, the USD cost,
 * the advisor call count, and tool calls by name.
 *
 * Claude Code writes one JSONL line per content block and repeats the message's usage on each, so
 * usage is counted once per message id (the last line wins, since it carries the final count).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isEntrypoint } from '../lib/is-entrypoint.mjs';

function emptyTokens() {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

/** Parses one transcript's text into per-model token totals, advisor calls and tool calls. */
export function tallyTranscript(text) {
  const usageByMessage = new Map();
  const toolCalls = {};
  let advisorCalls = 0;
  const countedToolUseIds = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry && entry.type === 'assistant' ? entry.message : null;
    if (!message || typeof message !== 'object') continue;
    if (message.usage && message.id) usageByMessage.set(message.id, { model: message.model || 'unknown', usage: message.usage });
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || (block.type !== 'tool_use' && block.type !== 'server_tool_use')) continue;
      if (block.id && countedToolUseIds.has(block.id)) continue;
      if (block.id) countedToolUseIds.add(block.id);
      toolCalls[block.name] = (toolCalls[block.name] || 0) + 1;
      if (block.name === 'advisor') advisorCalls++;
    }
  }
  const tokensByModel = {};
  for (const { model, usage } of usageByMessage.values()) {
    const tokens = tokensByModel[model] || (tokensByModel[model] = emptyTokens());
    tokens.input += usage.input_tokens || 0;
    // The 1-hour share is read when the split names it, and otherwise taken as the rest of the
    // total, clamped so a split with no total can never subtract from the cost.
    const cacheWriteTotal = usage.cache_creation_input_tokens || 0;
    const split = usage.cache_creation || {};
    const fiveMinute = split.ephemeral_5m_input_tokens || 0;
    const oneHour = typeof split.ephemeral_1h_input_tokens === 'number'
      ? split.ephemeral_1h_input_tokens
      : Math.max(0, cacheWriteTotal - fiveMinute);
    tokens.cacheWrite5m += fiveMinute;
    tokens.cacheWrite1h += oneHour;
    tokens.cacheRead += usage.cache_read_input_tokens || 0;
    tokens.output += usage.output_tokens || 0;
  }
  return { tokensByModel, advisorCalls, toolCalls, messages: usageByMessage.size };
}

/** USD for a tokens-by-model map; a model with no price entry is reported, never guessed. */
export function costOf(tokensByModel, prices) {
  let usd = 0;
  const unpriced = [];
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    const priceKey = Object.keys(prices)
      .filter((prefix) => model.startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0];
    if (!priceKey) {
      unpriced.push(model);
      continue;
    }
    const price = prices[priceKey];
    usd +=
      (tokens.input * price.input +
        tokens.cacheWrite5m * price.cacheWrite5m +
        tokens.cacheWrite1h * price.cacheWrite1h +
        tokens.cacheRead * price.cacheRead +
        tokens.output * price.output) /
      1_000_000;
  }
  return { usd: Math.round(usd * 10000) / 10000, unpriced };
}

function main(argv) {
  const pricesIndex = argv.indexOf('--prices');
  if (pricesIndex === -1 || !argv[pricesIndex + 1]) {
    console.error('usage: node scripts/review-eval/cost.mjs --prices <prices.json> <transcript.jsonl>...');
    return 2;
  }
  const prices = JSON.parse(fs.readFileSync(argv[pricesIndex + 1], 'utf8'));
  const transcriptPaths = argv.filter((_, argumentIndex) => argumentIndex !== pricesIndex && argumentIndex !== pricesIndex + 1);
  const total = { tokensByModel: {}, advisorCalls: 0, toolCalls: {}, usd: 0, unpriced: [] };
  const perTranscript = [];
  for (const transcriptPath of transcriptPaths) {
    const tally = tallyTranscript(fs.readFileSync(transcriptPath, 'utf8'));
    const cost = costOf(tally.tokensByModel, prices);
    perTranscript.push({ transcript: path.basename(transcriptPath), ...tally, ...cost });
    for (const [model, tokens] of Object.entries(tally.tokensByModel)) {
      const totalTokens = total.tokensByModel[model] || (total.tokensByModel[model] = emptyTokens());
      for (const tokenClass of Object.keys(tokens)) totalTokens[tokenClass] += tokens[tokenClass];
    }
    for (const [toolName, count] of Object.entries(tally.toolCalls)) total.toolCalls[toolName] = (total.toolCalls[toolName] || 0) + count;
    total.advisorCalls += tally.advisorCalls;
    total.usd += cost.usd;
    total.unpriced.push(...cost.unpriced);
  }
  total.usd = Math.round(total.usd * 10000) / 10000;
  total.unpriced = [...new Set(total.unpriced)];
  console.log(JSON.stringify({ total, perTranscript }, null, 2));
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
