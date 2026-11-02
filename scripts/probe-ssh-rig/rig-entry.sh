#!/bin/sh
# Installs the scratch public key the run named, then runs sshd in the foreground
# with key sign-in only, the way the feature expects a host to be set up.
# Dockerfile.systemd carries the same key install, so change the two together.
set -eu

if [ -z "${AUTHORIZED_KEY:-}" ]; then
  echo "rig-entry: AUTHORIZED_KEY is not set" >&2
  exit 1
fi

printf '%s\n' "$AUTHORIZED_KEY" > /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys
chown dev:dev /home/dev/.ssh/authorized_keys

ssh-keygen -A
exec /usr/sbin/sshd -D -e \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o PermitRootLogin=no
