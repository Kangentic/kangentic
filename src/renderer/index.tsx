import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { readPopOutDescriptor } from './pop-out/read-descriptor';
import { PopOutSurfaceRoot } from './pop-out/PopOutSurfaceRoot';
import './index.css';

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  window.electronAPI?.analytics?.trackRendererError(message);
});

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
