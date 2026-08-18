// Structural types for Electron's <webview> tag and the NativeImage it
// returns from capturePage(). Avoids importing 'electron' from the renderer
// (which the bundler can't satisfy) while still giving us type safety on
// the methods we actually use.

import type { DetailedHTMLProps, HTMLAttributes } from 'react';

export interface NativeImageLike {
  toDataURL(): string;
  getSize(): { width: number; height: number };
}

export interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  isLoading(): boolean;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImageLike>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  /** Id of the guest webContents, used to register the pane for MCP targeting. Throws until attached. */
  getWebContentsId(): number;
}

type WebviewProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
  useragent?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }
}

/**
 * `allowpopups`, spread onto the `<webview>` rather than written inline.
 *
 * It has to reach the DOM as a STRING. React's own `WebViewHTMLAttributes` is
 * what resolves for `<webview>` (ahead of the global JSX declaration above) and
 * types it `boolean | undefined`, but a boolean cannot work: `webview` has no
 * dash, so React treats it as an unknown HTML element rather than a custom
 * element, and `allowpopups` is absent from React DOM's attribute table - so
 * `allowpopups={true}` logs "Received `true` for a non-boolean attribute" and
 * React DROPS the attribute entirely. Electron would then disable `window.open`
 * inside the guest and the main-process popup policy would never run: the exact
 * dead-sign-in-button symptom the popup work exists to fix, silent and behind a
 * passing typecheck. A string value always renders.
 *
 * The interface cannot be widened by augmentation (TS2717 - a merged declaration
 * may not change an existing property's type), so the cast lives here, once,
 * with the reason attached, instead of at the JSX site.
 */
export const ALLOW_POPUPS_ATTRIBUTE = { allowpopups: '' } as unknown as { allowpopups?: boolean };

export type {};
