export { GeminiAdapter } from './gemini-adapter';
export { GeminiDetector } from './detector';
export { GeminiCommandBuilder, type GeminiCommandOptions } from './command-builder';
export { GeminiStatusParser } from './status-parser';
export { buildHooks, removeHooks, type GeminiHookEntry, GeminiHookEvent } from './hook-manager';
export {
  ensureWorktreeTrust as ensureGeminiWorktreeTrust,
  removeWorktreeTrust as removeGeminiWorktreeTrust,
} from './trust-manager';
