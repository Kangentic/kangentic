import React from 'react';

/**
 * The Workflows empty state's picture of what a workflow is (Final 7), drawn
 * again over an empty workflow's canvas above its three steps (sign-off 10):
 * four small cards linked left to right, the first done, two running, one
 * waiting, joined by curves in the canvas's link colors (green once the
 * blocker is done, grey while it still holds a task back).
 *
 * One of the four files `ui-conventions.md` exempts from its no-inline-SVG
 * rule. The curves and the cards are a drawing, not an icon, so no lucide
 * glyph can stand in for them. Every color is a theme token, so it follows
 * light themes too. It is static on purpose: the empty state is a place to
 * start, not a demo, so nothing in it moves.
 */

type MiniCardState = 'done' | 'running' | 'waiting';

interface MiniCard {
  x: number;
  y: number;
  state: MiniCardState;
  /** The column color the card's dot and step bar wear. */
  tone: string;
}

const MINI_CARD_WIDTH = 104;
const MINI_CARD_HEIGHT = 48;

const MINI_CARDS: readonly MiniCard[] = [
  { x: 0, y: 38, state: 'done', tone: 'var(--color-active)' },
  { x: 140, y: 2, state: 'running', tone: 'var(--color-chart-1)' },
  { x: 140, y: 74, state: 'running', tone: 'var(--color-chart-3)' },
  { x: 280, y: 38, state: 'waiting', tone: 'var(--color-fg-faint)' },
];

/** From each card's right edge to the next one's left, at the height of its title row. */
const MINI_LINKS: ReadonlyArray<{ path: string; satisfied: boolean }> = [
  { path: 'M 104 62 C 122 62, 122 26, 140 26', satisfied: true },
  { path: 'M 104 62 C 122 62, 122 98, 140 98', satisfied: true },
  { path: 'M 244 26 C 262 26, 262 58, 280 58', satisfied: false },
  { path: 'M 244 98 C 262 98, 262 66, 280 66', satisfied: false },
];

function MiniCardShape({ card }: { card: MiniCard }) {
  const done = card.state === 'done';
  return (
    <g transform={`translate(${card.x} ${card.y})`} data-illustration-card={card.state}>
      {/* Half a pixel in, so the 1px edge lands on whole pixels. */}
      <rect
        x={0.5}
        y={0.5}
        width={MINI_CARD_WIDTH - 1}
        height={MINI_CARD_HEIGHT - 1}
        rx={6}
        fill="var(--color-surface-raised)"
        stroke={done ? 'var(--color-active)' : 'var(--color-edge)'}
        strokeOpacity={done ? 0.8 : 1}
        data-illustration-frame=""
      />
      <line x1={1} x2={MINI_CARD_WIDTH - 1} y1={16} y2={16} stroke="var(--color-edge)" strokeWidth={0.5} />
      <circle cx={12} cy={8} r={3.5} fill={card.tone} />
      <rect x={22} y={6} width={34} height={4} rx={2} fill="var(--color-fg-disabled)" />
      <rect x={74} y={6} width={20} height={4} rx={2} fill={card.tone} opacity={0.7} />
      <rect x={10} y={24} width={70} height={5} rx={2.5} fill="var(--color-fg-faint)" opacity={0.55} />
      <rect x={10} y={35} width={48} height={4} rx={2} fill="var(--color-fg-disabled)" opacity={0.6} />
    </g>
  );
}

export function NoWorkflowsIllustration() {
  return (
    <svg
      width={388}
      height={124}
      viewBox="0 0 388 124"
      className="shrink-0"
      aria-hidden="true"
      data-testid="workflows-empty-illustration"
    >
      {MINI_LINKS.map((link) => (
        <path
          key={link.path}
          d={link.path}
          fill="none"
          // The canvas's own link colors and strengths (WorkflowEdge).
          stroke={link.satisfied ? 'var(--color-active)' : 'var(--color-fg-faint)'}
          strokeOpacity={link.satisfied ? 0.45 : 0.7}
          strokeWidth={1.5}
          strokeLinecap="round"
          data-illustration-link={link.satisfied ? 'satisfied' : 'pending'}
        />
      ))}
      {MINI_CARDS.map((card) => <MiniCardShape key={`${card.x}:${card.y}`} card={card} />)}
    </svg>
  );
}
