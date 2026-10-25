/**
 * The element in a pop-out window's title bar where its surface may put its
 * own actions, beside the window controls (null outside a pop-out, and until
 * the title bar has mounted). A surface portals into it: the Command Terminal's
 * window puts New terminal there, where the panel has it in its header.
 */
import { createContext, useContext } from 'react';

export const PopOutHeaderActionsContext = createContext<HTMLElement | null>(null);

export function usePopOutHeaderActionsSlot(): HTMLElement | null {
  return useContext(PopOutHeaderActionsContext);
}
