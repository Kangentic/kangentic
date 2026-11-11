import type { ILink, ILinkProvider } from '@xterm/xterm';
import { TERMINAL_LINK_SCHEMES, isAllowedExternalUrl } from '../../../shared/external-url';
import { cellRangeOf, readLogicalLine, type TerminalBufferLike } from './buffer-line-text';
import { isLinkOpenGesture } from '../link-open';
import type { TerminalLinkGesture } from './link-gesture';
import type { LinkPathCache } from './link-path-cache';
import type { TerminalLinkTargets } from './link-targets';
import { parsePaths, parseUrls } from './parse-links';

/** The part of a terminal the providers read. A live getter, because the active buffer changes. */
export interface LinkTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: TerminalBufferLike };
}

function touchesRow(link: ILink, bufferRow: number): boolean {
  return link.range.start.y <= bufferRow && bufferRow <= link.range.end.y;
}

/**
 * Plain `http(s)` URLs. Answers synchronously: xterm's Linkifier shows no provider's
 * link until every provider has replied, so nothing here may wait.
 */
export function createUrlLinkProvider(
  terminal: LinkTerminal,
  gesture: TerminalLinkGesture,
  targets: TerminalLinkTargets,
): ILinkProvider {
  return {
    provideLinks(bufferRow, callback) {
      const line = readLogicalLine(terminal.buffer.active, bufferRow - 1, terminal.cols);
      const links: ILink[] = [];
      for (const parsed of parseUrls(line.text)) {
        const range = cellRangeOf(line, parsed.start, parsed.end);
        if (!range) continue;
        links.push({
          range,
          text: parsed.url,
          hover: (event) => gesture.noteLinkHover({ event, range, kind: 'url' }),
          leave: () => gesture.noteLinkLeave(),
          activate: (event, url) => {
            const target = targets.plan().targetFor(event);
            if (target === null) return;
            // A plain click that turned into a drag, or that only brought the
            // terminal forward, opens nothing (link-gesture.ts).
            if (!gesture.opensOnRelease(event)) return;
            if (isAllowedExternalUrl(url, TERMINAL_LINK_SCHEMES)) targets.open(target, url);
          },
        });
      }
      callback(links.filter((link) => touchesRow(link, bufferRow)));
    },
  };
}

/**
 * File paths that exist. xterm calls this when the pointer enters a row, never from
 * the render path, and the cache keeps a second visit from reaching main.
 */
export function createPathLinkProvider(
  terminal: LinkTerminal,
  gesture: TerminalLinkGesture,
  cache: LinkPathCache,
  revealPath: (path: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferRow, callback) {
      const line = readLogicalLine(terminal.buffer.active, bufferRow - 1, terminal.cols);
      const urls = parseUrls(line.text);
      const candidates = parsePaths(line.text, urls);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      const answer = (): void => {
        const links: ILink[] = [];
        for (const parsed of candidates) {
          if (cache.peek(parsed.path) !== true) continue;
          const range = cellRangeOf(line, parsed.start, parsed.end);
          if (!range) continue;
          const printedPath = parsed.path;
          links.push({
            range,
            text: line.text.slice(parsed.start, parsed.end),
            hover: (event) => gesture.noteLinkHover({ event, range, kind: 'path' }),
            leave: () => gesture.noteLinkLeave(),
            activate: (event) => {
              if (isLinkOpenGesture(event)) revealPath(printedPath);
            },
          });
        }
        callback(links.filter((link) => touchesRow(link, bufferRow)));
      };

      const unanswered = candidates.map((parsed) => parsed.path).filter((path) => cache.peek(path) === undefined);
      if (unanswered.length === 0) {
        answer();
        return;
      }
      // Every path of the row in one call. The Linkifier waits on this reply, so
      // it answers on a failure too.
      cache.resolve(unanswered).then(answer, () => callback(undefined));
    },
  };
}
