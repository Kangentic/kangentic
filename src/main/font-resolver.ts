import { getFonts2 } from 'font-list';
import { createCachedSingleton } from './shared/cached-singleton';

// Installed fonts do not change within a session, and enumeration shells out
// to an OS-specific command (fc-list on Linux, a PowerShell script on
// Windows, a bundled binary on macOS). Cache the result once per FontResolver
// instance's lifetime; a restart re-probes.
const availableFontsCache = createCachedSingleton<string[]>();

/** Test-only: clear the cached font list between cases. */
export function resetFontResolverCacheForTests(): void {
  availableFontsCache.invalidate();
}

export class FontResolver {
  async getAvailableFonts(): Promise<string[]> {
    return availableFontsCache.get(() => this.computeAvailableFonts());
  }

  private async computeAvailableFonts(): Promise<string[]> {
    try {
      const fonts = await getFonts2({ disableQuoting: true });
      const monospaceFamilies = this.dedupedSorted(fonts.filter((font) => font.monospace).map((font) => font.familyName));
      // The monospace heuristic (family-name keyword matching, plus a glyph-width
      // check on Windows) can under-detect on an unusual font set. Fall back to
      // every installed family rather than leaving the picker empty.
      if (monospaceFamilies.length > 0) return monospaceFamilies;
      return this.dedupedSorted(fonts.map((font) => font.familyName));
    } catch {
      // e.g. fc-list missing on a minimal Linux install. The renderer falls
      // back to free-typed entry when this list is empty.
      return [];
    }
  }

  private dedupedSorted(families: string[]): string[] {
    return Array.from(new Set(families.filter((family) => family.trim().length > 0))).sort((first, second) =>
      first.localeCompare(second),
    );
  }
}
