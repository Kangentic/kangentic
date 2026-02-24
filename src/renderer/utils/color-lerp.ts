/** Interpolate between color stops: green(0%) → yellow(50%) → red(75-100%). */
const STOPS: [number, [number, number, number]][] = [
  [0,   [16, 185, 129]],   // emerald-500
  [50,  [234, 179, 8]],    // yellow-500
  [75,  [239, 68, 68]],    // red-500
  [100, [239, 68, 68]],    // red-500 (clamp)
];

export function getProgressColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1][0] < p) i++;
  const [p0, c0] = STOPS[i];
  const [p1, c1] = STOPS[i + 1];
  const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
