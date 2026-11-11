import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Field, FIELD_CONTROL_CLASS } from '../Field';
import { Tooltip } from '../Tooltip';
import { ArtifactPlatformLogo } from '../VendorMark';
import { useLinkOpener } from '../../hooks/useLinkOpener';
import { artifactKey, artifactNameFromUrl, artifactShortLink } from '../../../shared/artifact-platforms';
import { listArtifacts, MAX_TASK_ARTIFACTS } from '../../../shared/task-artifacts';
import type { TaskArtifact, TaskArtifactChanges } from '../../../shared/types';
import { draftAddArtifact, draftNameOf, draftRemoveArtifact, draftRenameArtifact, linksToAdd, previewArtifacts } from './artifact-draft';
import { hasArtifactsFocusRequest, takeArtifactsFocus } from './artifacts-focus';

interface ArtifactsFieldProps {
  taskId: string;
  /** The task's saved artifacts. */
  artifacts: readonly TaskArtifact[];
  /** The form's unsaved artifact edits, sent with Save. */
  changes: TaskArtifactChanges;
  onChange: (changes: TaskArtifactChanges) => void;
}

const ROW_BUTTON_CLASS = 'rounded p-1.5 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary';

/**
 * A task's artifacts in its edit form (#1056): one row per link, then a
 * dashed Add artifact row.
 *
 * A row is the tool's mark, the artifact's name, its link, a pencil and
 * remove. It is a row, not a field: the first build drew every name as a
 * full-width input, the same shape as the Pull request field above and the add
 * field below, so the section read as a stack of link fields. The pencil turns
 * the name into a field in place (Enter keeps it, Escape puts it back). An
 * artifact with no name of its own shows its link alone, as its card does.
 *
 * Add artifact is the dashed row the Column Manager uses for Add automation,
 * so it does not read as one more artifact. A click turns it into the field
 * that adds whatever link is pasted or typed into it.
 *
 * Nothing here writes: every edit lands in `changes`, and the form's Save
 * sends them with the rest. Removing a link Kangentic detected also stops it
 * being detected again, which the save records.
 */
