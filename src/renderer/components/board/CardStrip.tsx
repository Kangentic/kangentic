import React from 'react';
import type { AppConfig } from '../../../shared/types';

/**
 * The strip across the top of a card, shared by every strip so they cannot
 * drift: a workflow task's (its workflow and step track), the Workflows
 * canvas card's (its board and step track), and a task whose column
 * automations are disabled. One shape means one thing on the board: something
 * outside the column holds this card.
 *
 * Forwards every div attribute, so a Tooltip can wrap it directly.
 */
export function CardStrip({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`h-[29px] px-2.5 flex items-center justify-between gap-2 border-b border-edge bg-surface/30 shrink-0 ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

/**
 * The wrapper that bleeds a board card's strip to the card's edges and rounds
 * its top corners into the card's: it cancels the frame's padding, which
 * comfortable density makes larger (`taskCardFrameClass`).
 */
export function cardStripBleedClass(density: AppConfig['cardDensity']): string {
  return `${density === 'comfortable' ? '-mx-3 -mt-3' : '-mx-2.5 -mt-2.5'} mb-2 rounded-t-[5px] overflow-hidden`;
}
