import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, CircleExclamationPoint, Folder, Laptop, Loader2, Server } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SshDirectoryEntry, SshDirectoryListing, SshHostConnectionState } from '../../../shared/types';
import { useAddProject } from '../../hooks/useAddProject';
import { describeIpcError } from '../../lib/ipc-error';
import { useProjectStore } from '../../stores/project-store';
import { useSshStore } from '../../stores/ssh-store';
import { ReportedError } from '../settings/shared';
import { InfoTip } from '../settings/settings-card';
import { FIELD_CONTROL_CLASS, Field } from '../Field';
import { Pill } from '../Pill';
import { SuggestionMenu, SuggestionOption } from '../SuggestionMenu';
import { useSuggestionMenu } from '../../hooks/useSuggestionMenu';
import { BaseDialog } from './BaseDialog';
import { HOME_DIRECTORY, MAX_SUGGESTIONS, breadcrumbOf, chooseFolder, matchingFolders, splitTypedDirectory } from './remote-directory';

/**
 * Add project, once a host exists (#913). The chooser lists This computer first, then each host with
 * where its connection stands. This computer goes to the folder picker as it always has, and a host opens
 * a small form with the host chosen and a folder field. With no host configured neither dialog is ever
 * shown: Add project opens the folder picker directly.
 *
 * Mounted once in AppLayout's overlay block, driven by `useSshStore.addProjectDialog`, so the sidebar
 * button, the collapsed rail and the welcome screen all reach the same two dialogs.
 */

function lastPathSegment(folderPath: string): string {
  const segments = folderPath.trim().split('/').filter((segment) => segment.length > 0 && segment !== '~');
  return segments[segments.length - 1] ?? '';
}

function useStateLabel(): (state: SshHostConnectionState) => string {
  const { t } = useLingui();
  return (state) => {
    switch (state) {
      case 'connected': return t`Connected`;
      case 'connecting': return t`Connecting…`;
      case 'reconnecting': return t`Reconnecting…`;
      case 'unreachable': return t`Unreachable`;
      case 'stopped': return t`Stopped`;
    }
  };
}

function ChooserRow({ icon, name, detail, testId, onClick }: { icon: ReactNode; name: string; detail: ReactNode; testId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-3 rounded-md border border-edge bg-surface-hover/30 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/60"
    >
      <span className="flex-shrink-0 text-fg-muted" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">{name}</span>
        <span className="block truncate text-xs text-fg-faint">{detail}</span>
      </span>
    </button>
  );
}

function AddProjectChooser() {
  const { t } = useLingui();
  const hosts = useSshStore((state) => state.hosts);
  const closeAddProjectDialog = useSshStore((state) => state.closeAddProjectDialog);
  const openAddRemoteProject = useSshStore((state) => state.openAddRemoteProject);
  const stateLabel = useStateLabel();
  const { startLocalAddProject } = useAddProject();

  return (
    <BaseDialog onClose={closeAddProjectDialog} title={t`Add project`} testId="add-project-chooser">
      <div className="space-y-2">
        <ChooserRow
          icon={<Laptop size={16} />}
          name={t`This computer`}
          detail={t`Choose a folder on this machine`}
          testId="add-project-this-computer"
          onClick={() => {
            closeAddProjectDialog();
            void startLocalAddProject();
          }}
        />
        {hosts.map((status) => (
          <ChooserRow
            key={status.host.id}
            icon={status.state === 'unreachable' ? <CircleExclamationPoint size={16} className="text-danger" /> : <Server size={16} />}
            name={status.host.name}
            detail={stateLabel(status.state)}
            testId="add-project-host"
            onClick={() => openAddRemoteProject(status.host.id)}
          />
        ))}
      </div>
    </BaseDialog>
  );
}

const SUGGESTIONS_ID = 'add-remote-project-suggestions';

/** The tag on a folder that is a git repository. */
function GitTag() {
  // i18n-ok: git is the program's name
  return <Pill size="sm" className="shrink-0 font-sans text-fg-faint">git</Pill>;
}

