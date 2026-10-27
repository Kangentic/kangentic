import React from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { App } from './App';
import { activateLocale } from './i18n';
import { SOURCE_LOCALE } from '../shared/i18n/locales';
import { ErrorBoundary } from './components/ErrorBoundary';
import { readPopOutDescriptor } from './pop-out/read-descriptor';
import { PopOutSurfaceRoot } from './pop-out/PopOutSurfaceRoot';
import { initRendererErrorReporting } from './error-reporting';
import faviconHref from '@kangentic/branding/assets/brandmark-small.svg?url';
import './index.css';

// Before any listener or render, so the SDK's global handlers see everything.
// No-op unless main initialized Sentry (see error-reporting.ts).
initRendererErrorReporting();

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  // No component stack exists here: a rejected promise is not a render error.
  // Reporting the boundary anyway is the point - it distinguishes this path from
  // the two error boundaries, which previously all reported identically.
  window.electronAPI?.analytics?.trackRendererError(message, {
    boundary: 'unhandled_rejection',
  });
});

// Dev-server tab / devtools favicon (the packaged app icon is the native BrowserWindow icon,
// unaffected). `?url` so Vite hashes it into the build graph and it resolves in both dev and prod.
if (!document.querySelector('link[rel="icon"]')) {
  const iconLink = document.createElement('link');
  iconLink.rel = 'icon';
  iconLink.type = 'image/svg+xml';
  iconLink.href = faviconHref;
  document.head.appendChild(iconLink);
}

// A pop-out window (usage stats, git changes, the Browser pane) carries a surface
// descriptor via additionalArguments / URL hash; mount its minimal root instead of
// the full app. See src/renderer/pop-out/ and src/shared/pop-out.ts.
const popOutDescriptor = readPopOutDescriptor();

function render(): void {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <I18nProvider i18n={i18n}>
        {popOutDescriptor ? (
          // Wrapped like the <App/> branch: PopOutSurfaceRoot resolves its surface and runs
          // its bootstrap at the top of render (outside its own inner ErrorBoundary), so an
          // unexpected descriptor would otherwise blank the window with no recovery UI.
          <ErrorBoundary>
            <PopOutSurfaceRoot descriptor={popOutDescriptor} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        )}
      </I18nProvider>
    </React.StrictMode>
  );
}

// The session's language, which main passes on this window's command line (the
// main window and every pop-out alike), loads before the first render. English is
// already active, so English renders without waiting, and a language whose
// catalog fails to load renders in English rather than not at all. `lang` lets the
// browser pick the right glyphs for CJK text, where the same code point differs.
const bootLocale = window.electronAPI?.language?.getBootLocale?.() ?? SOURCE_LOCALE;
activateLocale(bootLocale)
  .catch((error: unknown) => {
    console.error(`[i18n] Could not load the ${bootLocale} catalog; rendering in English:`, error);
  })
  .finally(() => {
    document.documentElement.lang = i18n.locale;
    render();
  });
