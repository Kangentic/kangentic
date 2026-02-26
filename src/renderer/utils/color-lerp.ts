/** Interpolate between color stops: green(0-75%) → yellow(95%) → amber(98%) → orange(100%). */
const STOPS: [number, [number, number, number]][] = [
  [0,   [74, 222, 128]],   // green-400
  [75,  [74, 222, 128]],   // green-400 (hold green)
  [95,  [234, 179, 8]],    // yellow-500
  [98,  [245, 158, 11]],   // amber-500
  [100, [249, 115, 22]],   // orange-500 (clamp)
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
