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

export type {};
