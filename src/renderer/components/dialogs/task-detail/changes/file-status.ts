import { Plus, Pencil, Minus, ArrowRight, Copy, FileQuestion } from 'lucide-react';
import { msg } from '@lingui/core/runtime-macro';
import type { GitDiffStatus } from '../../../../../shared/types';
import type { LocalizedText } from '../../../../../shared/i18n/text';

/**
 * How a changed file's status reads: its icon, tone and name. One table for
 * the Changes tree, the diff viewer's header and a completed task's Files
 * changed card, so a status looks the same wherever a file is listed. The label
 * is a descriptor, resolved with `translateText` where it renders.
 */
export const FILE_STATUS_CONFIG: Record<GitDiffStatus, { icon: typeof Plus; colorClass: string; label: LocalizedText }> = {
  A: { icon: Plus, colorClass: 'text-green-400', label: msg({ message: 'Added', context: 'file status' }) },
  M: { icon: Pencil, colorClass: 'text-modified', label: msg({ message: 'Modified', context: 'file status' }) },
  D: { icon: Minus, colorClass: 'text-red-400', label: msg({ message: 'Deleted', context: 'file status' }) },
  R: { icon: ArrowRight, colorClass: 'text-blue-400', label: msg({ message: 'Renamed', context: 'file status' }) },
  C: { icon: Copy, colorClass: 'text-blue-400', label: msg({ message: 'Copied', context: 'file status' }) },
  U: { icon: FileQuestion, colorClass: 'text-green-300', label: msg({ message: 'Untracked', context: 'file status' }) },
};
