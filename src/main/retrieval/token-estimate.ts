/**
 * Cheap token estimate. We never tokenize for real in the chunker (that would
 * need the model's tokenizer, which lives in the embed worker). The chars/4
 * heuristic is the standard rough proxy and is intentionally conservative so
 * chunks stay comfortably under the MiniLM ~512-token window.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
