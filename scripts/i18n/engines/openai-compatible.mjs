/**
 * The local engine: any server with an OpenAI-compatible `/v1/chat/completions`
 * and JSON Schema output. llama.cpp's `llama-server`, Ollama and LM Studio all
 * serve one, so picking a runtime is a URL, not code.
 *
 * `promptStyle: 'translategemma'` is for TranslateGemma, which takes one string
 * per request in a fixed format with no room for instructions, a glossary or
 * context. It is the bake-off's baseline, not an engine to refill with, and it
 * needs llama.cpp's `llama-server` (see `translateGemmaPrompt`).
 */
import { readReplies, REPLY_SCHEMA, systemPrompt, userPrompt } from '../prompt.mjs';

/** `llama-server`'s default address (port 9931 since llama.cpp v0.7.0). */
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:9931/v1';

/**
 * The refill model the bake-off picked (scripts/i18n/bake-off/results.json,
 * docs/contributing/translations.md): Gemma 4 26B-A4B at Google's q4_0 QAT. Its
 * judge score was within the tie margin of Gemma 4 31B at under a third of the
 * time. Download `file` from the `huggingFace` repo and serve it with:
 *
 *   llama-server -m gemma-4-26B_q4_0-it.gguf -ngl 999 -c 16384 --flash-attn on --jinja
 *
 * llama-server serves one model and ignores the name; Ollama and LM Studio route
 * by it, so pass `--model` with whatever name they gave the model.
 */
export const REFILL_MODEL = {
  name: 'gemma-4-26b-a4b',
  huggingFace: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
  file: 'gemma-4-26B_q4_0-it.gguf',
};
const REQUEST_TIMEOUT_MS = 15 * 60_000;

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function chatUsage(json, wallMs) {
  return {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    costUsd: 0,
    durationMs: wallMs,
  };
}

/** The masked English an item asks for, per form key (`text` for a text item). */
function itemSources(item) {
  if (typeof item.text === 'string') return { text: item.text };
  const sources = {};
  for (const key of item.write) sources[key] = item.forms[key] ?? item.englishFor?.[key] ?? item.forms.other;
  return sources;
}

/** Catalog locales TranslateGemma's chat template spells differently: it has `zh-Hans`, not `zh-CN`. */
const TRANSLATEGEMMA_CODES = { 'zh-CN': 'zh-Hans' };

/**
 * TranslateGemma's one-string prompt, rendered exactly as its chat template
 * renders it. The template reads the language codes from extra fields on the
 * message's content part, and llama-server's chat endpoint drops those fields
 * (the model then translated into English), so this goes to llama.cpp's raw
 * `/completion` endpoint instead, which adds the BOS token itself.
 */
export function translateGemmaPrompt(text, locale) {
  const targetCode = TRANSLATEGEMMA_CODES[locale] ?? locale;
  const names = new Intl.DisplayNames(['en'], { type: 'language' });
  const target = names.of(targetCode.split('-')[0]);
  return '<start_of_turn>user\n'
    + `You are a professional English (en) to ${target} (${targetCode}) translator. Your goal is to accurately convey the meaning and `
    + `nuances of the original English text while adhering to ${target} grammar, vocabulary, and cultural sensitivities.\n`
    + `Produce only the ${target} translation, without any additional explanations or commentary. Please translate the following English text into ${target}:\n\n\n`
    + `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}

export function createOpenAiCompatibleEngine({ url = DEFAULT_LOCAL_URL, model = REFILL_MODEL.name, promptStyle = 'instructed', temperature = 0.2 }) {
  const base = url.replace(/\/$/, '');
  const endpoint = `${base}/chat/completions`;
  // llama.cpp's native endpoint sits beside /v1, not under it.
  const completionEndpoint = `${base.replace(/\/v1$/, '')}/completion`;
  return {
    name: `local:${model}`,
    async translateBatch({ locale, items }) {
      const started = performance.now();
      if (promptStyle === 'translategemma') {
        const replies = new Map();
        const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
        for (const item of items) {
          const translated = {};
          for (const [key, source] of Object.entries(itemSources(item))) {
            const json = await postJson(completionEndpoint, {
              prompt: translateGemmaPrompt(source, locale),
              n_predict: 1024,
              temperature: 0,
              stop: ['<end_of_turn>'],
            });
            translated[key] = String(json.content ?? '').trim();
            usage.inputTokens += json.tokens_evaluated ?? 0;
            usage.outputTokens += json.tokens_predicted ?? 0;
          }
          replies.set(item.key, typeof item.text === 'string' ? { key: item.key, text: translated.text } : { key: item.key, forms: translated });
        }
        usage.durationMs = performance.now() - started;
        return { replies, usage };
      }
      const json = await postJson(endpoint, {
        model,
        messages: [
          { role: 'system', content: systemPrompt(locale) },
          { role: 'user', content: userPrompt(items) },
        ],
        temperature,
        response_format: { type: 'json_schema', json_schema: { name: 'translations', strict: true, schema: REPLY_SCHEMA } },
        // A reasoning model answers faster, and as well for UI strings, without thinking first.
        chat_template_kwargs: { enable_thinking: false },
      });
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('the server returned no message content');
      return { replies: readReplies(content), usage: chatUsage(json, performance.now() - started) };
    },
    close() {},
  };
}
