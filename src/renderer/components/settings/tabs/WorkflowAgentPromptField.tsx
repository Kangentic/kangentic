import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, RotateCcw, Workflow as WorkflowIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { TemplateTextField, type TemplateTextFieldInsert } from '../../TemplateTextField';
import { TemplateVariablePicker } from '../../TemplateVariablePicker';
import { Pill } from '../../Pill';
import { BaseDialog, DialogFooterActions } from '../../dialogs/BaseDialog';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from '../../dialogs/dialog-maximize';
import { useKeybinding } from '../../../hooks/useKeybinding';
import { DEFAULT_WORKFLOW_AGENT_PROMPT } from '../../../../shared/workflow-agent-prompt';

/**
 * Settings > Workflows' Workflow agent prompt: the whole first message a new
 * workflow's agent gets (#732, board 5b). A fixed 15 rows in the card, editable
 * in place and saved when it loses focus, and the same field in a larger editor
 * behind the card's Expand.
 */

/** Rows the field shows in the card: the default prompt's opening fits, and the card never changes height. */
const PROMPT_ROWS = 15;

/** The field, with Template variable at its left and Reset to default at its right, under it. */
export function WorkflowAgentPromptField({ value, onChange, onBlur, onReset, fill = false, testId }: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onReset: () => void;
  /** Fill the editor dialog's body instead of the card's fixed rows. */
  fill?: boolean;
  testId: string;
}) {
  const { t } = useLingui();
  const insertRef = useRef<TemplateTextFieldInsert | null>(null);
  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex flex-col gap-2'}>
      <TemplateTextField
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        context="workflow"
        testId={testId}
        rows={PROMPT_ROWS}
        fill={fill}
        ariaLabel={t`Workflow agent prompt`}
        insertRef={insertRef}
      />
      <div className="flex items-center justify-between gap-3">
        <TemplateVariablePicker
          context="workflow"
          onInsert={(chip) => insertRef.current?.(chip)}
          testId={`${testId}-variable`}
        />
        <Pill
          size="sm"
          onClick={onReset}
          className="text-fg-muted bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-secondary transition-colors"
          data-testid={`${testId}-reset`}
        >
          <RotateCcw size={14} /> <Trans>Reset to default</Trans>
        </Pill>
      </div>
    </div>
  );
}

/**
 * The card's field: a draft of the stored prompt, written back when it loses
 * focus, and on unmount, since closing Settings with Escape removes a focused
 * field with no blur. The caller keys it by the stored text, so a save from the
 * editor dialog remounts it on the new value.
 */
export function WorkflowAgentPromptSetting({ stored, onSave }: { stored: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(stored);
  const pendingRef = useRef<string | null>(null);
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);
  useEffect(() => () => {
    if (pendingRef.current !== null) saveRef.current(pendingRef.current);
  }, []);

  const handleChange = useCallback((next: string) => {
    setDraft(next);
    pendingRef.current = next === stored ? null : next;
  }, [stored]);

  const handleBlur = useCallback(() => {
    if (pendingRef.current === null) return;
    const next = pendingRef.current;
    pendingRef.current = null;
    onSave(next);
    // A blank prompt saves as unset, which sends the default. When the stored
    // text was already the default nothing remounts the field, so show the
    // default it falls back to rather than an empty field.
    if (!next.trim()) setDraft(DEFAULT_WORKFLOW_AGENT_PROMPT);
  }, [onSave]);

  const handleReset = useCallback(() => {
    pendingRef.current = null;
    setDraft(DEFAULT_WORKFLOW_AGENT_PROMPT);
    onSave(DEFAULT_WORKFLOW_AGENT_PROMPT);
  }, [onSave]);

  return (
    <WorkflowAgentPromptField
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      onReset={handleReset}
      testId="workflow-agent-prompt"
    />
  );
}

/** The card header's Expand: the same prompt, larger. */
export function WorkflowAgentPromptExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="workflow-agent-prompt-expand"
      className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-edge-input bg-surface-control px-2.5 py-1 text-xs text-fg-secondary transition-colors hover:border-accent/50 hover:text-fg"
    >
      <Maximize2 size={13} aria-hidden="true" />
      <Trans>Expand</Trans>
    </button>
  );
}

/**
 * The editor: a copy of the prompt, centered on the window over its own
 * backdrop, the New Backlog Task dialog's size. Save writes the copy, Cancel
 * throws it away, and a close gesture while it differs asks first. `z-[60]`, as
 * every dialog a Settings tab opens is, over the Settings drawer.
 */
export function WorkflowAgentPromptDialog({ initial, onSave, onClose }: {
  initial: string;
  onSave: (next: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(initial);
  const [isMaximized, setMaximized] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = draft !== initial;
  const toggleMaximized = useCallback(() => setMaximized((current) => !current), []);
  const saveAndClose = (): void => {
    onSave(draft);
    onClose();
  };
  const handleCloseAttempt = useCallback(() => {
    if (confirmDiscard) return false;
    if (dirty) {
      setConfirmDiscard(true);
      return false;
    }
    return true;
  }, [confirmDiscard, dirty]);

  useKeybinding('panel.maximize', toggleMaximized, { capture: true, stopPropagation: true, preventDefault: true });
  useKeybinding('panel.close', () => { if (handleCloseAttempt()) onClose(); }, { capture: true, stopPropagation: true, preventDefault: true });

  const { dialogClassName, backdropPositionClass, backdropClassName, contentRadiusClass } =
    maximizedDialogLayout(isMaximized, 'w-[840px] max-w-[90vw] h-[80vh]');

  // Portaled to the body: the Settings drawer animates in with a transform, which
  // makes it the containing block of every `fixed` descendant, so rendered in
  // place this dialog was laid out inside the 720px drawer instead of centered
  // on the window. `data-settings-layer` tells the drawer a dialog of its own is
  // open, so the drawer leaves Escape to it.
  return createPortal(
    <div data-settings-layer>
      <BaseDialog
        onClose={onClose}
        onCloseRequest={handleCloseAttempt}
        onHeaderDoubleClick={toggleMaximized}
        title={t`Workflow agent prompt`}
        icon={<WorkflowIcon size={16} className="text-fg-muted" />}
        headerRight={<MaximizeToggleButton isMaximized={isMaximized} onToggle={toggleMaximized} />}
        className={dialogClassName}
        backdropPositionClass={backdropPositionClass}
        backdropClassName={backdropClassName}
        contentRadiusClass={contentRadiusClass}
        zIndex="z-[60]"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        testId="workflow-agent-prompt-dialog"
        // Opened over the Settings panel, so it is the topmost overlay and takes Ctrl+S.
        save={{ onSave: saveAndClose }}
        footer={
          <DialogFooterActions
            onCancel={onClose}
            onConfirm={saveAndClose}
            confirmLabel={t`Save`}
            cancelTestId="workflow-agent-prompt-dialog-cancel"
            confirmTestId="workflow-agent-prompt-dialog-save"
          />
        }
      >
        <WorkflowAgentPromptField
          value={draft}
          onChange={setDraft}
          onReset={() => setDraft(DEFAULT_WORKFLOW_AGENT_PROMPT)}
          fill
          testId="workflow-agent-prompt-dialog-field"
        />
      </BaseDialog>
      {confirmDiscard && (
        <ConfirmDialog
          title={t`Discard unsaved changes?`}
          variant="warning"
          confirmLabel={t`Discard`}
          cancelLabel={t`Keep editing`}
          message={t`Closing now will discard your edits to the workflow agent prompt.`}
          onConfirm={() => { setConfirmDiscard(false); onClose(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>,
    document.body,
  );
}
