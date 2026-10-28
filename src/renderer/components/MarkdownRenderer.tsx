import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps, type ComponentType } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components, ExtraProps } from 'react-markdown';
import type { Element, ElementContent } from 'hast';
import { Info, Lightbulb, Loader2, MessageSquareWarning, OctagonAlert, TriangleAlert, type LucideProps } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Tooltip } from './Tooltip';
import { imageKindForPath } from '../../shared/image-preview';
import { loadDocumentPlugins, loadedDocumentPlugins, type DocumentRehypePlugins } from '../utils/markdown-document-plugins';
import { isMarkdownAlertKind, type MarkdownAlertKind } from '../utils/markdown-alert-kinds';
import { resolveMarkdownHref, resolveRepoAssetPath } from '../utils/markdown-repo-link';

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

/**
 * What the document variant needs from the file it renders. Supplied only by
 * the Changes panel's markdown preview (DiffViewer): every other surface
 * renders agent or user prose, where `<tag>` is text to show, not HTML to run.
 */
export interface MarkdownDocumentOptions {
  /** Repo-relative path of the markdown file. Relative links and images resolve against its folder. */
  baseFilePath: string;
  /** The app theme's base. A `<picture>` source written for `prefers-color-scheme` follows it, not the OS. */
  colorScheme: 'dark' | 'light';
  /** Whether a repo path is a file the panel can open (one in its current file list). */
  isFileListed: (path: string) => boolean;
  /** Open a listed file, landing on `anchor` once it renders. */
  openFile: (path: string, anchor: string | null) => void;
  /** Scroll the preview to the heading or element `#anchor` names. */
  scrollToAnchor: (anchor: string) => void;
  /** A repo image's data URL, read at the revision the preview shows, or null when it cannot be shown. */
  loadImage: (path: string) => Promise<string | null>;
  /** Colorized HTML for a fenced block, or null for a language there is no highlighter for. */
  highlight: (code: string, language: string) => Promise<string | null>;
}

const MarkdownDocumentContext = createContext<MarkdownDocumentOptions | null>(null);

/** The options of the document being rendered. Every document component renders inside MarkdownDocument's provider. */
function useDocumentOptions(): MarkdownDocumentOptions {
  const options = useContext(MarkdownDocumentContext);
  if (options === null) throw new Error('A markdown document component rendered outside MarkdownDocument');
  return options;
}

/**
 * remark-rehype writes GFM footnote ids with its own `user-content-` prefix,
 * and the sanitizer adds that prefix to every id it keeps, so with both the
 * ids would read `user-content-user-content-fn-1`. Leave the prefix to the
 * sanitizer alone: the ids then match GitHub's, and the links (`#fn-1`) land
 * through the prefix the anchor handler adds.
 */
const DOCUMENT_REMARK_REHYPE_OPTIONS = { clobberPrefix: '' };

/** The alt text of an image that could not be shown, where the image would have been. */
function MissingImage({ alt }: { alt: string | undefined }) {
  return <span className="md-image-missing">{alt}</span>;
}

/**
 * A repo image's data URL once it loads: undefined while loading, null when it
 * could not be read. Keyed by path, so a stale answer for another path never
 * shows.
 */
function useRepoImage(path: string | null, loadImage: (path: string) => Promise<string | null>): string | null | undefined {
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    loadImage(path)
      .then((url) => {
        if (!cancelled) setLoaded({ path, url });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ path, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, loadImage]);
  if (path === null) return null;
  return loaded?.path === path ? loaded.url : undefined;
}

function DocumentLink({ href, children, node: _node, ...rest }: ComponentProps<'a'> & ExtraProps) {
  const options = useDocumentOptions();
  const { t } = useLingui();
  const target = resolveMarkdownHref(href, options.baseFilePath);

  // A named target (`<a name="x">`) or a scheme no click may open: no href, so
  // it reads as text and nothing on it suggests a click works.
  if (target.kind === 'none') return <a {...rest}>{children}</a>;

  if (target.kind === 'external') {
    // The resolved URL, not the written one: a protocol-relative `//host/x`
    // left as written would resolve against the app's own origin on a middle
    // click.
    return (
      <a
        {...rest}
        href={target.url}
        onClick={(event) => {
          event.preventDefault();
          window.electronAPI.shell.openExternal(target.url);
        }}
      >
        {children}
      </a>
    );
  }

  const sameFile = target.kind === 'anchor' || target.path === options.baseFilePath;
  if (!sameFile && !options.isFileListed(target.path)) {
    // The panel shows only the files in its list. A link to any other file is
    // not an anchor at all, and the tip says why it goes nowhere. Never handed
    // to the OS: shell.openPath would run a linked executable.
    const path = target.path;
    return (
      <Tooltip label={t`${path} has no changes in this view`}>
        <span className="md-link-unlisted" tabIndex={0} data-testid="markdown-link-unlisted">{children}</span>
      </Tooltip>
    );
  }

  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (!sameFile) options.openFile(target.path, target.anchor);
        else if (target.anchor !== null) options.scrollToAnchor(target.anchor);
      }}
      // A middle click turns a link into a new-window request. In dev the
      // renderer's origin is http://localhost, so a relative href would reach
      // the window-open handler as an allowed http URL and open the dev server
      // in the system browser.
      onAuxClick={(event) => event.preventDefault()}
    >
      {children}
    </a>
  );
}

