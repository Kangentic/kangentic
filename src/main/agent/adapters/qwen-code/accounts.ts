import type { KeyFileAccountSupport } from '../../../accounts/account-support';

/**
 * Qwen Code accounts (task #1057). BUILT, NOT ENABLED: the adapter does not declare this, so Qwen
 * has no card in Settings > Accounts. To enable it, add `readonly accounts = QWEN_ACCOUNT_SUPPORT`
 * to `QwenAdapter` and the agent to `tests/unit/agent-accounts-enabled.test.ts`, once one session
 * has been run with a key file and seen to use its key.
 *
 * Each account would be an API key in a file the user owns, put in the session's env at spawn.
 * Qwen Code's login is a key, not a signed-in user: `/auth` stores one under the variable the
 * chosen provider names (`modelProviders.<type>[].envKey`), and Qwen reads a variable from the
 * process env first, then its `.env` files, then `settings.env`, each only when still unset
 * (0.21.7 and 0.26.5 bundles). So a key file that sets that variable is the account, whatever the
 * user's own files hold. These are the names its built-in providers use; a custom provider's is
 * generated, hence the prefix. Nothing here has been run.
 *
 * A folder per account (`QWEN_HOME`) was researched and rejected: an account folder still reads
 * the user's own `~/.qwen/.env`, the file-history folder cannot be shared, and Qwen names no
 * signed-in user to tell accounts apart (docs/integrations/accounts.md).
 */
export const QWEN_ACCOUNT_SUPPORT: KeyFileAccountSupport = {
  kind: 'key-file',
  keyEnvVars: [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'DASHSCOPE_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY', 'BAILIAN_TOKEN_PLAN_API_KEY',
    'QWENCLOUD_API_KEY', 'QWENCLOUD_TOKEN_PLAN_API_KEY', 'OPENROUTER_API_KEY', 'REQUESTY_API_KEY',
    'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MINIMAX_API_KEY', 'ZAI_API_KEY', 'MODELSCOPE_API_KEY',
    'IDEALAB_API_KEY', 'QWEN_CUSTOM_API_KEY_*',
  ],
  // A key-file account sets these itself, over whatever Kangentic inherited.
  overridingCredentialEnvVars: [],
};
