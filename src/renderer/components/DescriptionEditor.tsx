import { useRef, useState, type ClipboardEvent, type RefObject } from 'react';
import { Paperclip, Eye, PenLine } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { DescriptionMentionMenu } from './DescriptionMentionMenu';
import { useDescriptionMentions } from '../hooks/useDescriptionMentions';

interface DescriptionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  testId?: string;
  placeholder?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  mentionSearchCwd?: string | null;
}

export function DescriptionEditor({
  value,
  onChange,
  onPaste,
  testId = 'description',
  placeholder = 'Describe the task for the agent...',
  textareaRef,
  mentionSearchCwd = null,
}: DescriptionEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedTextareaRef = textareaRef ?? internalTextareaRef;
  const mentions = useDescriptionMentions({
    value,
    onChange,
    mentionSearchCwd,
    disabled: showPreview,
    textareaRef: resolvedTextareaRef,
  });

  return (
    <div className="rounded border border-edge-input overflow-hidden focus-within:border-accent">
      <div className="flex items-center border-b border-edge-input">
        <button
          type="button"
          onClick={() => setShowPreview(false)}
          className={`flex-1 flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
            !showPreview ? 'text-fg-secondary bg-surface-hover/50' : 'text-fg-faint hover:text-fg-muted'
          }`}
          data-testid="description-edit-tab"
        >
          <PenLine size={12} />
          Write
        </button>
        <button
          type="button"
          onClick={() => setShowPreview(true)}
          className={`flex-1 flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
            showPreview ? 'text-fg-secondary bg-surface-hover/50' : 'text-fg-faint hover:text-fg-muted'
          }`}
          data-testid="description-preview-toggle"
        >
          <Eye size={12} />
          Preview
        </button>
      </div>
      <div className="relative h-[280px] w-full overflow-hidden bg-surface">
        {showPreview ? (
          <div
            className="absolute inset-0 overflow-y-auto px-3 py-2"
            data-testid="description-preview"
          >
            {value ? (
              <MarkdownRenderer content={value} />
            ) : (
              <span className="text-sm text-fg-faint">Nothing to preview</span>
            )}
          </div>
        ) : (
          <>
            <textarea
              ref={resolvedTextareaRef}
              data-testid={testId}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onChangeCapture={mentions.handleTextareaChangeCapture}
              onPaste={onPaste}
              onFocus={() => setTextareaFocused(true)}
              onBlur={() => {
                setTextareaFocused(false);
                mentions.handleTextareaBlur();
              }}
              onKeyDown={mentions.handleTextareaKeyDown}
              onSelect={mentions.handleTextareaSelect}
              onClick={mentions.handleTextareaClick}
              className="absolute inset-0 h-full w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm text-fg focus:outline-none"
            />
            {mentions.menuOpen && (
              <DescriptionMentionMenu
                items={mentions.items}
                isLoading={mentions.isLoading}
                activeIndex={mentions.activeIndex}
                helperText={mentions.helperText}
                onSelect={mentions.selectItem}
                onHover={mentions.setActiveIndex}
              />
            )}
            {!value && (
              <div className={`absolute inset-0 flex flex-col pointer-events-none px-3 py-2 transition-opacity duration-200 ${textareaFocused ? 'opacity-100' : 'opacity-40'}`}>
                <span className="text-sm text-fg-faint">{placeholder}</span>
                <div className="flex flex-1 items-center justify-center">
                  <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-edge px-6 py-4">
                    <Paperclip size={20} className="text-fg-disabled" />
                    <span className="text-xs text-fg-disabled">Paste or drop files here</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