/**
 * An image URL that names no repo file, in the form the preview may load it:
 * http(s) as written, a protocol-relative URL as https (GitHub reads it so),
 * and null for anything else. The packaged app's origin is `file://`, so
 * `//host/x.png` left as written would request a network share on Windows,
 * and a relative path above the repository root would read one of the app's
 * own files.
 */
function webImageSource(source: string | undefined): string | null {
  const trimmed = (source ?? '').trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function DocumentImage({ src, alt, node: _node, ...rest }: ComponentProps<'img'> & ExtraProps) {
  const options = useDocumentOptions();
  const source = typeof src === 'string' ? src : undefined;
  const repoPath = resolveRepoAssetPath(source, options.baseFilePath);
  const readable = repoPath !== null && imageKindForPath(repoPath) !== null;
  const url = useRepoImage(readable ? repoPath : null, options.loadImage);
  if (repoPath === null) {
    // A web image loads as it does in a task description.
    const webSource = webImageSource(source);
    return webSource === null ? <MissingImage alt={alt} /> : <img {...rest} src={webSource} alt={alt} />;
  }
  if (!readable || url === null) return <MissingImage alt={alt} />;
  // While loading: the box the attributes give it, no request against the
  // renderer's own origin.
  if (url === undefined) return <img {...rest} alt={alt} />;
  return <img {...rest} src={url} alt={alt} />;
}

/** `(prefers-color-scheme: dark)` or `light`, written as the whole media query, the form GitHub READMEs use. */
const COLOR_SCHEME_MEDIA = /^\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*$/i;

/**
 * A `srcset` with only its http(s) candidates, or null when none is left. The
 * sanitizer checks the scheme of `src` but has no rule for `srcset`, and the
 * packaged app's own origin is `file://`, so a `file:` candidate would read a
 * local file.
 */
function webOnlySrcSet(srcSet: string | undefined): string | null {
  const kept = (srcSet ?? '')
    .split(',')
    .map((candidate) => candidate.trim())
    .filter((candidate) => /^https?:\/\//i.test(candidate));
  return kept.length > 0 ? kept.join(', ') : null;
}

function DocumentSource({ srcSet, media, node: _node, ...rest }: ComponentProps<'source'> & ExtraProps) {
  const options = useDocumentOptions();
  const schemeMatch = typeof media === 'string' ? COLOR_SCHEME_MEDIA.exec(media) : null;
  const scheme = schemeMatch?.[1].toLowerCase() ?? null;
  // A single relative candidate is a repo file; a list or an absolute URL is left to the browser.
  const candidates = (srcSet ?? '').trim().split(/\s+/);
  const repoPath = candidates.length !== 1 ? null : resolveRepoAssetPath(candidates[0], options.baseFilePath);
  const readable = repoPath !== null && imageKindForPath(repoPath) !== null;
  const url = useRepoImage(readable ? repoPath : null, options.loadImage);
  // Chromium decides `prefers-color-scheme` by the OS, so a dark app on a light
  // OS would show the light screenshot. Decide it by the app's theme instead:
  // the other scheme's source is dropped, and this one loses its media query.
  if (scheme !== null && scheme !== options.colorScheme) return null;
  const effectiveMedia = scheme !== null ? undefined : media;
  if (repoPath === null) {
    const webSrcSet = webOnlySrcSet(srcSet);
    return webSrcSet === null ? null : <source {...rest} srcSet={webSrcSet} media={effectiveMedia} />;
  }
  if (!readable || typeof url !== 'string') return null;
  return <source {...rest} srcSet={url} media={effectiveMedia} />;
}

const ALERT_ICONS: Record<MarkdownAlertKind, ComponentType<LucideProps>> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonAlert,
};

function DocumentDiv({ children, node, ...rest }: ComponentProps<'div'> & ExtraProps) {
  const { t } = useLingui();
  // Only the alert step sets `dataAlert`, after the sanitizer, so a document cannot.
  const kind = node?.properties.dataAlert;
  if (!isMarkdownAlertKind(kind)) return <div {...rest}>{children}</div>;
  const titles: Record<MarkdownAlertKind, string> = {
    note: t({ message: 'Note', context: 'markdown alert' }),
    tip: t({ message: 'Tip', context: 'markdown alert' }),
    important: t({ message: 'Important', context: 'markdown alert' }),
    warning: t({ message: 'Warning', context: 'markdown alert' }),
    caution: t({ message: 'Caution', context: 'markdown alert' }),
  };
  const Icon = ALERT_ICONS[kind];
  return (
    <div className={`markdown-alert markdown-alert-${kind}`} data-alert={kind}>
      <p className="markdown-alert-title">
        <Icon size={16} aria-hidden="true" />
        {titles[kind]}
      </p>
      {children}
    </div>
  );
}

function hastText(nodes: ElementContent[]): string {
  let text = '';
  for (const child of nodes) {
    if (child.type === 'text') text += child.value;
    else if (child.type === 'element') text += hastText(child.children);
  }
  return text;
}

/** The fenced block's code element and its `language-<x>` name, if it has one. */
function fencedCode(node: Element | undefined): { code: string; language: string } | null {
  const codeElement = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  if (codeElement === undefined) return null;
  const classNames = codeElement.properties.className;
  const languageClass = Array.isArray(classNames)
    ? classNames.find((name): name is string => typeof name === 'string' && name.startsWith('language-'))
    : undefined;
  if (languageClass === undefined) return null;
  // The fence's own closing newline would colorize into an empty last line.
  return { code: hastText(codeElement.children).replace(/\n$/, ''), language: languageClass.slice('language-'.length) };
}

function DocumentCodeBlock({ children, node, ...rest }: ComponentProps<'pre'> & ExtraProps) {
  const { highlight, colorScheme } = useDocumentOptions();
  const fenced = fencedCode(node);
  const code = fenced?.code ?? null;
  const language = fenced?.language ?? null;
  const [highlighted, setHighlighted] = useState<{ key: string; html: string | null } | null>(null);
  // The theme is part of the key: a new theme renumbers the token classes, so
  // HTML colorized under the old one would paint the wrong colors.
  const key = code === null || language === null ? null : `${colorScheme}\n${language}\n${code}`;
  useEffect(() => {
    if (key === null || code === null || language === null) return;
    let cancelled = false;
    highlight(code, language)
      .then((html) => {
        if (!cancelled) setHighlighted({ key, html });
      })
      .catch(() => {
        if (!cancelled) setHighlighted({ key, html: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, code, language, highlight]);
  const html = highlighted !== null && highlighted.key === key ? highlighted.html : null;
  if (html === null || language === null) return <pre {...rest}>{children}</pre>;
  // Monaco's colorizer escapes the source text and adds only its own token
  // spans and line breaks, so its output is the one HTML injected here.
  return (
    <pre {...rest}>
      <code className={`language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

const documentComponents: Components = {
  a: DocumentLink,
  img: DocumentImage,
  source: DocumentSource,
  div: DocumentDiv,
  pre: DocumentCodeBlock,
  table: markdownComponents.table,
};

/**
 * The rehype plugins, null until the lazy pipeline has loaded. A failed load
 * renders the markdown without them, HTML shown as text the way every other
 * surface shows it, rather than a spinner that never ends.
 */
function useDocumentPlugins(): DocumentRehypePlugins | null {
  const [plugins, setPlugins] = useState<DocumentRehypePlugins | null>(loadedDocumentPlugins);
  useEffect(() => {
    if (plugins !== null) return;
    let cancelled = false;
    loadDocumentPlugins()
      .then((loaded) => {
        if (!cancelled) setPlugins(loaded);
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [plugins]);
  return plugins;
}

function MarkdownDocument({ content, className, options }: { content: string; className?: string; options: MarkdownDocumentOptions }) {
  const plugins = useDocumentPlugins();
  // Parsed and sanitized only when the text or the pipeline changes. The
  // components read the options from context, so a theme change or a new file
  // list re-renders them without running the whole pipeline again.
  const renderedDocument = useMemo(() => (plugins === null ? null : (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={plugins}
      remarkRehypeOptions={DOCUMENT_REMARK_REHYPE_OPTIONS}
      components={documentComponents}
    >
      {content}
    </ReactMarkdown>
  )), [content, plugins]);
  return (
    <MarkdownDocumentContext.Provider value={options}>
      <div className={`markdown-body markdown-document${className ? ` ${className}` : ''}`}>
        {renderedDocument ?? (
          <div className="flex justify-center py-6">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        )}
      </div>
    </MarkdownDocumentContext.Provider>
  );
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * Render a repository file the way GitHub shows it: sanitized HTML, links
   * that open files in the Changes panel, images from the diff's own revision.
   * Only the Changes panel's markdown preview passes it
   * (tests/unit/markdown-document-render.test.ts pins that).
   */
  documentOptions?: MarkdownDocumentOptions;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className, documentOptions }: MarkdownRendererProps) {
  if (documentOptions) return <MarkdownDocument content={content} className={className} options={documentOptions} />;
  return (
    <div className={`markdown-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
