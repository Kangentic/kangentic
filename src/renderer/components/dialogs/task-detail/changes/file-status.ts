import { Plus, Pencil, Minus, ArrowRight, Copy, FileQuestion } from 'lucide-react';
import type { GitDiffStatus } from '../../../../../shared/types';

/**
 * How a changed file's status reads: its icon, tone and name. One table for
 * the Changes tree and a completed task's Files changed card, so a status
 * looks the same wherever a file is listed.
 */
export const FILE_STATUS_CONFIG: Record<GitDiffStatus, { icon: typeof Plus; colorClass: string; label: string }> = {
  A: { icon: Plus, colorClass: 'text-green-400', label: 'Added' },
  M: { icon: Pencil, colorClass: 'text-modified', label: 'Modified' },
  D: { icon: Minus, colorClass: 'text-red-400', label: 'Deleted' },
  R: { icon: ArrowRight, colorClass: 'text-blue-400', label: 'Renamed' },
  C: { icon: Copy, colorClass: 'text-blue-400', label: 'Copied' },
  U: { icon: FileQuestion, colorClass: 'text-green-300', label: 'Untracked' },
};
