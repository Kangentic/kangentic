/**
 * Whether motion is off: the app's Animations setting (Settings > Performance,
 * which puts `.no-motion` on `<html>`) or the system's reduced motion. Read at
 * the moment a motion would start, so a change to either applies to the next one.
 */
export function motionReduced(): boolean {
  return document.documentElement.classList.contains('no-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
