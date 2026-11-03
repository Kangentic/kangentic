---
type: Audit
title: SSH remote agents, first-time setup audit
description: "Results of the Add host steps for running agents on a Linux host over SSH (2026-11-03), run against a real sshd that takes a password: the fingerprint matches the host's own, a different key is refused, a key made with the password is added once and signs in with no prompt, a changed key is refused until forgotten, and the key is deleted with the host."
tags: [audit, ssh, remote, setup, host-key]
sources:
  - resource: src/main/remote/ssh-setup.ts
  - resource: src/main/remote/ssh-host-admin.ts
  - resource: scripts/ssh-setup-rig.mjs
  - resource: scripts/ssh-setup-rig.client.ts
---
# SSH remote agents, first-time setup audit (2026-11-03)

Adding a host has to work without a terminal, without asking for a passphrase, and without a
reconnect ever prompting. The design is in `docs/platforms/ssh-remote.md`. This audit records the real
steps run against a real `sshd`, because the unit tests (`ssh-setup.test.ts`, `ssh-host-admin.test.ts`)
replace the `ssh` program with a fake.

## Method

`scripts/ssh-setup-rig.mjs` starts the `kangentic-ssh-rig` container with user `dev` set to sign in
with a password, then runs `scripts/ssh-setup-rig.client.ts`, which calls the same functions the Add
host flow calls (`src/main/remote/ssh-setup.ts`). The client uses a scratch ssh config (`-F`) and a
scratch `known_hosts`, so nothing touches the user's own `~/.ssh`. The machine is Windows 11 with
System32 `ssh.exe` (OpenSSH for Windows 9.5p2) and Docker Desktop.

## Result

**15 of 15 steps passed.**

| Step | Result |
| --- | --- |
| Find the ssh client | Found, version line reported |
| Learn the host key without trusting it | ssh-ed25519, fingerprint read from a throwaway connection |
| The fingerprint is the host's own | Matched what the host reports for its key |
| Pin the key in `known_hosts` | Written once, as `[127.0.0.1]:2262 ssh-ed25519 ...` |
| Refuse a key other than the one shown | Refused, nothing written |
| Make a key with no passphrase | ed25519, no prompt |
| A wrong password | Shown in ssh's own words (`Permission denied (publickey,password)`) |
| The key does not sign in before it is added | Confirmed |
| Add the key with the password, once | No error |
| Sign in with the key, no prompt | Signed in |
| Adding it again | Still one line in `authorized_keys` |
| A host whose key changed | Refused with ssh's warning |
| Forget the old key | Only that entry removed |
| Trust the host again and sign in | Signed in |
| Delete the key with the host | Gone |

## What this does not cover

- A jump host, a certificate, a FIDO key and an `ssh-agent` key, which the user's SSH config handles and
  Kangentic only passes through. Phase 0 measured the jump-host behavior (`ssh-remote-phase-0-audit.md`).
- macOS and Linux clients. The rig ran on Windows only.
- A host that allows only keyboard-interactive or one-time-code sign-in. The password step uses
  `PubkeyAuthentication=no` with an askpass program, and such a host shows ssh's raw error.
