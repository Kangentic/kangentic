#!/bin/bash
# The real CLIs the SSH transcript rig runs, pointed at a local stand-in for a model API, so a run costs no
# quota and needs no account. For a throwaway Linux container with Node 24 and this checkout, never a real
# machine: it writes each CLI's config into the home it runs in. .github/workflows/agent-clis.yml runs it
# every night with these same commands, and it runs by hand the same way:
#
#   docker run -d --name kangentic-transcript-rig -e CI=1 --entrypoint sleep node:24-bookworm infinity
#   (copy this checkout to /work without node_modules, and run `npm ci --ignore-scripts` there)
#   docker exec kangentic-transcript-rig bash /work/scripts/probe-ssh-rig/transcript-clis.sh
#   docker exec -w /work kangentic-transcript-rig bash -c '. /root/transcript-rig.env; npx vitest run tests/unit/remote-transcript-real-cli.test.ts'
#
# Every install takes the newest release, which is the point of the nightly: a CLI that changed what
# Kangentic reads shows up here before a user meets it. Each CLI's version lands in
# ~/transcript-rig.versions as "<name><TAB><version>", under the name its test title starts with, so
# scripts/probe-ssh-rig/transcript-summary.mjs can say which version a red test ran against.
#
# A step that fails is recorded and the script goes on, so one vendor's outage names that vendor and the
# other CLIs still install and run. It exits 1 at the end when anything failed.
#
# Results of the first hand runs and what they showed: docs/audits/ssh-transcript-exports-audit.md.
set -uo pipefail

STUB_PORT=18080
VERSIONS_FILE="$HOME/transcript-rig.versions"
: > "$VERSIONS_FILE"

# What failed, as "<name>: <what>" lines.
FAILURES=()
fail() {
  FAILURES+=("$1: $2")
  echo "::error title=$1::$2"
}

# Run one install. `$1` is the CLI's name and the rest is the command.
install_cli() {
  local name=$1
  shift
  if ! "$@"; then
    fail "$name" "its install failed, so its test below will fail too"
  fi
}

apt-get update -qq
apt-get install -y -qq --no-install-recommends bzip2 libxcb1 libgomp1 python3-venv > /dev/null

install_kimi() {
  curl -fsSL https://code.kimi.com/kimi-code/install.sh -o /tmp/kimi-install.sh && bash /tmp/kimi-install.sh < /dev/null
}
install_goose() {
  curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh -o /tmp/goose-install.sh && CONFIGURE=false bash /tmp/goose-install.sh < /dev/null
}
install_aider() {
  python3 -m venv "$HOME/aider" && "$HOME/aider/bin/pip" install --quiet aider-chat
}
install_droid() {
  curl -fsSL https://app.factory.ai/cli -o /tmp/droid-install.sh && bash /tmp/droid-install.sh < /dev/null
}

install_cli "Kimi" install_kimi
install_cli "Goose" install_goose
install_cli "OpenCode 1" npm install --no-audit --no-fund --prefix "$HOME/oc1" opencode-ai
install_cli "OpenCode 2" npm install --no-audit --no-fund --prefix "$HOME/oc2" @opencode/cli
install_cli "Codex" npm install --no-audit --no-fund --prefix "$HOME/codex" @openai/codex
install_cli "Gemini" npm install --no-audit --no-fund --prefix "$HOME/gemini" @google/gemini-cli
install_cli "Aider" install_aider
install_cli "Droid" install_droid

# A login shell here does not add ~/.local/bin, and Goose's installer says so. The helper finds a CLI through
# that shell, so its PATH is where a user would put it.
grep -q 'transcript rig' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH" # transcript rig' >> "$HOME/.bashrc"

mkdir -p "$HOME/.kimi-code"
cat > "$HOME/.kimi-code/config.toml" <<EOF
default_model = "stub"

[providers.stub]
type = "openai"
base_url = "http://127.0.0.1:$STUB_PORT/v1"
api_key = "stub"

[models.stub]
provider = "stub"
model = "stub-model"
protocol = "openai"
max_context_size = 100000
EOF
mkdir -p "$HOME/.codex" "$HOME/.gemini" "$HOME/.factory"
# A hand-written provider, since `wire_api = "responses"` is the only dialect Codex speaks.
cat > "$HOME/.codex/config.toml" <<EOF
model = "stub-model"
model_provider = "stub"
check_for_update_on_startup = false

