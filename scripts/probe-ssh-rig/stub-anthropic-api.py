#!/usr/bin/env python3
"""A local stand-in for the Messages API, for running a real Claude Code on an SSH rig host with no account.

The stand-in itself is `FakeAnthropicApi` in scripts/probe-claude-exit-paths-linux.py (the exit-path probe's,
task #854), loaded from beside this file, so the two never drift. This only serves it and writes the port it
took to the file named by the first argument. Claude reaches it through ANTHROPIC_BASE_URL with
ANTHROPIC_AUTH_TOKEN. Used by `scripts/ssh-link-rig.mjs --client update --claude-binary <claude>`.

Usage: python3 -I stub-anthropic-api.py <port file> <path of probe-claude-exit-paths-linux.py>
"""
import importlib.util
import sys
import time

port_file, probe_path = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location('claude_exit_probe', probe_path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
api = probe.FakeAnthropicApi()
with open(port_file, 'w') as handle:
    handle.write(str(api.port))
while True:
    time.sleep(3600)
