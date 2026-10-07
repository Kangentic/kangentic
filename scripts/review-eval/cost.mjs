/**
 * Token and cost tally for Phase 0 finder runs, read from Claude Code subagent transcripts
 * (the JSONL an Agent launch names as its output file, or the files under
 * <project transcripts>/<session id>/subagents/). Never Read those files into a session: they are
 * large, and this script exists so only the totals reach the context.
 *
 * Usage: node scripts/review-eval/cost.mjs --prices <prices.json> <transcript.jsonl>...
 *   prices.json  { "<model id prefix>": { "input": usd, "cacheWrite5m": usd, "cacheWrite1h": usd,
 *                  "cacheRead": usd, "output": usd, "above"?: { "promptTokens": n, "input": usd, ... } } }
 *                  per million tokens, looked up from the claude-api skill on the day of the run
 *                  (record the date beside the results; never hardcode prices here). Cache writes are
 *                  split by TTL from `usage.cache_creation`; a write with no split is priced at the
 *                  1-hour rate, the conservative reading.
 *
 *                  `above` is a second rate card for a model billed by request size (Haiku 5.5 bills
 *                  five times its rate for a prompt over 100k tokens). A request's size is its own
 *                  input plus cache read plus cache write tokens, and a request over `promptTokens`
 *                  prices all five classes, output included, at the `above` rates. The tier is decided
 *                  per request, never on a sum: summed tokens no longer know how big each request was.
 * Prints one JSON object: per transcript and in total, tokens by class and model, the USD cost,
 * the requests above a model's tier, the advisor call count, and tool calls by name.
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
  const requests = [];
  for (const { model, usage } of usageByMessage.values()) {
    // The 1-hour share is read when the split names it, and otherwise taken as the rest of the
    // total, clamped so a split with no total can never subtract from the cost.
    const cacheWriteTotal = usage.cache_creation_input_tokens || 0;
    const split = usage.cache_creation || {};
    const fiveMinute = split.ephemeral_5m_input_tokens || 0;
    const oneHour = typeof split.ephemeral_1h_input_tokens === 'number'
      ? split.ephemeral_1h_input_tokens
      : Math.max(0, cacheWriteTotal - fiveMinute);
    const requestTokens = {
      input: usage.input_tokens || 0,
      cacheWrite5m: fiveMinute,
      cacheWrite1h: oneHour,
      cacheRead: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0,
    };
    requests.push({ model, tokens: requestTokens });
    const tokens = tokensByModel[model] || (tokensByModel[model] = emptyTokens());
    for (const tokenClass of Object.keys(requestTokens)) tokens[tokenClass] += requestTokens[tokenClass];
  }
  return { tokensByModel, requests, advisorCalls, toolCalls, messages: usageByMessage.size };
}

/** A request's size for a tiered rate card: everything it sent, cached or not, but not its output. */
export function promptTokensOf(tokens) {
  return tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
}

/**
 * USD for a list of requests (`tallyTranscript(...).requests`), each priced on its own rate card. A
 * model with no price entry is reported, never guessed. `aboveTier` counts, per model with an
 * `above` card, how many requests were priced on it, out of how many.
 */
export function costOfRequests(requests, prices) {
  let usd = 0;
  const unpriced = new Set();
  const aboveTier = {};
  for (const { model, tokens } of requests) {
    const priceKey = Object.keys(prices)
      .filter((prefix) => model.startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0];
    if (!priceKey) {
      unpriced.add(model);
      continue;
    }
    let price = prices[priceKey];
    if (price.above) {
      const counts = aboveTier[model] || (aboveTier[model] = { above: 0, requests: 0 });
      counts.requests++;
      if (promptTokensOf(tokens) > price.above.promptTokens) {
        counts.above++;
        price = price.above;
      }
    }
    usd +=
      (tokens.input * price.input +
        tokens.cacheWrite5m * price.cacheWrite5m +
        tokens.cacheWrite1h * price.cacheWrite1h +
        tokens.cacheRead * price.cacheRead +
        tokens.output * price.output) /
      1_000_000;
  }
  return { usd: Math.round(usd * 10000) / 10000, unpriced: [...unpriced], aboveTier };
}

function main(argv) {
  const pricesIndex = argv.indexOf('--prices');
  if (pricesIndex === -1 || !argv[pricesIndex + 1]) {
    console.error('usage: node scripts/review-eval/cost.mjs --prices <prices.json> <transcript.jsonl>...');
    return 2;
  }
  const prices = JSON.parse(fs.readFileSync(argv[pricesIndex + 1], 'utf8'));
  const transcriptPaths = argv.filter((_, argumentIndex) => argumentIndex !== pricesIndex && argumentIndex !== pricesIndex + 1);
  const total = { tokensByModel: {}, advisorCalls: 0, toolCalls: {}, usd: 0, unpriced: [], aboveTier: {} };
  const perTranscript = [];
  for (const transcriptPath of transcriptPaths) {
    const { requests, ...tally } = tallyTranscript(fs.readFileSync(transcriptPath, 'utf8'));
    const cost = costOfRequests(requests, prices);
    perTranscript.push({ transcript: path.basename(transcriptPath), ...tally, ...cost });
    for (const [model, tokens] of Object.entries(tally.tokensByModel)) {
      const totalTokens = total.tokensByModel[model] || (total.tokensByModel[model] = emptyTokens());
      for (const tokenClass of Object.keys(tokens)) totalTokens[tokenClass] += tokens[tokenClass];
    }
    for (const [model, counts] of Object.entries(cost.aboveTier)) {
      const totalCounts = total.aboveTier[model] || (total.aboveTier[model] = { above: 0, requests: 0 });
      totalCounts.above += counts.above;
      totalCounts.requests += counts.requests;
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