[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:$STUB_PORT/v1"
wire_api = "responses"
env_key = "STUB_API_KEY"
EOF
cat > "$HOME/.gemini/settings.json" <<EOF
{"security":{"auth":{"selectedType":"gemini-api-key"}}}
EOF
cat > "$HOME/.factory/settings.json" <<EOF
{"customModels":[{"id":"custom:stub","model":"stub-model","displayName":"stub","baseUrl":"http://127.0.0.1:$STUB_PORT/v1","apiKey":"stub","provider":"generic-chat-completion-api"}]}
EOF
# Each major gets its own data folders, as two machines would: OpenCode 2 migrates a database 1 also reads.
wrap_opencode() {
  local major=$1 binary=$2
  local root="$HOME/opencode-$major"
  mkdir -p "$root/config/opencode"
  cat > "$root/config/opencode/opencode.json" <<EOF
{"\$schema":"https://opencode.ai/config.json","autoupdate":false,"model":"stub/stub-model","provider":{"stub":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:$STUB_PORT/v1","apiKey":"stub"},"models":{"stub-model":{"name":"stub-model"}}}}}
EOF
  cat > "$root/opencode" <<EOF
#!/bin/sh
export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache"
exec "$binary" "\$@"
EOF
  chmod +x "$root/opencode"
}
wrap_opencode 1 "$HOME/oc1/node_modules/.bin/opencode"
wrap_opencode 2 "$HOME/oc2/node_modules/@opencode/cli-linux-x64/bin/opencode"

cat > "$HOME/transcript-rig.env" <<EOF
export KANGENTIC_TRANSCRIPT_RIG=1
export PATH="$HOME/.kimi-code/bin:$HOME/.local/bin:$HOME/codex/node_modules/.bin:$HOME/gemini/node_modules/.bin:$HOME/aider/bin:\$PATH"
export OPENCODE1_BIN="$HOME/opencode-1/opencode"
export OPENCODE2_BIN="$HOME/opencode-2/opencode"
export STUB_API_KEY=stub
export STUB_BASE_URL=http://127.0.0.1:$STUB_PORT
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:$STUB_PORT GEMINI_API_KEY=stub
export KIMI_CODE_TRUST_WORKSPACE=1
export KIMI_CODE_NO_AUTO_UPDATE=1
export GOOSE_PROVIDER=openai OPENAI_HOST=http://127.0.0.1:$STUB_PORT OPENAI_API_KEY=stub GOOSE_MODEL=stub-model
export GOOSE_DISABLE_KEYRING=1 GOOSE_TELEMETRY_ENABLED=false
EOF

nohup python3 "$(dirname "$0")/stub-model-api.py" "$STUB_PORT" > /dev/null 2>&1 &
# The stand-in answers any GET with its model list. Wait for that, up to ten seconds, not for a fixed time.
stub_ready=0
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$STUB_PORT/v1/models" 2> /dev/null; then
    stub_ready=1
    break
  fi
  sleep 0.2
done
if [ "$stub_ready" != "1" ]; then
  fail "Stand-in model" "it did not answer on port $STUB_PORT within ten seconds, so every CLI's turn will fail"
fi

# Record one CLI's version under the name its test title starts with. A CLI that cannot print its
# version is not installed, whatever its installer's exit said.
record_version() {
  local name=$1
  shift
  local output version
  if output=$("$@" 2>&1); then
    version=$(printf '%s\n' "$output" | awk 'NF { line = $0 } END { print line }')
    printf '%s\t%s\n' "$name" "$version" >> "$VERSIONS_FILE"
    printf '%s: %s\n' "$name" "$version"
  else
    printf '%s\t%s\n' "$name" "not installed" >> "$VERSIONS_FILE"
    fail "$name" "it did not print a version, so it is not installed"
  fi
}
record_version "Kimi" "$HOME/.kimi-code/bin/kimi" --version
record_version "Goose" "$HOME/.local/bin/goose" --version
record_version "OpenCode 1" "$HOME/opencode-1/opencode" --version
record_version "OpenCode 2" "$HOME/opencode-2/opencode" --version
record_version "Codex" "$HOME/codex/node_modules/.bin/codex" --version
record_version "Gemini" "$HOME/gemini/node_modules/.bin/gemini" --version
record_version "Aider" "$HOME/aider/bin/aider" --version
record_version "Droid" "$HOME/.local/bin/droid" --version

# Off by default on 0.167.0. Once this reads true, a cold rollout is `.jsonl.zst`, which Kangentic's readers do
# not match (docs/integrations/agents/codex-cli.md, Limitations). Printed, and never a failure: it is a note of
# what is coming, and the Codex test is what says whether a reader broke.
CODEX_HOME="$HOME/.codex" "$HOME/codex/node_modules/.bin/codex" features list 2> /dev/null | grep local_thread_store_compression || echo "Codex no longer lists local_thread_store_compression."

# A first run fetches the provider package, so the test's own turn does not race it.
cd "$HOME"
if ! "$HOME/opencode-1/opencode" run --pure -m stub/stub-model "warm up" > /tmp/opencode-1-warm-up.log 2>&1; then
  tail -n 5 /tmp/opencode-1-warm-up.log
  fail "OpenCode 1" "its warm-up run failed (its last lines are above)"
fi
if ! "$HOME/opencode-2/opencode" run --standalone -m stub/stub-model "warm up" > /tmp/opencode-2-warm-up.log 2>&1; then
  tail -n 5 /tmp/opencode-2-warm-up.log
  fail "OpenCode 2" "its warm-up run failed (its last lines are above)"
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo
  echo "${#FAILURES[@]} step(s) failed:"
  printf '  %s\n' "${FAILURES[@]}"
  exit 1
fi
echo
echo "Every CLI installed and printed a version."
