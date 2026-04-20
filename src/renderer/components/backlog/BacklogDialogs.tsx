import { useCallback } from 'react';
import { NewBacklogTaskDialog } from './NewBacklogTaskDialog';
import { ImportDialog } from './ImportDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';

/**
 * Hosts all backlog-scoped dialogs. Subscribes only to the dialog-state slots
 * in backlog-store, so opening/closing a dialog does not re-render the backlog
 * list, and items churn does not re-render closed dialog subtrees. Mirrors the
 * BoardDialogs pattern.
 */
export function BacklogDialogs() {
  const showNewDialog = useBacklogStore((state) => state.showNewDialog);
  const editingItem = useBacklogStore((state) => state.editingItem);
  const pendingDeleteId = useBacklogStore((state) => state.pendingDeleteId);
  const pendingBulkDelete = useBacklogStore((state) => state.pendingBulkDelete);
  const importSource = useBacklogStore((state) => state.importSource);
  // Only subscribe to the size of the selection, not the Set itself, so that
  // selection churn that keeps size constant doesn't re-render the dialogs.
  const selectedCount = useBacklogStore((state) => state.selectedIds.size);

  const closeNewDialog = useBacklogStore((state) => state.closeNewDialog);
  const setEditingItem = useBacklogStore((state) => state.setEditingItem);
  const setPendingDeleteId = useBacklogStore((state) => state.setPendingDeleteId);
  const setPendingBulkDelete = useBacklogStore((state) => state.setPendingBulkDelete);
  const setImportSource = useBacklogStore((state) => state.setImportSource);

  const createItem = useBacklogStore((state) => state.createItem);
  const updateItem = useBacklogStore((state) => state.updateItem);
  const deleteItem = useBacklogStore((state) => state.deleteItem);
  const bulkDelete = useBacklogStore((state) => state.bulkDelete);

  const updateConfig = useConfigStore((state) => state.updateConfig);

  const handleConfirmDelete = useCallback((dontAskAgain: boolean) => {
    if (pendingDeleteId) {
      deleteItem(pendingDeleteId);
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, deleteItem, updateConfig, setPendingDeleteId]);

  const handleConfirmBulkDelete = useCallback((dontAskAgain: boolean) => {
    const ids = [...useBacklogStore.getState().selectedIds];
    bulkDelete(ids);
    if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    setPendingBulkDelete(false);
  }, [bulkDelete, updateConfig, setPendingBulkDelete]);

  const handleCloseEdit = useCallback(() => {
    setEditingItem(null);
  }, [setEditingItem]);

  const handleCloseImport = useCallback(() => {
    setImportSource(null);
  }, [setImportSource]);

  const handleCancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, [setPendingDeleteId]);

  const handleCancelBulkDelete = useCallback(() => {
    setPendingBulkDelete(false);
  }, [setPendingBulkDelete]);

  return (
    <>
      {showNewDialog && (
        <NewBacklogTaskDialog
          onClose={closeNewDialog}
          onCreate={createItem}
        />
      )}

      {editingItem && (
        <NewBacklogTaskDialog
          onClose={handleCloseEdit}
          onCreate={createItem}
          editTask={editingItem}
          onUpdate={updateItem}
        />
      )}

      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete backlog task"
          message={<>
            <p>This will permanently delete the backlog task.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {pendingBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedCount} backlog tasks`}
          message={<>
            <p>This will permanently delete {selectedCount} backlog tasks.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel={`Delete ${selectedCount} items`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmBulkDelete}
          onCancel={handleCancelBulkDelete}
        />
      )}

      {importSource && (
        <ImportDialog
          source={importSource}
          onClose={handleCloseImport}
        />
      )}
    </>
  );
}
