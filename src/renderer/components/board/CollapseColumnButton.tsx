import React from 'react';
import { FoldHorizontal } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { Tooltip } from '../Tooltip';

/**
 * The column header's Collapse button (#1056): folds the column to a strip for
 * this user, in this project (`setColumnCollapsed`). It sits where the
 * automation count used to, always visible, and its click never reaches the
 * header's own (which opens the Column Manager).
 */
export function CollapseColumnButton({ swimlaneId, columnName }: { swimlaneId: string; columnName: string }) {
  const { t } = useLingui();
  const setColumnCollapsed = useConfigStore((state) => state.setColumnCollapsed);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  if (!projectId) return null;
  return (
    <Tooltip label={t`Collapse column`}>
      <button
        type="button"
        data-testid="collapse-column-btn"
        aria-label={t`Collapse ${columnName} column`}
        onClick={(event: React.MouseEvent) => {
          event.stopPropagation();
          setColumnCollapsed(projectId, swimlaneId, true);
        }}
        className="flex-shrink-0 p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
      >
        <FoldHorizontal size={12} />
      </button>
    </Tooltip>
  );
}
