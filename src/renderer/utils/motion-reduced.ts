/**
 * Whether motion is off: the app's Animations setting (Settings > Performance,
 * which puts `.no-motion` on `<html>`) or the system's reduced motion. Read at
 * the moment a motion would start, so a change to either applies to the next one.
 * With no document (a unit test of a scene module), motion is off.
 *
 * In the desktop app the media query never matches, since main forces Chromium's
 * no-preference switch (src/main/index.ts), so there the setting alone decides.
 * The query is for the web build, where a visitor's own preference holds.
 */
export function motionReduced(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.classList.contains('no-motion')) return true;
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
