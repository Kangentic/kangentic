import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const remarkPlugins = [remarkGfm];

const markdownComponents: Components = {
  a: ({ href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) window.electronAPI.shell.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  // A table's intrinsic width (many columns / long cell text) can exceed the
  // panel; contain it in its own horizontal-scroll box rather than letting it
  // overflow and get clipped by the transcript's overflow-hidden ancestor.
  table: ({ children, ...rest }) => (
    <div className="md-table-scroll">
      <table {...rest}>{children}</table>
    </div>
  ),
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`markdown-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
