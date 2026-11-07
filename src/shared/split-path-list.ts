/**
 * Split a comma-separated list of paths and glob patterns as a settings field
 * holds it, trimmed, with empty entries dropped. A comma inside braces belongs
 * to the glob, so `*.{local,dev}.json` stays one entry.
 */
export function splitPathList(text: string): string[] {
  const entries: string[] = [];
  let braceDepth = 0;
  let current = '';
  for (const character of text) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (character === ',' && braceDepth === 0) {
      entries.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}