/**
 * The Browse view: the breadcrumb from home, then the folders of the current directory. A host that cannot be
 * asked shows its own words in place, and Choose waits for a directory that read.
 */
function DirectoryBrowser({ browser, home, onOpen }: { browser: ReturnType<typeof useDirectoryListing>; home: string | null; onOpen: (directory: string) => void }) {
  const { t } = useLingui();
  const { listing } = browser;
  const crumbs = listing && home ? breadcrumbOf(listing.path, home) : [];
  return (
    <div className="space-y-2" data-testid="add-remote-project-browser">
      <nav className="flex flex-wrap items-center gap-0.5 text-xs" aria-label={t`Path`} data-testid="add-remote-project-breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="inline-flex items-center gap-0.5">
            {index > 0 ? <ChevronRight size={12} className="text-fg-faint" aria-hidden="true" /> : null}
            <button
              type="button"
              onClick={() => onOpen(crumb.path)}
              disabled={index === crumbs.length - 1}
              className="rounded px-1 py-0.5 font-mono text-fg-muted hover:text-fg hover:bg-surface-hover disabled:text-fg-tertiary disabled:hover:bg-transparent"
              data-testid="add-remote-project-crumb"
            >
              {crumb.label}
            </button>
          </span>
        ))}
        {browser.loading ? <Loader2 size={12} className="ml-1 animate-spin text-fg-faint" /> : null}
      </nav>
      {browser.error ? <ReportedError error={browser.error} testId="add-remote-project-browse-error" /> : null}
      {listing && !listing.exists ? (
        <p className="text-sm text-fg-faint" data-testid="add-remote-project-browse-missing"><Trans>This directory is not on the host.</Trans></p>
      ) : null}
      {listing?.exists ? (
        <ul className="max-h-64 overflow-y-auto rounded border border-edge-input bg-surface-control text-sm" data-testid="add-remote-project-browse-list">
          {listing.entries.length === 0 ? (
            <li className="px-3 py-2 text-fg-faint"><Trans>No folders here.</Trans></li>
          ) : listing.entries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => onOpen(`${listing.path}/${entry.name}`)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-tertiary hover:bg-surface-hover"
                data-testid="add-remote-project-browse-entry"
              >
                <Folder size={14} className="shrink-0 text-fg-faint" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                {entry.isGitRepo ? <GitTag /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {listing?.truncated ? (
        <p className="text-xs text-fg-faint"><Trans>Only the first folders are shown. Type the rest in the Directory field.</Trans></p>
      ) : null}
    </div>
  );
}

/**
 * Asks a host for the folders in one directory. A newer ask supersedes an older one, so a slow answer for a
 * path typed past never replaces the answer for the path shown.
 */
function useDirectoryListing(hostId: string) {
  const listDirectories = useSshStore((state) => state.listDirectories);
  const [listing, setListing] = useState<SshDirectoryListing | null>(null);
  /** The directory (as asked) the current listing or error is for. */
  const [listedFor, setListedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The host's home folder, once a listing of `~/` has said what it is. */
  const [home, setHome] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const load = useCallback(async (directory: string): Promise<void> => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    setLoading(true);
    try {
      const result = await listDirectories(hostId, directory);
      if (request !== latestRequest.current) return;
      setListing(result);
      setError(null);
      if (directory === HOME_DIRECTORY && result.insideHome) setHome(result.path);
    } catch (caught) {
      if (request !== latestRequest.current) return;
      setListing(null);
      setError(describeIpcError(caught));
    } finally {
      if (request === latestRequest.current) {
        setListedFor(directory);
        setLoading(false);
      }
    }
  }, [hostId, listDirectories]);

  return { listing, listedFor, error, loading, home, load };
}

function AddRemoteProjectForm({ hostId }: { hostId: string }) {
  const { t } = useLingui();
  const host = useSshStore((state) => state.hosts.find((status) => status.host.id === hostId));
  const probeRemoteFolder = useSshStore((state) => state.probeRemoteFolder);
  const closeAddProjectDialog = useSshStore((state) => state.closeAddProjectDialog);
  const createProject = useProjectStore((state) => state.createProject);
  const openProject = useProjectStore((state) => state.openProject);
  const stateLabel = useStateLabel();

  const [folder, setFolder] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancel and Escape stay enabled while the host is asked, so an answer can arrive after this form closed.
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  // Suggestions: the folders of the directory typed so far, asked once per directory and narrowed by the rest.
  const suggestions = useDirectoryListing(hostId);
  const loadSuggestions = suggestions.load;
  const typed = splitTypedDirectory(folder);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Asked again when the host's state moves, so the reason a dropped host gave does not outlive the drop.
  const hostState = host?.state;
  useEffect(() => {
    const timer = setTimeout(() => void loadSuggestions(typed.parent), 200);
    return () => clearTimeout(timer);
  }, [typed.parent, loadSuggestions, hostState]);
  const matches = suggestions.listedFor === typed.parent && suggestions.listing?.exists
    ? matchingFolders(suggestions.listing.entries, typed.tail).slice(0, MAX_SUGGESTIONS)
    : [];
  const showSuggestions = suggestionsOpen && matches.length > 0;
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const suggestionMenu = useSuggestionMenu({
    anchorRef: inputWrapRef,
    itemCount: matches.length,
    open: showSuggestions,
    onChoose: (index) => chooseSuggestion(matches[index]),
    onDismiss: () => setSuggestionsOpen(false),
    onReopen: () => setSuggestionsOpen(true),
  });
  // The home folder as the host resolved it, from the first listing of `~/`. Browse needs it for its breadcrumb.
  const homeKnown = suggestions.home;

  function chooseSuggestion(entry: SshDirectoryEntry): void {
    setFolder(chooseFolder(typed.parent, entry));
    suggestionMenu.setHighlight(-1);
    setSuggestionsOpen(true);
  }

  // Browse: the same listing as a navigable list, in place of the form, so no dialog opens over a dialog.
  const browser = useDirectoryListing(hostId);
  const loadBrowser = browser.load;
  const [browsing, setBrowsing] = useState(false);

  function openBrowser(): void {
    const startAt = suggestions.listedFor === typed.parent && suggestions.listing?.exists && suggestions.listing.insideHome
      ? suggestions.listing.path
      : (homeKnown ?? HOME_DIRECTORY);
    setBrowsing(true);
    void loadBrowser(startAt);
  }

  function chooseBrowsed(): void {
    if (!browser.listing) return;
    setFolder(browser.listing.path);
    setBrowsing(false);
  }

  const name = nameDraft ?? lastPathSegment(folder);
  const canAdd = folder.trim().length > 0 && name.trim().length > 0 && !busy;

  async function handleAdd(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // The folder is checked on the host first, so a typo reads as one, and a host that cannot be
      // reached reads as that (its own words), never as a missing folder.
      const probe = await probeRemoteFolder(hostId, folder);
      // Cancelled while the host answered: nothing is added.
      if (!openRef.current) return;
      if (!probe.exists) {
        setError(t`${probe.path} does not exist on ${host?.host.name ?? ''}.`);
        setBusy(false);
        return;
      }
      const project = await createProject({ name: name.trim(), path: '', remote: { hostId, path: probe.path } });
      // Cancelled while it was created: the project is in the sidebar, and the user is not moved to it.
      if (!openRef.current) return;
      closeAddProjectDialog();
      await openProject(project.id);
    } catch (caught) {
      if (!openRef.current) return;
      setError(describeIpcError(caught));
      setBusy(false);
    }
  }

  return (
    <BaseDialog
      onClose={closeAddProjectDialog}
      title={t`Add project on ${host?.host.name ?? ''}`}
      testId="add-remote-project"
      footer={browsing ? (
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setBrowsing(false)}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="add-remote-project-browse-cancel"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={!browser.listing?.exists || !browser.listing.insideHome}
            onClick={chooseBrowsed}
            className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on disabled:opacity-50"
            data-testid="add-remote-project-browse-choose"
          >
            <Trans>Choose</Trans>
          </button>
        </div>
      ) : (
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={closeAddProjectDialog}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="add-remote-project-cancel"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => void handleAdd()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on disabled:opacity-50"
            data-testid="add-remote-project-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            <Trans>Add project</Trans>
          </button>
        </div>
      )}
    >
      {browsing ? (
        <DirectoryBrowser browser={browser} home={homeKnown} onOpen={(directory) => void loadBrowser(directory)} />
      ) : (
        <div className="space-y-3">
          {host ? (
            <p className="text-xs text-fg-faint" data-testid="add-remote-project-state">
              {stateLabel(host.state)}
            </p>
          ) : null}
          <Field
            label={(
              <span className="inline-flex items-center gap-1">
                {t`Directory`}
                <InfoTip label={t`Directory`} text={t`A folder inside your home on the host, such as ~/code/api`} />
              </span>
            )}
          >
            <div className="flex gap-2">
              <div ref={inputWrapRef} className="min-w-0 flex-1">
                <input
                  type="text"
                  autoFocus
                  className={`${FIELD_CONTROL_CLASS} font-mono`}
                  value={folder}
                  spellCheck={false}
                  autoCapitalize="off"
                  role="combobox"
                  aria-expanded={showSuggestions}
                  aria-controls={showSuggestions ? SUGGESTIONS_ID : undefined}
                  aria-autocomplete="list"
                  data-testid="add-remote-project-folder"
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setSuggestionsOpen(false)}
                  onChange={(event) => {
                    setFolder(event.target.value);
                    setSuggestionsOpen(true);
                    suggestionMenu.setHighlight(-1);
                  }}
                  onKeyDown={(event) => {
                    if (suggestionMenu.handleMenuKey(event)) return;
                    if (event.key === 'Enter' && canAdd) void handleAdd();
                  }}
                />
              </div>
              <button
                type="button"
                onClick={openBrowser}
                // Until the host has listed its home there is nothing to browse from, and a host that cannot be asked shows why below.
                disabled={homeKnown === null}
                className="shrink-0 rounded border border-edge-input bg-surface-control px-3 py-1.5 text-sm text-fg-tertiary hover:text-fg transition-colors disabled:opacity-50"
                data-testid="add-remote-project-browse"
              >
                <Trans>Browse</Trans>
              </button>
            </div>
            <SuggestionMenu menu={suggestionMenu} open={showSuggestions} id={SUGGESTIONS_ID} testId="add-remote-project-suggestions">
              {matches.map((entry, index) => (
                <SuggestionOption
                  key={entry.name}
                  selected={index === suggestionMenu.highlight}
                  onChoose={() => chooseSuggestion(entry)}
                  testId="add-remote-project-suggestion"
                >
                  <span className="min-w-0 truncate">{entry.name}</span>
                  {entry.isGitRepo ? <GitTag /> : null}
                </SuggestionOption>
              ))}
            </SuggestionMenu>
            {suggestions.error ? <div className="mt-1"><ReportedError error={suggestions.error} testId="add-remote-project-suggestions-error" /></div> : null}
          </Field>
          <Field label={t`Name`}>
            <input
              type="text"
              className={FIELD_CONTROL_CLASS}
              value={name}
              data-testid="add-remote-project-name"
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canAdd) void handleAdd();
              }}
            />
          </Field>
          {/* A git repository on the host gives each task a worktree there; any other folder is shared. */}
          <p className="text-xs text-fg-faint" data-testid="add-remote-project-note">
            <Trans>In a git repository, each task gets its own worktree on the host. Otherwise tasks share the folder.</Trans>
          </p>
          {error ? <ReportedError error={error} testId="add-remote-project-error" /> : null}
        </div>
      )}
    </BaseDialog>
  );
}

export function AddProjectDialogs() {
  const dialog = useSshStore((state) => state.addProjectDialog);
  if (dialog.kind === 'chooser') return <AddProjectChooser />;
  if (dialog.kind === 'remote') return <AddRemoteProjectForm key={dialog.hostId} hostId={dialog.hostId} />;
  return null;
}
