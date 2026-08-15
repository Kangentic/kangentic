/**
 * Pixel budget for images handed to an agent, shared by the main process
 * (terminal Ctrl+V paste) and the renderer (task/backlog attachment paste).
 *
 * Lives in `src/shared/` because main cannot import from `src/renderer/`, and both
 * paths must cap by the same rule or a pasted screenshot would mean two different
 * things depending on where it was dropped.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A FIDELITY FLOOR, NOT A TOKEN OPTIMIZATION
 * ---------------------------------------------------------------------------
 *
 * Vision cost is a function of pixel AREA, not file bytes, so re-encoding (WebP or
 * JPEG quality, grayscale, palette reduction, PNG optimization) shrinks the file
 * and costs the model exactly the same. That makes downscaling look like the one
 * real lever. It is not, and the reason is worth writing down, because the idea
 * keeps looking attractive.
 *
 * FIRST: a clamp upstream is already doing the capping. One procedural scene
 * emitted at eight resolutions, one `claude -p` run each, comparing TOTAL input
 * tokens (`inputTokens + cacheCreation + cacheRead`; the individual cache buckets
 * are useless alone, since a repeat flips a cacheCreation into a cacheRead and the
 * delta inverts). "predicted" is area/750 relative to the 1000px row:
 *
 *   long edge   size        area     vs 1000px   predicted
 *        1000   1000x563   0.56MP           -           -
 *        1568   1568x882   1.38MP      +1,052      +1,093
 *        1984   1984x1116  2.21MP      +2,113      +2,202
 *        2100   2100x1181  2.48MP      +2,248      +2,556
 *        2400   2400x1350  3.24MP      +2,266      +3,569
 *        3400   3400x1913  6.50MP      +2,252      +7,922
 *
 * Cost tracks area/750 up through 1984px, then every rung from 2100 to 3400 lands
 * on the same ~+2,250 plateau (the +-25 spread is run-to-run noise). Something
 * normalizes above roughly 2.25MP, about 2000px on the long edge at 16:9. A 4K
 * paste and a 2000px paste therefore cost the SAME. There is no token saving to be
 * had above this line.
 *
 * SECOND: below it, the agent gets details wrong without ever saying so. A
 * 2560x1440 dark UI was rendered at Kangentic's real type sizes (11px labels, 12px
 * monospace) with twelve probes - six text, six non-text affordances at realistic
 * sizes (a 6px status dot, a 12px checkbox, a 14px icon, a 1px underline, three bar
 * heights, a diff gutter marker). It was downscaled and the agent asked to answer
 * all twelve with NO option to decline, so every miss is a silent error - the
 * failure that reaches users, not a refusal. 84 probes per rung:
 *
 *   long edge   silent-wrong   what actually broke
 *        2000        0 / 84    nothing
 *        1568       11 / 84    branch hash "feat/b6d09fa" read as "feat/b6dd9f6"
 *                              (6 of 7 attempts); "which bar is tallest" answered
 *                              right instead of middle (5 of 7)
 *
 * That second row is not low confidence and not a transcription wobble. It is a
 * confident, specific, wrong answer about both text and non-text detail. An
 * earlier version of this measurement scored 41/42 at 1568 - but it probed only
 * text, and it told the model it could answer ILLEGIBLE. Both concessions hid the
 * real failure.
 *
 * So the cap below is chosen to be free (the clamp discards everything above it)
 * AND clean (0/84). Lowering it to buy tokens buys wrong answers instead, which is
 * also why there is deliberately no user-facing setting: a dial here would only
 * offer someone a way to make their own screenshots worse.
 *
 * This path shipped 1568 for a long time on a comment claiming it matched "the
 * API's own downscale". It did not, and it was quietly costing accuracy.
 */

/**
 * Long-edge cap, in pixels, for any image on its way to an agent.
 *
 * Sits at the knee: high enough that nothing the model would have used is
 * discarded, low enough to bound the temp file and the base64 IPC payload a raw
 * 4K or 5K screenshot would otherwise carry.
 *
 * Note what is and is not measured AT this number. The cost table brackets it
 * rather than landing on it - 1984 still tracks area, 2100 is already on the
 * plateau - so 2000 is interpolated between those two rungs, not a measured cost
 * point. The ACCURACY probes below were run at exactly 2000 (0 of 84 silent
 * errors), so the fidelity half of the choice is measured directly.
 */
export const IMAGE_LONG_EDGE_CAP = 2000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Target dimensions to fit `longEdge`, preserving aspect ratio.
 *
 * Returns null for BOTH of these, deliberately:
 *   - the image already fits, so callers can skip the resize (and, on the
 *     attachment path, skip a lossy re-encode) rather than paying a no-op scale
 *     of 1;
 *   - the dimensions are malformed (non-finite, zero, or negative).
 *
 * Every caller's correct response to either case is the same - leave the image
 * alone - so they are one return value rather than two. A caller that needs to
 * reject malformed input must probe the dimensions itself; do not read null as
 * "already fits".
 */
export function resolveResizeTarget(
  width: number,
  height: number,
  longEdge: number = IMAGE_LONG_EDGE_CAP,
): ImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const currentLongEdge = Math.max(width, height);
  if (currentLongEdge <= longEdge) return null;

  const scale = longEdge / currentLongEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
