/**
 * The rehype plugins MarkdownRenderer's document variant renders with (raw
 * HTML, heading ids, the sanitizer, GitHub alerts). This loader is imported
 * normally, but it reaches the plugins through a dynamic `import()` the first
 * time a document renders: parse5, which parses the raw HTML, is a parser no
 * transcript, description or web demo frame should load. scripts/build.js
 * (assertVendorChunksLazy) fails a build that pulls it onto the startup path.
 */
import type { Options as ReactMarkdownOptions } from 'react-markdown';

export type DocumentRehypePlugins = NonNullable<ReactMarkdownOptions['rehypePlugins']>;

// The in-flight promise, not the resolved list, so two previews racing before
// the first import settles share one import.
// hmr-safe: a cached dynamic import, reset on a refresh; a mounted preview keeps the plugins it loaded until it remounts
let pluginsPromise: Promise<DocumentRehypePlugins> | null = null;
// Kept apart from the promise so a preview mounted after the import settled
// renders the document on its first paint instead of a spinner frame.
// hmr-safe: a cached dynamic import, reset on a refresh; a mounted preview keeps the plugins it loaded until it remounts
let resolvedPlugins: DocumentRehypePlugins | null = null;

export function loadDocumentPlugins(): Promise<DocumentRehypePlugins> {
  if (!pluginsPromise) {
    pluginsPromise = import('./markdown-document-pipeline')
      .then((pipeline) => {
        resolvedPlugins = pipeline.DOCUMENT_REHYPE_PLUGINS;
        return pipeline.DOCUMENT_REHYPE_PLUGINS;
      })
      .catch((error: unknown) => {
        // Do not cache a rejection: a chunk that failed to load once (a dropped
        // network, a stale dev server) must be retryable on the next preview.
        pluginsPromise = null;
        throw error;
      });
  }
  return pluginsPromise;
}

/** The plugins if an earlier load already settled, else null. */
export function loadedDocumentPlugins(): DocumentRehypePlugins | null {
  return resolvedPlugins;
}
