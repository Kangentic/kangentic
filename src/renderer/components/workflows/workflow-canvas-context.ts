import { createContext } from 'react';
import type { WorkflowDetail } from '../../../shared/types';

/**
 * The workflow on the canvas, for the parts of a card that judge a link while
 * one is being drawn (the hint over the card under the pointer). Its own
 * module, so the node and the canvas import it without importing each other.
 */
export const WorkflowDetailContext = createContext<WorkflowDetail | null>(null);
