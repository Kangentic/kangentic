/**
 * Pre-bundles a worktree preview's renderer dependencies in a short-lived
 * process, so the dev server starts on a warm cache.
 *
 * Vite pre-bundles dependencies in the process that runs it, and that process
 * keeps the memory afterwards. A worktree preview whose cache was cold held
 * 2,838 MB of commit for its whole life; the same preview relaunched on the
 * cache that run left held 489 MB (measured 2026-10-21, task #873). scripts/dev.js runs this before it creates its server, so the bundle's
 * memory ends with this process. When the cache is already current, Vite
 * returns it untouched.
 *
 * Usage: node scripts/vite-prebundle.js <projectDir> <port>
 * Exits 0 once the cache is committed, 1 on failure. dev.js treats a failure
 * as "the server bundles in-process", which is how every preview booted before.
 */
const { worktreeViteConfig } = require('./worktree-vite-config');

const DEPRECATION_NOTICE = 'manually calling optimizeDeps is deprecated';

async function main() {
  const [projectDir, portText] = process.argv.slice(2);
  if (!projectDir || !portText) throw new Error('usage: vite-prebundle.js <projectDir> <port>');
  const { createLogger, optimizeDeps, resolveConfig } = await import('vite');
  const inlineConfig = await worktreeViteConfig(projectDir, Number(portText));
  // optimizeDeps warns that calling it by hand is deprecated. It is the one
  // public call that bundles and commits the cache without a server, so the
  // notice is dropped. The logger is not part of the cache's config hash.
  const logger = createLogger();
  const warn = logger.warn;
  logger.warn = (message, options) => {
    if (typeof message === 'string' && message.includes(DEPRECATION_NOTICE)) return;
    warn(message, options);
  };
  const resolvedConfig = await resolveConfig({ ...inlineConfig, customLogger: logger }, 'serve');
  await optimizeDeps(resolvedConfig);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('[dev] dependency pre-bundle failed:', error);
    process.exit(1);
  },
);
