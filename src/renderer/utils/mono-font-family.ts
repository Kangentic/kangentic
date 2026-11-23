/**
 * The app's monospace stack, `--font-mono`, resolved to the font-family string a consumer that
 * does not read CSS takes (Monaco measures and draws from its `fontFamily` option).
 *
 * Without it Monaco drew in its own per-OS default (Consolas on Windows, Menlo on macOS, Droid
 * Sans Mono on Linux) while every other monospace text in the app, the blame gutter inside the
 * same editor included, drew from `--font-mono`. In the web demo that variable leads with the face
 * the demo ships, so the diff's line numbers and code measured differently on every visitor's OS
 * from the Linux-shot posters (v0.62.0's poster gate).
 */
export function monoFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value.length > 0 ? value : 'monospace';
}
