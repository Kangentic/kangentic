/**
 * The colors the Labels editor offers, in its order. One list for both sides:
 * the renderer's color picker draws these swatches, and the MCP label tools name
 * them to an agent, so an agent that colors a label picks a color a person
 * could have picked. The names are for the agent's eyes only (English, never
 * shown in the UI).
 */
export const LABEL_PALETTE: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#6b7280', name: 'gray' },
  { hex: '#ef4444', name: 'red' },
  { hex: '#f43f5e', name: 'rose' },
  { hex: '#f97316', name: 'orange' },
  { hex: '#f59e0b', name: 'amber' },
  { hex: '#10b981', name: 'green' },
  { hex: '#06b6d4', name: 'cyan' },
  { hex: '#3b82f6', name: 'blue' },
  { hex: '#8b5cf6', name: 'violet' },
  { hex: '#ec4899', name: 'pink' },
  { hex: '#78716c', name: 'stone' },
];

/** A label color as the config stores it: `#` and six hex digits. The MCP schema and the handlers both check it. */
export const HEX_LABEL_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The palette as one line for a tool description: `#6b7280 gray, #ef4444 red, ...`. */
export function describeLabelPalette(): string {
  return LABEL_PALETTE.map((entry) => `${entry.hex} ${entry.name}`).join(', ');
}
