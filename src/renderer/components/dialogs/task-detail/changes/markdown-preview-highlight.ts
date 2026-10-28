import { loader } from '@monaco-editor/react';

/** What colorizing a fence needs to know about one of monaco's registered languages. */
interface MonacoLanguageEntry {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

/**
 * Monaco's language id for a markdown fence's info string: an id (`typescript`),
 * an alias (`TypeScript`, `ts`), or a file extension (`ts` for `.ts`), in that
 * order of preference. Null for a fence monaco has no tokenizer for.
 */
export function monacoLanguageForFence(languages: MonacoLanguageEntry[], fence: string): string | null {
  const wanted = fence.trim().toLowerCase();
  if (wanted === '') return null;
  const byId = languages.find((language) => language.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const byAlias = languages.find((language) => language.aliases?.some((alias) => alias.toLowerCase() === wanted));
  if (byAlias) return byAlias.id;
  const byExtension = languages.find((language) => language.extensions?.some((extension) => extension.toLowerCase() === `.${wanted}`));
  return byExtension ? byExtension.id : null;
}

/**
 * Colorized HTML for one fenced block of the markdown preview, from the monaco
 * instance the Changes panel already loads (monacoConfig.ts hands it to the
 * loader). Theme first: the theme is global to the window, and while the
 * preview shows the DiffEditor that normally applies it is unmounted, so an
 * app theme change would otherwise leave the token colors on the old theme.
 */
export async function colorizeFencedCode(code: string, fence: string, monacoTheme: 'vs' | 'vs-dark'): Promise<string | null> {
  const monaco = await loader.init();
  const languageId = monacoLanguageForFence(monaco.languages.getLanguages(), fence);
  if (languageId === null) return null;
  monaco.editor.setTheme(monacoTheme);
  return monaco.editor.colorize(code, languageId, {});
}
