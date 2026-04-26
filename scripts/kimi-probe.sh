#!/usr/bin/env bash
# Empirical probe of Kimi CLI behavior. Writes outputs into /tmp/kimi-probe/
# so they can be inspected without piping.
set -e

OUT=/tmp/kimi-probe
rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Stream-json print mode (the structured non-interactive output)
kimi --print --output-format stream-json --prompt "Say hi in one word" --yolo >"$OUT/stream.jsonl" 2>"$OUT/stream.err"
echo "exit=$?" >>"$OUT/stream.err"

# 2. List sessions for this work_dir AFTER running the probe
ls -la ~/.kimi/sessions/ >"$OUT/sessions-after.txt"

# 3. Capture the freshly-created session dir's contents
LATEST=$(ls -t ~/.kimi/sessions/ | head -1)
echo "$LATEST" >"$OUT/latest-hash.txt"
ls -la ~/.kimi/sessions/$LATEST/ >"$OUT/latest-hash-listing.txt"

# 4. Find the newest session UUID in that hash dir and copy its files
NEWEST=$(ls -t ~/.kimi/sessions/$LATEST/ | head -1)
echo "$NEWEST" >"$OUT/newest-session.txt"
ls -la ~/.kimi/sessions/$LATEST/$NEWEST/ >"$OUT/newest-session-listing.txt"
cp ~/.kimi/sessions/$LATEST/$NEWEST/*.jsonl "$OUT/" 2>/dev/null || true

echo "DONE"
