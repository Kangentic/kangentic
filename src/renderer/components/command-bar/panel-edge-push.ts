/**
 * The rail's width is the Command Terminal panel's own: the rail is part of the
 * panel, so widening, narrowing, folding or opening it changes the panel's width
 * by the same amount and leaves the terminals their size. The panel owns its box,
 * so it hands out the change: a session resizes the panel's width from where it
 * stood when the change began, its left edge held, as far as the area allows. A
 * change with no pointer to follow (the rail's fold button) may also grow to the
 * left once the right edge reaches the area's. Nothing provides it where there is
 * no panel to resize (the detached window), and a maximized panel refuses it;
 * there the terminals give the rail its room, as they always did.
 */

import { createContext, useContext } from 'react';

export interface PanelWidthSession {
  /** Set the panel's width to its starting width plus `delta`, as far as the area allows. Returns the change the area allowed. */
  resize(delta: number): number;
  /** Keep the box and save it as the panel's place. */
  commit(): void;
  /** Put the panel back where the change found it. */
  cancel(): void;
}

export interface PanelWidthChange {
  /**
   * Start a change of the panel's width, or null when the panel cannot change
   * (maximized). `spillLeft` lets growth the right edge cannot take move the
   * left edge instead, for a change no pointer follows.
   */
  begin(options?: { spillLeft?: boolean }): PanelWidthSession | null;
}

export const PanelWidthContext = createContext<PanelWidthChange | null>(null);

/** The panel's width change, or null where there is no panel (the detached window). */
export function usePanelWidthChange(): PanelWidthChange | null {
  return useContext(PanelWidthContext);
}
