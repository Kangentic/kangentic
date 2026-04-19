#!/bin/sh
# POSIX sh -- Alpine and other minimal CI images may not ship bash.
exec node "$(dirname "$0")/mock-claude-bgbash.js" "$@"
