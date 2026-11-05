#!/bin/bash
# The real CLIs the SSH transcript rig runs, pointed at a local stand-in for a model API, so a run costs no
# quota and needs no account. For a throwaway Linux container with Node 24 and this checkout, never a real
# machine: it writes each CLI's config into the home it runs in. Not used by CI.
#
#   docker run -d --name kangentic-transcript-rig -e CI=1 --entrypoint sleep node:24-bookworm infinity
#   (copy this checkout to /work without node_modules, and run `npm ci --ignore-scripts` there)
#   docker exec kangentic-transcript-rig bash /work/scripts/probe-ssh-rig/transcript-clis.sh
#   docker exec -w /work kangentic-transcript-rig bash -c '. /root/transcript-rig.env; npx vitest run tests/unit/remote-transcript-real-cli.test.ts'
#
# Results and what they showed: docs/audits/ssh-transcript-exports-audit.md.
set -uo pipefail

STUB_PORT=18080
apt-get update -qq
apt-get install -y -qq --no-install-recommends bzip2 libxcb1 libgomp1 > /dev/null

curl -fsSL https://code.kimi.com/kimi-code/install.sh -o /tmp/kimi-install.sh
bash /tmp/kimi-install.sh < /dev/null
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh -o /tmp/goose-install.sh
CONFIGURE=false bash /tmp/goose-install.sh < /dev/null
npm install --no-audit --no-fund --prefix "$HOME/oc1" opencode-ai
npm install --no-audit --no-fund --prefix "$HOME/oc2" @opencode/cli

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
export PATH="$HOME/.kimi-code/bin:$HOME/.local/bin:\$PATH"
export OPENCODE1_BIN="$HOME/opencode-1/opencode"
export OPENCODE2_BIN="$HOME/opencode-2/opencode"
export KIMI_CODE_TRUST_WORKSPACE=1
export KIMI_CODE_NO_AUTO_UPDATE=1
export GOOSE_PROVIDER=openai OPENAI_HOST=http://127.0.0.1:$STUB_PORT OPENAI_API_KEY=stub GOOSE_MODEL=stub-model
export GOOSE_DISABLE_KEYRING=1 GOOSE_TELEMETRY_ENABLED=false
EOF

nohup python3 "$(dirname "$0")/stub-model-api.py" "$STUB_PORT" > /dev/null 2>&1 &
sleep 1
"$HOME/.kimi-code/bin/kimi" --version
"$HOME/.local/bin/goose" --version
"$HOME/opencode-1/opencode" --version
"$HOME/opencode-2/opencode" --version
# A first run fetches the provider package, so the test's own turn does not race it.
cd "$HOME"
"$HOME/opencode-1/opencode" run --pure -m stub/stub-model "warm up" > /dev/null 2>&1
"$HOME/opencode-2/opencode" run --standalone -m stub/stub-model "warm up" > /dev/null 2>&1
