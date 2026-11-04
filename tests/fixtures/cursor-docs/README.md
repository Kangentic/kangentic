# Cursor's published examples

Fetched 2026-11-03. These are the examples Cursor prints in its docs, copied verbatim. They are not
captures: nothing here came from a running Cursor, and no capture is planned.

| File | Source |
|---|---|
| `hooks-reference-examples.md` | [Hooks](https://cursor.com/docs/hooks), the Reference section and the Configuration file block |
| `output-format-example-sequence.jsonl` | [Output format](https://cursor.com/docs/cli/reference/output-format), Example sequence |

The stream-json sequence is real JSON, one event per line. The hook examples are schemas: they carry
`// Input` and `// Output` comments, placeholders such as `"<user prompt text>"`, and unions such as
`"status": "completed" | "aborted" | "error"`. `cursor-hook-config.test.ts` expands them without
editing this copy.

Replaying them proves the code reads the field names and shapes Cursor publishes. It does not prove
that a given Cursor build fires a hook or sends those fields. See
`docs/integrations/agents/cursor-cli.md`.
