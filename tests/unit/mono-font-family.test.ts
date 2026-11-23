/**
 * monoFontFamily hands Monaco the app's --font-mono stack, which Monaco cannot read from CSS. The
 * diff editor's line numbers and code draw in whatever it returns, so an empty variable (a
 * document where the stylesheet has not applied) must give a usable family and never an empty
 * string, which Monaco would read as its own per-OS default again.
 *
 * Tier: Unit. Only a stubbed `getComputedStyle` and `document`, nothing the unit tier lacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monoFontFamily } from '../../src/renderer/utils/mono-font-family';

function stubFontMono(value: string): void {
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => (name === '--font-mono' ? value : '') }));
}

describe('monoFontFamily', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the --font-mono stack, trimmed of the whitespace a custom property keeps', () => {
    stubFontMono('  "Kangentic Demo Mono", ui-monospace, monospace\n');
    expect(monoFontFamily()).toBe('"Kangentic Demo Mono", ui-monospace, monospace');
  });

  it('falls back to the generic monospace family when --font-mono is unset or blank', () => {
    stubFontMono('');
    expect(monoFontFamily()).toBe('monospace');
    stubFontMono('   ');
    expect(monoFontFamily()).toBe('monospace');
  });
});
