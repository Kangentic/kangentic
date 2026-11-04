# Source of aider-published-chat-history.md

`aider-published-chat-history.md` is Aider's own published example of the chat history format. It
is not a capture: no Aider session was run to make it, and these runs are from Aider v0.48 to v0.51
(August 2024), far older than the 0.86.2 the adapter targets.

- Source: <https://raw.githubusercontent.com/Aider-AI/aider/v0.86.2/tests/fixtures/chat-history.md>
- Repository: <https://github.com/Aider-AI/aider>, Apache License 2.0
- Tag: `v0.86.2`, commit `253f0368b873ba30d8ee26e463718f0c03614ddf`
- Last changed upstream: commit `4b2227c71f82193cf6edba5dd2117962782cacf2` (2024-08-26)
- Fetched: 2026-11-03

The fixture holds these whole runs, in file order. Each range starts on the run's
`# aider chat started at` header and ends on the blank line before the next one.

| Source lines | Aider version | Why it is here |
|---|---|---|
| 21039-21058 | 0.48.2-dev | `/run` and its output (which holds a raw ESC byte), a `Models:` announcement, and a multi-line prompt whose second line arrives bare |
| 37780-37802 | 0.49.1-dev | `/ask` logged twice, and `Cost: ... request` |
| 42365-42375 | 0.49.2-dev | A `Models:` announcement with one `/ex` and no reply |
| 82863-82878 | 0.50.2-dev | A split report whose Cost half runs straight into the `--no-stream` warning |
| 82918-82933 | 0.50.2-dev | A split report with only a cache hit |
| 86353-86383 | 0.51.1-dev | The split 0.86.2 still writes, with both cache fields, under `Main model:` |
| 96566-96584 | 0.51.2-dev | `--msg /ask`, its echo, and a split report ending in the `--no-stream` warning |

The copy is byte for byte, with one change: the author's home directory became `/home/dev/` in the
logged command lines, because this repository commits no personal home directory paths.
