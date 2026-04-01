import '../../../../monacoConfig';
import { DiffEditor } from '@monaco-editor/react';
import { Loader2, Columns2, Rows2, FileCode } from 'lucide-react';
import { useConfigStore } from '../../../../stores/config-store';
import { NAMED_THEMES } from '../../../../../shared/types';
import type { GitDiffStatus } from '../../../../../shared/types';

interface DiffViewerProps {
  original: string;
  modified: string;
  language: string;
  filePath: string;
  status: GitDiffStatus;
  viewMode: 'split' | 'inline';
  onViewModeChange: (mode: 'split' | 'inline') => void;
  loading: boolean;
  binary: boolean;
}

const STATUS_LABELS: Record<GitDiffStatus, { label: string; colorClass: string }> = {
  A: { label: 'Added', colorClass: 'text-green-400' },
  M: { label: 'Modified', colorClass: 'text-yellow-400' },
  D: { label: 'Deleted', colorClass: 'text-red-400' },
  R: { label: 'Renamed', colorClass: 'text-blue-400' },
  C: { label: 'Copied', colorClass: 'text-blue-400' },
};

export function DiffViewer({
  original,
  modified,
  language,
  filePath,
  status,
  viewMode,
  onViewModeChange,
  loading,
  binary,
}: DiffViewerProps) {
  const theme = useConfigStore((state) => state.config.theme);
  const themeBase = NAMED_THEMES.find((namedTheme) => namedTheme.id === theme)?.base ?? 'dark';
  const monacoTheme = themeBase === 'dark' ? 'vs-dark' : 'vs';
  const statusConfig = STATUS_LABELS[status];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge flex-shrink-0">
        <FileCode size={12} className="text-fg-muted flex-shrink-0" />
        <span className="text-xs text-fg-secondary truncate">{filePath}</span>
        <span className={`text-xs ${statusConfig.colorClass} flex-shrink-0`}>{statusConfig.label}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onViewModeChange('split')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'split' ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'
            }`}
            title="Side by side"
          >
            <Columns2 size={14} />
          </button>
          <button
            onClick={() => onViewModeChange('inline')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'inline' ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'
            }`}
            title="Inline"
          >
            <Rows2 size={14} />
          </button>
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        ) : binary ? (
          <div className="flex items-center justify-center h-full text-xs text-fg-disabled">
            Binary file - cannot display diff
          </div>
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            original={original}
            modified={modified}
            theme={monacoTheme}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: viewMode === 'split',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              minimap: { enabled: false },
              renderWhitespace: 'boundary',
              fontSize: 12,
              lineHeight: 18,
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-fg-muted" />
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
