export { ClaudeAdapter } from './claude-adapter';
export { ClaudeDetector } from './detector';
export { CommandBuilder } from './command-builder';
export { ClaudeStatusParser, type StatusContextWindow } from './status-parser';
export { buildEventHooks, stripKangenticHooks, type ClaudeHookEntry } from './hook-manager';
export { ensureWorktreeTrust, ensureMcpServerTrust } from './trust-manager';
