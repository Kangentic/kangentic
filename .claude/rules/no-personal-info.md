# Rule: no personal or machine-specific info in committed code

The repository is going public. Hardcoded usernames, emails, or machine-specific absolute paths
leak personal data and break on other machines.

## The rule

Never hardcode personal or machine-specific values in committed code, tests, scripts, or docs:

- No personal usernames, emails, or home-directory paths (a real `C:\Users\<name>` or
  `/Users/<name>`). Use generic placeholders like `C:\Users\dev` in tests and examples -
  including in anti-examples like this one, which otherwise embed the very string they ban.
- No machine-specific absolute paths. Derive paths at runtime (configDir, `app.getPath`,
  `__dirname`, env vars) instead of hardcoding them.
- Keep all committed code environment-agnostic.

## Enforcement (self-maintaining)

- **Review:** the `platform-guard` agent flags hardcoded paths (check 2, "`C:\Users\` must have
  platform guards") and personal paths in tests (check 6, never a real user's home path), and
  `/code-review` flags personal data.
- No dedicated mechanical test yet. Given the public-repo stakes, a scan for home-directory path
  patterns (a `C:\Users\<name>` other than `dev`, `/Users/<name>`, `/home/<name>`) and email
  literals is a strong candidate future test.

## Scope

All committed files. Does not apply to local-only, gitignored files (`CLAUDE.local.md`,
`.kangentic/`, `kangentic.local.json`) or to a developer's own machine config outside the repo.
