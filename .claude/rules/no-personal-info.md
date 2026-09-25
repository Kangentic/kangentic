# Rule: no personal or machine-specific info in committed code

The repository is going public. Hardcoded usernames, emails, or machine-specific absolute paths
leak personal data and break on other machines. Naming the client or site where a bug turned up
leaks who the team works for.

## The rule

Never hardcode personal or machine-specific values in committed code, tests, scripts, or docs:

- No personal usernames, emails, or home-directory paths (a real `C:\Users\<name>` or
  `/Users/<name>`). Use generic placeholders like `C:\Users\dev` in tests and examples -
  including in anti-examples like this one, which otherwise embed the very string they ban.
- No machine-specific absolute paths. Derive paths at runtime (configDir, `app.getPath`,
  `__dirname`, env vars) instead of hardcoding them.
- Keep all committed code environment-agnostic.
- No client, customer, or employer names, their sites or domains, or anything that says where a
  bug or request was found. Describe the mechanism instead ("a web application firewall that
  rejects the `Electron/` token"), and do not keep identifying details such as a specific URL,
  file size, or page name. This covers commit messages, PR titles and bodies, and docs decision
  logs as well as code, because they are all public.

## Enforcement (self-maintaining)

- **Review:** the `platform-guard` agent flags hardcoded paths (check 2, "`C:\Users\` must have
  platform guards") and personal paths in tests (check 6, never a real user's home path), and
  `/code-review` flags personal data.
- Client names and request origins are review-only and cannot be scanned for: there is no list
  of names to match against, and keeping one in the repo would publish it.
- No dedicated mechanical test yet. Given the public-repo stakes, a scan for home-directory path
  patterns (a `C:\Users\<name>` other than `dev`, `/Users/<name>`, `/home/<name>`) and email
  literals is a strong candidate future test.

## Scope

All committed files. Does not apply to local-only, gitignored files (`CLAUDE.local.md`,
`.kangentic/`, `kangentic.local.json`) or to a developer's own machine config outside the repo.
