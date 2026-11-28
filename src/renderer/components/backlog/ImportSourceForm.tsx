import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderSearch, Info, LoaderCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../Tooltip';
import { OptionalTag } from '../OptionalTag';
import { CountBadge } from '../CountBadge';
import { translateText } from '../../i18n/translate';
import { describeIpcError } from '../../lib/ipc-error';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { useProjectStore } from '../../stores/project-store';
import { getSourceFormTitle } from './import-providers';
import type { Provider, SourceTypeOption } from './import-providers';
import type { RepoFolderListing } from '../../../shared/types';

/** How many Browse rows render at once; typing narrows the rest. */
const BROWSE_ROW_LIMIT = 100;

const FIELD_CLASS = 'w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-muted px-2.5 py-1.5 outline-none focus:border-edge-input';

interface ImportSourceFormProps {
  provider: Provider;
  sourceType: SourceTypeOption;
  /** `add` saves a new source with Connect; `edit` changes a saved one's Label with Save. */
  mode: 'add' | 'edit';
  /** The typed link or folder, or the saved source's. */
  value: string;
  /** Absent: the value is shown read-only (a saved source, or a folder the system dialog picked). */
  onValueChange?: (value: string) => void;
  taskLabel: string;
  onTaskLabelChange: (value: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
  valueInputRef?: React.Ref<HTMLInputElement | HTMLTextAreaElement>;
}

/** An (i) beside a field label; its text is the tip and the button's description. */
function FieldInfo({ about, tip, testId }: { about: string; tip: string; testId: string }) {
  const { t } = useLingui();
  return (
    <Tooltip label={tip}>
      <button
        type="button"
        data-testid={testId}
        aria-label={t`About ${about}`}
        className="flex shrink-0 rounded text-fg-faint hover:text-fg-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent cursor-help"
      >
        <Info size={12} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * The form a source is added or edited with: a header with the back arrow, the
 * link or folder, an optional Label every imported task gets, and one full-width
 * button. A Repository folder source adds Browse, the default branch's folders.
 */
export function ImportSourceForm({
  provider,
  sourceType,
  mode,
  value,
  onValueChange,
  taskLabel,
  onTaskLabelChange,
  busy,
  error,
  onSubmit,
  onBack,
  valueInputRef,
}: ImportSourceFormProps) {
  const { t } = useLingui();
  const fieldLabel = sourceType.fieldLabel ? translateText(sourceType.fieldLabel) : t({ message: 'URL', context: 'import source field' });
  const fieldTip = sourceType.hint ? translateText(sourceType.hint) : '';
  const labelFieldName = t({ message: 'Label', context: 'import source field' });
  const namesFolder = Boolean(sourceType.repoFolder || sourceType.folder);
  const labelTip = namesFolder
    ? t`From the folder name. Put on every task it imports.`
    : sourceType.multiline
      ? t`From the script. Put on every task it imports.`
      : t`From the link. Put on every task it imports.`;
  const editable = mode === 'add' && Boolean(onValueChange);
  // A folder source shows its Label once a folder is named; a link source always does.
  const showLabel = mode === 'edit' || !sourceType.repoFolder || value.trim() !== '';
  const submitLabel = mode === 'edit' ? t({ message: 'Save', context: 'button' }) : t`Connect`;

  const [browseOpen, setBrowseOpen] = useState(false);
  const [listing, setListing] = useState<RepoFolderListing | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const browseSequenceRef = useRef(0);

  const handleBrowse = async () => {
    if (browseOpen) {
      setBrowseOpen(false);
      return;
    }
    setBrowseOpen(true);
    const token = ++browseSequenceRef.current;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const projectId = useProjectStore.getState().currentProject?.id;
      const answer = await window.electronAPI.backlog.repoFoldersList(projectId ? { projectId } : undefined);
      if (browseSequenceRef.current === token) setListing(answer);
    } catch (listError: unknown) {
      // A refusal (no default branch) is a rejection main saw, which the reporter skips.
      reportRendererFailure('backlog', 'import-repo-folders', listError);
      if (browseSequenceRef.current === token) setBrowseError(describeIpcError(listError, t`Couldn't list the folders`));
    } finally {
      if (browseSequenceRef.current === token) setBrowseLoading(false);
    }
  };

  const filterText = value.trim().toLowerCase();
  const shownFolders = useMemo(() => {
    const folders = listing?.folders ?? [];
    const matching = filterText ? folders.filter((folder) => folder.path.toLowerCase().includes(filterText)) : folders;
    return matching.slice(0, BROWSE_ROW_LIMIT);
  }, [listing, filterText]);
  const branchName = listing?.baseBranch ?? '';

  const handlePickFolder = (folderPath: string) => {
    onValueChange?.(folderPath);
    setBrowseOpen(false);
  };

  const submitDisabled = busy || (mode === 'add' && !value.trim());

  return (
    <div className="px-3 py-2.5" data-testid="import-source-form">
      <div className="flex items-center gap-2 mb-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t({ message: 'Back', context: 'button' })}
          className="flex items-center justify-center w-6 h-6 rounded border border-edge/50 text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors shrink-0"
          data-testid="import-source-back-btn"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="w-5 flex justify-center text-fg-muted shrink-0">{provider.icon}</span>
        <span className="text-xs font-medium text-fg truncate">{getSourceFormTitle(provider, sourceType)}</span>
      </div>

      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs text-fg-muted">{fieldLabel}</span>
        {fieldTip && <FieldInfo about={fieldLabel} tip={fieldTip} testId="import-source-field-info" />}
      </div>
      <div className={`flex gap-1.5 mb-2 ${sourceType.multiline ? 'items-start' : 'items-center'}`}>
        {editable && sourceType.multiline ? (
          <textarea
            ref={valueInputRef as React.Ref<HTMLTextAreaElement>}
            value={value}
            onChange={(event) => onValueChange?.(event.target.value)}
            placeholder={sourceType.placeholder}
            rows={4}
            spellCheck={false}
            className={`${FIELD_CLASS} min-h-[5.5rem] resize-y`}
            data-testid="import-source-url-input"
          />
        ) : editable ? (
          <input
            ref={valueInputRef as React.Ref<HTMLInputElement>}
            type="text"
            value={value}
            onChange={(event) => onValueChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSubmit();
            }}
            placeholder={sourceType.repoFolder ? t`Type a folder or browse` : sourceType.placeholder}
            className={FIELD_CLASS}
            data-testid="import-source-url-input"
          />
        ) : sourceType.multiline ? (
          <span
            className="w-full min-w-0 whitespace-pre-wrap break-words bg-surface/30 border border-edge/40 rounded text-sm text-fg-muted px-2.5 py-1.5"
            data-testid="import-source-url-readonly"
          >
            {value}
          </span>
        ) : (
          <Tooltip label={value}>
            <span
              className="w-full min-w-0 truncate bg-surface/30 border border-edge/40 rounded text-sm text-fg-muted px-2.5 py-1.5"
              data-testid="import-source-url-readonly"
            >
              {value}
            </span>
          </Tooltip>
        )}
        {editable && sourceType.repoFolder && (
          <button
            type="button"
            onClick={() => void handleBrowse()}
            aria-expanded={browseOpen}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded hover:bg-surface-hover/40 transition-colors shrink-0"
            data-testid="import-source-browse-btn"
          >
            <FolderSearch size={13} />
            <Trans context="button">Browse</Trans>
          </button>
        )}
      </div>

      {browseOpen && (
        <div className="mb-2 border border-edge/50 rounded" data-testid="import-source-browse-list">
          <div className="px-2.5 py-1.5 border-b border-edge/40 text-[11px] font-medium text-fg-faint uppercase tracking-wider">
            {branchName ? <Trans>Folders on {branchName}</Trans> : <Trans>Folders</Trans>}
          </div>
          <div className="max-h-40 overflow-y-auto">
            {browseLoading && (
              <div className="flex justify-center py-3 text-fg-faint"><LoaderCircle size={14} className="animate-spin" /></div>
            )}
            {!browseLoading && browseError && (
              <p className="px-2.5 py-2 text-xs text-danger break-words" data-testid="import-source-browse-error">{browseError}</p>
            )}
            {!browseLoading && !browseError && shownFolders.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-fg-faint"><Trans>No folders match</Trans></p>
            )}
            {!browseLoading && !browseError && shownFolders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                onClick={() => handlePickFolder(folder.path)}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-surface-hover/40 transition-colors"
                data-testid={`import-source-browse-folder-${folder.path}`}
              >
                <span className="flex-1 min-w-0 truncate text-xs text-fg">{folder.path}</span>
                <CountBadge count={folder.itemCount} variant="tinted" size="pill" className="text-fg-muted" />
              </button>
            ))}
          </div>
        </div>
      )}

      {showLabel && (
        <>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs text-fg-muted">{labelFieldName}</span>
            <OptionalTag />
            <FieldInfo about={labelFieldName} tip={labelTip} testId="import-source-label-info" />
          </div>
          <input
            type="text"
            value={taskLabel}
            onChange={(event) => onTaskLabelChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSubmit();
            }}
            className={`${FIELD_CLASS} mb-2`}
            data-testid="import-source-label-input"
          />
        </>
      )}

      {error && (
        <p className="text-xs text-danger mb-2 break-words" data-testid="import-source-error">{error}</p>
      )}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitDisabled}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
        data-testid={mode === 'edit' ? 'import-source-save-btn' : 'import-source-connect-btn'}
      >
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
        {submitLabel}
      </button>
    </div>
  );
}
