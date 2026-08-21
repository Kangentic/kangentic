import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { readPopOutDescriptor } from './pop-out/read-descriptor';
import { PopOutSurfaceRoot } from './pop-out/PopOutSurfaceRoot';
import faviconHref from '@kangentic/branding/assets/brandmark-small.svg?url';
import './index.css';

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

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
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
  </React.StrictMode>
);
