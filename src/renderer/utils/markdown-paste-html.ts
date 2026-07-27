/**
 * Converts pasted `text/html` (a GitHub issue, a Notion page, a doc) to
 * markdown via turndown + the GFM plugin. This wrapper is imported normally,
 * but it reaches turndown itself through a dynamic `import()` that runs on the
 * first conversion - turndown is ~35KB that should never enter the renderer
 * entry chunk for a paste that never happens.
 */
import type TurndownService from 'turndown';

// The in-flight promise, not the resolved service, so two pastes racing before
// the first import settles await one construction instead of each building
// their own and discarding the loser.
// hmr-safe: stateless converter, cheap to rebuild
let servicePromise: Promise<TurndownService> | null = null;

async function buildTurndownService(): Promise<TurndownService> {
  const [{ default: TurndownServiceCtor }, { gfm }] = await Promise.all([
    import('turndown'),
    import('turndown-plugin-gfm'),
  ]);
  const service = new TurndownServiceCtor({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  service.use(gfm);
  return service;
}

function getTurndownService(): Promise<TurndownService> {
  if (!servicePromise) {
    servicePromise = buildTurndownService().catch((error: unknown) => {
      // Do not cache a rejection: a chunk that failed to load once (a dropped
      // network, a stale dev server) must be retryable on the next paste.
      servicePromise = null;
      throw error;
    });
  }
  return servicePromise;
}

export async function convertHtmlToMarkdown(html: string): Promise<string> {
  const service = await getTurndownService();
  return service.turndown(html).trim();
}
