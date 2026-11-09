/**
 * The label and priority parameters every MCP tool that writes them shares, so
 * the task, backlog and workflow tools describe them the same way and none of
 * them hardcodes a scale the user can change.
 */
import { z } from 'zod/v4';
import { describeLabelPalette, HEX_LABEL_COLOR } from '../../../shared/label-palette';

/** One label: a plain name, or a name with a hex color from the palette. */
export const LABEL_ENTRY_SCHEMA = z.union([
  z.string(),
  z.object({
    name: z.string(),
    color: z.string().regex(HEX_LABEL_COLOR).describe('Hex color, one of the label palette.'),
  }),
]);

/**
 * How a label is passed and colored, appended to each tool's own sentence about
 * its labels. Built from the shared palette, so it names exactly the swatches the
 * Labels editor offers.
 */
export const LABEL_ENTRY_GUIDE =
  'Each entry is a plain name or { name, color } (e.g. ["bug", { "name": "frontend", "color": "#3b82f6" }]). '
  + `To color a label, pick from the label palette: ${describeLabelPalette()}. `
  + 'A plain name leaves a label uncolored, and passing an existing label as a plain name keeps the color it already has. '
  + 'Use kangentic_board_summary to see the labels this board already uses and their colors, and reuse one rather than inventing a near-duplicate.';

/** A priority: an index into the project's own scale, which the handler checks. */
export const PRIORITY_SCHEMA = z.number().int().min(0);

export const PRIORITY_GUIDE =
  'An index into this project\'s priority scale, which the user can rename and extend: kangentic_board_summary lists it. '
  + '0 is the bottom entry (none by default, shown as nothing on a card); a higher number is a more urgent level. '
  + 'A number past the end of the scale is refused with the scale listed.';