export function ArtifactsField({ taskId, artifacts, changes, onChange }: ArtifactsFieldProps) {
  const { t } = useLingui();
  const opener = useLinkOpener(taskId);
  const rootRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  // The row being renamed, and the name it had when the pencil was pressed.
  const [renaming, setRenaming] = useState<{ url: string; nameBefore: string } | null>(null);

  const shown = useMemo(() => previewArtifacts(artifacts, changes), [artifacts, changes]);
  const items = useMemo(() => listArtifacts(shown), [shown]);
  const full = shown.length >= MAX_TASK_ARTIFACTS;

  // "Edit artifacts" opened the form to get here: bring the section into view
  // and open the add field. A frame later: the form focuses its title on
  // mount, and a parent's effect runs after this one, so focusing now would
  // lose to it. The request is taken inside the frame, not here: an effect
  // that runs twice (a dev build does) would spend it on a frame its own
  // cleanup cancels.
  useEffect(() => {
    if (!hasArtifactsFocusRequest(taskId)) return undefined;
    const frame = requestAnimationFrame(() => {
      if (!takeArtifactsFocus(taskId)) return;
      rootRef.current?.scrollIntoView({ block: 'center' });
      setAdding(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [taskId]);

  // Escape threw the typed link away. The field unmounts while it holds focus,
  // and a blur that follows would read the link it still held and add it.
  const addDiscardedRef = useRef(false);

  // The field a click just opened takes the keyboard.
  useEffect(() => {
    if (!adding) return;
    addDiscardedRef.current = false;
    addInputRef.current?.focus();
  }, [adding]);
  const renamingUrl = renaming?.url ?? null;
  useEffect(() => {
    if (renamingUrl !== null) renameInputRef.current?.focus();
  }, [renamingUrl]);

  const addLinks = (text: string): boolean => {
    const links = linksToAdd(text);
    if (links.length === 0) {
      setAddError(t`That is not a link. Paste one that starts with http or https.`);
      return false;
    }
    // A link past the limit is dropped by the save with no word said, so it is
    // refused here, with the text left in the field.
    const shownKeys = new Set(shown.map((artifact) => artifactKey(artifact.url)));
    const newKeys = new Set(links.map((link) => artifactKey(link)).filter((key) => !shownKeys.has(key)));
    if (shown.length + newKeys.size > MAX_TASK_ARTIFACTS) {
      const limit = MAX_TASK_ARTIFACTS;
      setAddError(t`A task keeps at most ${limit} artifacts. Remove one to add another.`);
      return false;
    }
    let next = changes;
    for (const link of links) next = draftAddArtifact(next, link);
    onChange(next);
    setAddText('');
    setAddError(null);
    return true;
  };

  const closeAdd = () => {
    setAdding(false);
    setAddText('');
    setAddError(null);
  };

  const handleAddKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Escape closes the field, not the task window around it.
      event.preventDefault();
      event.stopPropagation();
      addDiscardedRef.current = true;
      closeAdd();
      return;
    }
    if (event.key !== 'Enter') return;
    // Enter adds the link. It must not reach the form's own Enter handling.
    event.preventDefault();
    event.stopPropagation();
    if (addText.trim() !== '') addLinks(addText);
  };

  const handleAddPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    // A pasted link is added at once; anything else is left in the field to edit.
    const pasted = event.clipboardData.getData('text');
    if (addText.trim() !== '' || linksToAdd(pasted).length === 0) return;
    event.preventDefault();
    addLinks(pasted);
  };

  const handleAddBlur = () => {
    // Leaving the field with a link in it adds the link; text that is not one
    // stays, with its error, for the user to fix. Empty, the field folds away.
    if (addDiscardedRef.current) return;
    if (addText.trim() === '') closeAdd();
    else if (addLinks(addText)) setAdding(false);
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    // Neither key reaches the form (Enter) or the task window (Escape).
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && renaming) {
      onChange(draftRenameArtifact(changes, artifacts, renaming.url, renaming.nameBefore));
    }
    setRenaming(null);
  };

  return (
    <div ref={rootRef} data-testid="artifacts-field">
      <Field label={t`Artifacts`} error={addError ?? undefined}>
        <div className="flex flex-col gap-1">
          {items.map((item) => {
            const url = item.artifact.url;
            const shortLink = artifactShortLink(url);
            const isRenaming = renamingUrl === url;
            // No name of its own: the name the card shows is the link, so the row shows the link once.
            const linkOnly = !isRenaming && item.name === shortLink;
            return (
              <div
                key={url}
                className="grid h-9 grid-cols-[16px_minmax(0,340px)_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 rounded-md bg-surface-hover/40 pl-3 pr-1"
                data-testid="artifact-row"
                data-artifact-url={url}
              >
                <span className="flex text-fg-muted"><ArtifactPlatformLogo platformId={item.platformId} size={16} /></span>
                {isRenaming && (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={draftNameOf(changes, item.artifact)}
                    // The name it shows when none is typed: the one in the link, else the link cut short.
                    placeholder={artifactNameFromUrl(url) ?? shortLink}
                    onChange={(event) => onChange(draftRenameArtifact(changes, artifacts, url, event.target.value))}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={() => setRenaming(null)}
                    aria-label={t`Artifact name`}
                    className="h-7 min-w-0 rounded border border-accent bg-surface-control px-2 text-sm font-medium text-fg placeholder-fg-faint focus:outline-none"
                    data-testid="artifact-name-input"
                  />
                )}
                {!isRenaming && !linkOnly && (
                  <span className="truncate text-sm font-medium text-fg" data-testid="artifact-name">{item.name}</span>
                )}
                {/* The link opens the artifact, the way its chip does. Its tip
                    names the tool, which the row itself only draws as a mark. */}
                <Tooltip label={item.tool} destination={url} rows={opener.rows}>
                  <button
                    type="button"
                    onClick={(event) => opener.open(url, event)}
                    className={`min-w-0 justify-self-start truncate text-left text-fg-muted hover:text-fg-tertiary hover:underline focus:outline-none focus-visible:underline ${
                      linkOnly ? 'col-span-2 text-sm' : 'text-xs'
                    }`}
                    style={{ maxWidth: '100%' }}
                    data-testid="artifact-link"
                  >
                    {shortLink}
                  </button>
                </Tooltip>
                <Tooltip label={isRenaming ? '' : t`Rename artifact`}>
                  <button
                    type="button"
                    // Keeps the name field's focus, so its blur does not close the rename this click toggles.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setRenaming(isRenaming ? null : { url, nameBefore: draftNameOf(changes, item.artifact) })}
                    aria-label={t`Rename artifact`}
                    aria-pressed={isRenaming}
                    className={`${ROW_BUTTON_CLASS} ${isRenaming ? 'bg-surface-hover text-fg' : ''}`}
                    data-testid="artifact-rename"
                  >
                    <Pencil size={14} />
                  </button>
                </Tooltip>
                {/* The tip is the control's own name: an icon-only button, and "Remove" alone means other things elsewhere. */}
                <Tooltip label={t`Remove artifact`}>
                  <button
                    type="button"
                    onClick={() => onChange(draftRemoveArtifact(changes, url, artifacts))}
                    aria-label={t`Remove artifact`}
                    className={ROW_BUTTON_CLASS}
                    data-testid="artifact-remove"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              </div>
            );
          })}
          {adding ? (
            <input
              ref={addInputRef}
              type="url"
              value={addText}
              placeholder={t`Paste a link`}
              onChange={(event) => { setAddText(event.target.value); if (addError) setAddError(null); }}
              onKeyDown={handleAddKeyDown}
              onPaste={handleAddPaste}
              onBlur={handleAddBlur}
              aria-label={t`Add an artifact link`}
              className={FIELD_CONTROL_CLASS}
              data-testid="artifact-add-input"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={full}
              // The Column Manager's Add automation row: h-[34px] is the field it turns into.
              className="flex h-[34px] w-full items-center justify-center gap-1.5 rounded border border-dashed border-edge/70 text-xs text-fg-muted transition-colors hover:border-edge hover:text-fg-tertiary disabled:cursor-default disabled:opacity-50 disabled:hover:border-edge/70 disabled:hover:text-fg-muted"
              data-testid="artifact-add"
            >
              <Plus size={13} />
              <Trans>Add artifact</Trans>
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}
