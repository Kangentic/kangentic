export { GrokAdapter } from './grok-adapter';
export { GrokDetector, parseGrokVersion } from './detector';
export { GrokCommandBuilder, grokMcpWiringEnabled } from './command-builder';
export { buildGrokHooks, writeHooksFile, removeHooksFile, KANGENTIC_EVENTS_PATH_ENV } from './hook-manager';
export { writeMcpConfig, removeMcpConfig, KANGENTIC_MCP_URL_ENV, KANGENTIC_MCP_TOKEN_ENV } from './mcp-config';
export { cleanGrokTranscript } from './transcript-cleanup';
