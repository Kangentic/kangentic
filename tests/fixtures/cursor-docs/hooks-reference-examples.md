# Cursor hooks reference: published examples

Copied verbatim from https://cursor.com/docs/hooks (raw page https://cursor.com/docs/hooks.md), fetched 2026-11-03.
Each heading and code block below is Cursor's own text. These are published examples, not captures.
See README.md in this folder.

#### Input (all hooks)

```json
{
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "model_id": "string",
  "model_params": [{ "id": "string", "value": "string" }],
  "hook_event_name": "string",
  "cursor_version": "string",
  "workspace_roots": ["<path>"],
  "user_email": "string | null",
  "transcript_path": "string | null"
}
```

#### preToolUse

```json
// Input
{
  "tool_name": "Shell",
  "tool_input": { "command": "npm install", "working_directory": "/project" },
  "tool_use_id": "abc123",
  "cwd": "/project",
  "model": "claude-opus-4-7-thinking-max",
  "model_id": "claude-opus-4-7",
  "model_params": [
    { "id": "thinking", "value": "true" },
    { "id": "context", "value": "1m" },
    { "id": "effort", "value": "max" }
  ],
  "agent_message": "Installing dependencies..."
}

// Output
{
  "permission": "allow" | "deny",
  "user_message": "<message shown in client when denied>",
  "agent_message": "<message sent to agent when denied>",
  "updated_input": { "command": "npm ci" }
}
```

#### postToolUse

```json
// Input
{
  "tool_name": "Shell",
  "tool_input": { "command": "npm test" },
  "tool_output": "{\"exitCode\":0,\"stdout\":\"All tests passed\"}",
  "tool_use_id": "abc123",
  "cwd": "/project",
  "duration": 5432,
  "model": "claude-opus-4-7-thinking-max",
  "model_id": "claude-opus-4-7",
  "model_params": [
    { "id": "thinking", "value": "true" },
    { "id": "context", "value": "1m" },
    { "id": "effort", "value": "max" }
  ]
}

// Output
{
  "updated_mcp_tool_output": { "modified": "output" },
  "additional_context": "Test coverage report attached."
}
```

#### postToolUseFailure

```json
// Input
{
  "tool_name": "Shell",
  "tool_input": { "command": "npm test" },
  "tool_use_id": "abc123",
  "cwd": "/project",
  "error_message": "Command timed out after 30s",
  "failure_type": "timeout" | "error" | "permission_denied",
  "duration": 5000,
  "is_interrupt": false
}

// Output
{
  "additional_context": "Tests time out on CI runners. Retry with --maxWorkers=2."
}
```

#### subagentStart

```json
// Input
{
  "subagent_id": "abc-123",
  "subagent_type": "generalPurpose",
  "task": "Explore the authentication flow",
  "parent_conversation_id": "conv-456",
  "tool_call_id": "tc-789",
  "subagent_model": "claude-sonnet-4-20250514",
  "is_parallel_worker": false,
  "git_branch": "feature/auth"
}

// Output
{
  "permission": "allow" | "deny",
  "user_message": "<message shown when denied>"
}
```

#### subagentStop

```json
// Input
{
  "subagent_type": "generalPurpose",
  "status": "completed" | "error" | "aborted",
  "task": "Explore the authentication flow",
  "description": "Exploring auth flow",
  "summary": "<subagent output summary>",
  "duration_ms": 45000,
  "message_count": 12,
  "tool_call_count": 8,
  "loop_count": 0,
  "modified_files": ["src/auth.ts"],
  "agent_transcript_path": "/path/to/subagent/transcript.txt"
}

// Output
{
  "followup_message": "<auto-continue with this message>"
}
```

#### beforeSubmitPrompt

```json
// Input
{
  "prompt": "<user prompt text>",
  "attachments": [
    {
      "type": "file" | "rule",
      "file_path": "<absolute path>"
    }
  ]
}

// Output
{
  "continue": true | false,
  "user_message": "<message shown to user when blocked>"
}
```

#### stop

```json
// Input
{
  "status": "completed" | "aborted" | "error",
  "loop_count": 0
}
```

#### sessionStart

```json
// Input
{
  "session_id": "<unique session identifier>",
  "is_background_agent": true | false,
  "composer_mode": "agent" | "ask" | "edit"
}
```

#### sessionEnd

```json
// Input
{
  "session_id": "<unique session identifier>",
  "reason": "completed" | "aborted" | "error" | "window_close" | "user_close",
  "duration_ms": 45000,
  "is_background_agent": true | false,
  "final_status": "<status string>",
  "error_message": "<error details if reason is 'error'>"
}
```

#### preCompact

```json
// Input
{
  "trigger": "auto" | "manual",
  "context_usage_percent": 85,
  "context_tokens": 120000,
  "context_window_size": 128000,
  "message_count": 45,
  "messages_to_compact": 30,
  "is_first_compaction": true | false
}
```

### Configuration file

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./session-init.sh" }],
    "sessionEnd": [{ "command": "./audit.sh" }],
    "preToolUse": [
      {
        "command": "./hooks/validate-tool.sh",
        "matcher": "Shell|Read|Write"
      }
    ],
    "postToolUse": [{ "command": "./hooks/audit-tool.sh" }],
    "subagentStart": [{ "command": "./hooks/validate-subagent.sh" }],
    "subagentStop": [{ "command": "./hooks/audit-subagent.sh" }],
    "beforeShellExecution": [{ "command": "./script.sh" }],
    "afterShellExecution": [{ "command": "./script.sh" }],
    "afterMCPExecution": [{ "command": "./script.sh" }],
    "afterFileEdit": [{ "command": "./format.sh" }],
    "preCompact": [{ "command": "./audit.sh" }],
    "stop": [{ "command": "./audit.sh", "loop_limit": 10 }],
    "beforeTabFileRead": [{ "command": "./redact-secrets-tab.sh" }],
    "afterTabFileEdit": [{ "command": "./format-tab.sh" }],
    "workspaceOpen": [{ "command": "./register-workspace-plugins.sh" }]
  }
}
```
