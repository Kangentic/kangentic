import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Sparkles, Check, RotateCcw } from 'lucide-react';
import { SectionHeader, SettingRow, SettingToggleRow, Select, DownloadProgressBar, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { useProjectStore } from '../../../stores/project-store';
import { EMBEDDING_MODELS } from '../../../../shared/embedding-models';
import type { AppConfig, MemoryStatus, MemoryAcceleration } from '../../../../shared/types';

/**
 * Conversation Memory settings. GLOBAL/shared scope (below the settings
 * separator, next to Dictation - both are on-device, keyless, model-backed AI
 * features). Controls the local index over agent conversation transcripts that
 * powers Quick Find conversation search (humans) and the kangentic_search MCP
 * tool (agents). Keyword search is on by default; the semantic layer is an
 * opt-in enhancement.
 */

/** A platform-level note for the semantic layer (only when it cannot run
 *  here). The model card carries the ready/downloading state. */
function semanticPlatformNote(status: MemoryStatus | null): string | null {
  if (!status) return null;
  if (status.semantic === 'lexical') {
    return status.vecError
      ? `Vector search is unavailable - showing keyword matches. (${status.vecError})`
      : 'Vector search is unavailable on this platform - showing keyword matches.';
  }
  if (status.semantic === 'error') {
    return 'Semantic search failed to start - showing keyword matches.';
  }
  return null;
}

export function MemoryTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  // Default on when unset (matches DEFAULT_CONFIG.memory.indexingEnabled).
  const indexingEnabled = globalConfig.memory?.indexingEnabled ?? true;
  // Default off when unset (matches DEFAULT_CONFIG.memory.semanticEnabled).
  const semanticEnabled = globalConfig.memory?.semanticEnabled ?? false;
  // Default model when unset (matches DEFAULT_CONFIG.memory.embeddingModel).
  const embeddingModelId = globalConfig.memory?.embeddingModel ?? 'bge-base';
  // Default acceleration when unset (matches DEFAULT_CONFIG.memory.acceleration).
  const acceleration = globalConfig.memory?.acceleration ?? 'auto';

  // Poll the semantic-layer status while the feature is on so the model-download
  // progress and readiness update live. Cleared on unmount / when turned off.
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  useEffect(() => {
    if (!semanticEnabled) {
      setStatus(null);
      return;
    }
    let active = true;
    const poll = () => {
      window.electronAPI.memory
        .getStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [semanticEnabled]);

  const platformNote = semanticPlatformNote(status);
  const model = status?.model ?? null;

  // "Rebuild index" recovery: purge + re-sweep the current project. Per-project,
  // so it only appears when a project is open and indexing is on.
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [rebuilding, setRebuilding] = useState(false);
  const handleRebuild = useCallback(() => {
    if (!currentProjectId) return;
    setRebuilding(true);
    window.electronAPI.memory
      .rebuildIndex(currentProjectId)
      .catch(() => undefined)
      // The purge resolves quickly; the sweep continues in the background, so
      // this is just brief button feedback.
      .finally(() => window.setTimeout(() => setRebuilding(false), 1200));
  }, [currentProjectId]);

  return (
    <div className="space-y-4">
      <SectionHeader
        label="Conversation Memory"
        searchIds={['memory.indexingEnabled', 'memory.semanticEnabled', 'memory.embeddingModel']}
      />
      <p className="text-sm text-fg-muted leading-relaxed">
        Search and recall past agent conversations - in Quick Find for you, and via the recall tool
        for agents. Only structured conversation turns are indexed (never raw terminal noise),
        automatically: new sessions as they finish, older history backfilled over time. Keyword
        search is instant and on by default; semantic adds meaning-based matching with a small
        on-device model. Everything runs locally with no API key, across one project or all at once.
      </p>

      <SettingToggleRow
        {...settingProps('memory.indexingEnabled')}
        icon={<MessageSquare size={16} />}
        checked={indexingEnabled}
        onChange={(value) => updateGlobal({ memory: { indexingEnabled: value } })}
      />
      <SettingToggleRow
        {...settingProps('memory.semanticEnabled')}
        icon={<Sparkles size={16} />}
        checked={semanticEnabled}
        disabled={!indexingEnabled}
        onChange={(value) => updateGlobal({ memory: { semanticEnabled: value } })}
      />

      {/* Model picker + download card, revealed once semantic search is on.
          Gated on indexingEnabled too (like the rebuild card below) so turning
          indexing off - which disables the semantic toggle - also hides this
          panel instead of leaving it interactive with no way to switch semantic
          back off. Mirrors the dictation model dropdown + status card. */}
      {indexingEnabled && semanticEnabled ? (
        <div className="space-y-3">
          <SettingRow {...settingProps('memory.embeddingModel')}>
            <Select
              value={embeddingModelId}
              onChange={(event) => updateGlobal({ memory: { embeddingModel: event.target.value } })}
              data-testid="embedding-model-select"
            >
              {EMBEDDING_MODELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.tierLabel}
                </option>
              ))}
            </Select>
          </SettingRow>

          {/* The model card follows its own "Search quality" dropdown: that
              dropdown selects the model, and the card shows its size / download
              / ready state, so they belong together. */}
          {model ? (
            <div
              className="flex items-center justify-between gap-2 rounded border border-edge bg-surface-hover px-3 py-2 text-xs"
              data-testid="embedding-model-card"
            >
              <div className="min-w-0">
                <div className="text-fg-secondary">
                  Model: <span className="text-fg">{model.displayName}</span>
                  <span className="text-fg-faint"> (~{model.approxSizeMb} MB)</span>
                </div>
                {model.state === 'error' ? (
                  <div className="text-red-400">Download failed</div>
                ) : model.state === 'ready' ? (
                  <div className="text-fg-faint">
                    Cached for offline use.{status?.activeBackend ? ` Running on ${status.activeBackend}.` : ''}
                  </div>
                ) : model.state === 'downloading' ? (
                  <>
                    <div className="text-fg-faint">Downloading... {Math.min(100, Math.round((model.progress ?? 0) * 100))}%</div>
                    <DownloadProgressBar percent={(model.progress ?? 0) * 100} />
                  </>
                ) : (
                  <div className="text-fg-faint">Downloads automatically when enabled.</div>
                )}
              </div>
              {model.state === 'ready' ? (
                <span
                  className="inline-flex items-center gap-1 whitespace-nowrap text-fg-muted"
                  data-testid="embedding-model-ready"
                >
                  <Check size={13} /> Ready
                </span>
              ) : null}
            </div>
          ) : null}

          <SettingRow {...settingProps('memory.acceleration')}>
            <Select
              value={acceleration}
              onChange={(event) => updateGlobal({ memory: { acceleration: event.target.value as MemoryAcceleration } })}
              data-testid="memory-acceleration-select"
            >
              <option value="auto">Auto</option>
              <option value="gpu">GPU</option>
              <option value="cpu">CPU</option>
            </Select>
          </SettingRow>

          {platformNote ? (
            <div className="text-xs text-fg-muted px-1" data-testid="semantic-status">
              {platformNote}
            </div>
          ) : null}
        </div>
      ) : null}

      {indexingEnabled && currentProjectId ? (
        <div
          className="flex items-center justify-between gap-3 rounded border border-edge bg-surface-hover px-3 py-2"
          data-testid="memory-rebuild-row"
        >
          <div className="min-w-0">
            <div className="text-xs text-fg-secondary">Rebuild index</div>
            <div className="text-xs text-fg-faint">
              Re-indexes this project's conversations for search - your messages aren't deleted. Use
              if results look stale or incomplete.
            </div>
          </div>
          <button
            type="button"
            onClick={handleRebuild}
            disabled={rebuilding}
            data-testid="memory-rebuild-index"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge/60 bg-surface-inset/40 px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg disabled:opacity-50"
          >
            <RotateCcw size={13} className={rebuilding ? 'animate-spin' : undefined} />
            {rebuilding ? 'Rebuilding...' : 'Rebuild'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
