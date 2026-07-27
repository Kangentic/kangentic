/**
 * turndown-plugin-gfm ships no type declarations of its own and no @types
 * package exists for it (only @types/turndown does). Each export is a plugin
 * function taking the TurndownService instance to extend with GFM rules
 * (tables, strikethrough, task lists, fenced code from highlighted blocks).
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export function gfm(turndownService: TurndownService): void;
  export function tables(turndownService: TurndownService): void;
  export function strikethrough(turndownService: TurndownService): void;
  export function taskListItems(turndownService: TurndownService): void;
  export function highlightedCodeBlock(turndownService: TurndownService): void;
}
