/**
 * Marks part of a window where a press must not send focus to the window's
 * terminal, as a press on window chrome does (`WindowFrame`). A Browser pane
 * sets it on its drawing canvas, and on its toolbar while Draw is on, so focus
 * stays on the note beside the drawing.
 */
export const KEEPS_PANE_FOCUS_ATTRIBUTE = 'data-keeps-pane-focus';
