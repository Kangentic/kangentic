# Kangentic Mobile: Research and Recommended Architecture

Research date: 2026-07-09. Produced by five parallel research tracks (P2P transport, mobile
framework, push notifications, pairing/security, desktop codebase seams), each grounded in
primary sources with adversarial verification of load-bearing claims. This document is the
durable synthesis; the follow-up board tasks reference it.

## 1. Product goal

A mobile companion app (kangentic-mobile) that lets a user walk away from their PC while
Kangentic tasks run, then from their phone: get notified when an agent goes idle or needs
attention, read the live conversation, see code changes, send messages back to steer the
agent, and move tasks along the board. Agent-focused, for projects already set up on desktop.
No hosting required of the end user. Security is paramount: the connection ultimately steers
an agent that can edit code and run commands on the desktop, and the protocol is public
(open source), so it must be designed like a remote-access product.

## 2. Landscape and prior art

- **Happy (slopus/happy, MIT, ~22.5k stars, active)** is the closest analog: an open-source
  E2E-encrypted mobile client for Claude Code. Architecture: CLI wrapper encrypts client-side,
  pushes blobs through a self-hostable relay (`HAPPY_SERVER_URL` override), Expo/React Native
  app decrypts. Proves the entire stack shape end to end. Its security flaws are our
  differentiation checklist: the QR contains the raw 32-byte master secret, one key is reused
  for both encryption and signing identity, the legacy path has no forward secrecy, and
  notification copy transits Expo/FCM/APNs in plaintext despite E2E claims.
- **Omnara** (YC S25): archived its Apache-2.0 CLI wrapper in Feb 2026 ("unfeasible to
  maintain"), rebuilt closed-source on the Claude Agent SDK, not E2E.
- **Anthropic Remote Control** (research preview ~Feb 2026): official phone-to-desktop for
  Claude Code via claude.ai and the Claude mobile apps. "Your local Claude Code session makes
  outbound HTTPS requests only and never opens inbound ports"; traffic rides the Anthropic API
  over TLS; claude.ai OAuth only ("API keys are not supported"); not E2E; not self-hostable.
  Strategic read: Anthropic validated the outbound-only vendor-relay topology. Kangentic's
  differentiators are the board/multi-session UX, multi-agent support (Codex, Gemini, etc.),
  API-key users, true E2E encryption, and self-hosting.
- Everything else splits into "local web server you expose yourself" (claudecodeui, cui) or
  "vendor cloud execution" (Terragon, shut down). Happy is the only prominent zero-knowledge
  relay. Vibe Kanban's remote answer was Tailscale + Caddy.

## 3. Recommended architecture (one paragraph)

Desktop and phone each hold a long-lived device identity key. They pair once via a QR ceremony
(public key + single-use high-entropy token used as a Noise PSK + numeric comparison code). Both sides dial OUT to a tiny
vendor-hosted, self-hostable "blind" relay that forwards only ciphertext frames; every session
runs a Noise KK handshake inside that pipe, so the relay authenticates nothing and reads
nothing. A WebRTC data channel upgrade punches a direct P2P path for the ~80% of network pairs
that allow it (signaling over the already-secure channel, DTLS fingerprints pinned at pairing),
with the relay as permanent fallback, the same model as Tailscale DERP. Wake-ups ride Expo
Push as E2E-encrypted blobs decrypted on-device. On top of the encrypted channel sits a
desktop-enforced capability allowlist per paired device; the protocol contains no shell, file,
or command verb at all.

```
  Desktop (Electron main)                       Phone (Expo / React Native)
  mobile-bridge module                          kangentic-mobile app
  - device identity + roster    QR pairing      - device identity (Keychain/
  - capability router          <=============>    Keystore)
  - session/board/diff feeds    (PSK + SAS)    - board + conversation UI
        |                                              |
        |  outbound WSS                  outbound WSS  |
        +-----------> [ blind relay ] <----------------+
        |             (ciphertext only,                |
        |              self-hostable)                  |
        +===== Noise KK secure channel (E2E) ==========+
        +---- WebRTC data channel upgrade (direct P2P when possible) ----+
        +---- Expo Push (E2E-encrypted blob -> NSE / FCM handler) ------>+
```

## 4. Transport decision

### FINAL DECISION (after networking deep-dive): relay-first (Option C), one bandwidth-included VPS

The build sequence is **Option C**: ship the relay as the v1 foundation (it makes the product
work on 100% of networks with the least code and a runaway-proof fixed cost), then add WebRTC
P2P + IPv6-first as a later phase for speed. This is Happy's exact model, made cheaper (owned
VPS instead of their hosted relay) and more secure (the section-5 pairing fixes Happy's flaws).

**Hosting for the v1 relay: LOCKED to `Hetzner` (a bandwidth-included VPS). Azure is ruled out;
DigitalOcean is the noted alternative.** The relay's whole job is byte-forwarding, so the deciding
factor is bandwidth pricing, and Hetzner's 20 TB included (vs DigitalOcean's 1 TB) is decisive and
the most runaway-proof:

- **Hetzner** (~EUR 5.49/mo, CX23): 20 TB transfer included, ~EUR 1/TB overage. Absolute
  cost-minimizer; even 50,000 users relaying everything (~21 TB/mo) is one flat ~EUR 5-20/mo box.
- **DigitalOcean** (~USD 6/mo Basic Droplet): 1 TB included (pooled), USD 0.01/GB overage, ~10
  global regions (broader than Hetzner), USD 200 new-user credit. Trades a little bandwidth cost
  for global reach (the "place the relay near users for lower latency" speed lever) and friendlier
  ops. Stays under ~USD 10/mo well into the thousands of users; overage is 9x gentler than Azure.
- **Azure: ruled out for the data path.** Managed TURN (ACS Network Traversal) was retired
  2024-03-31, and VM egress is USD 0.087/GB after only 100 GB free (vs Hetzner's included 20 TB
  and DO's USD 0.01/GB). Azure Web PubSub/SignalR bill by reserved unit-capacity (~USD 49/unit/mo
  per 1,000 connections = ~USD 2,449/mo to hold 50k idle sockets), a cost trap for idle
  connections. Use Azure only if residency is mandatory, and even then only for signaling on a
  B-series VM, never the relay.

**Cloudflare's role is phased, not a v1 data-path dependency:**

- v1: optional free Cloudflare proxy in front of the VPS (DDoS absorption, TLS, origin-IP
  hiding). Free. Not required.
- Phase 3 (P2P speed): optionally offload WebRTC signaling to Cloudflare Durable Objects
  (hibernated WebSockets, ~USD 5/mo) and use Cloudflare Realtime TURN (USD 0.05/GB after 1 TB
  free) as the thin fallback relay. NEVER relay bulk traffic through a Durable Object: DOs bill
  by wall-clock duration while held open (~USD 255/mo at 5k users, ~USD 2,570 at 50k) - the
  single most important Cloudflare cost finding. Signaling on DO (cheap) + TURN for bytes (cheap)
  is the right split; a held-open DO relay is the wrong one.

**Runaway-bill guards (critical requirement, host-independent):** a fixed VPS with metered
overage at USD 0.001-0.01/GB physically cannot produce a scary bill (20 TB of abuse = pennies to
a few dollars). Layered on top: only paired devices get a relay slot (the single-use pairing
token gates relay use), per-pairing rate limits, per-session byte caps, connection caps, and the
free Cloudflare proxy for volumetric DDoS. In the Phase-3 TURN era, Cloudflare's dashboard
spend-cap + free-tier alerts are the guard.

**Expected relay usage (sizes the fallback):** ~15% of connections typical, 20-25% worst case
for this topology (phone on LTE, desktop at home). Home routers are almost never the blocker
(<2% symmetric NAT); the tail is driven by the cellular side (~40% symmetric). IPv6-first
matters: US carriers are now 87-95% IPv6, and ~1/3 of IPv6 home gateways do not firewall inbound,
so the Phase-3 upgrade can push direct-connection rates toward 95% and shrink the relay to near
zero. Signaling must live on infrastructure we control (VPS or Cloudflare), NEVER public Nostr
relays (50-60% of 2023 blue-chip relays are now dead or pay-to-write; Trystero's author was
accused of DDoSing them).

### Why relay-first wins over pure P2P as the foundation:

1. **The CGNAT tail is real.** ~92% of cellular networks deploy CGNAT (Richter et al., ACM IMC
   2016). Every P2P stack concedes a relay tail: Tailscale "well north of 90%" direct, iroh
   "roughly 9 out of 10", Holepunch ~95% (vendor claim), libp2p ~70% measured. A companion app
   that fails to connect 5-15% of the time, concentrated exactly when the user is away from
   home, is broken.
2. **Every "serverless" option still has someone's servers in it.** iroh: n0's public relays
   are "suitable for development and hobby use only" (production = paid managed relays or
   self-host). Hyperswarm: three Holepunch-run bootstrap nodes and no public relay fleet for
   third-party apps. The question was never "servers or no servers"; it is whose servers, what
   they can read, and whether users can replace them.
3. **Push requires a sender anyway** (section 6), and mobile OSes kill background sockets
   (section 6), so the phone is structurally a foreground, reconnect-often client. A rendezvous
   a server can hold open beats a hole punch re-executed on every foreground.
4. **Cost is trivial:** Cloudflare's own Durable Objects pricing example puts 10,000 idle
   WebSocket connections at roughly $10/month. The Bitwarden/Home Assistant/Syncthing pattern
   (vendor-run default + self-host escape hatch) is the industry convergence.

Honest metadata statement (publish this in security docs): a blind relay still sees source and
destination IPs, connection timing, frame sizes/frequency, and the pairing graph. Mitigations:
self-hosting, single-use pairing tokens, relay slot tokens so only paired devices consume
capacity.

### Upgrade layer: WebRTC data channels (direct P2P for bandwidth/latency)

- Desktop: **node-datachannel** (libdatachannel N-API bindings, MPL-2.0, active, "supports
  Electron", prebuilt Win/macOS/Linux binaries). Avoid the dead wrtc lineage.
- Mobile: **react-native-webrtc** (MIT, Jitsi-maintained, ~219k weekly downloads, data channels
  need no camera/mic permissions) via the maintained `@config-plugins/react-native-webrtc`.
- Signaling rides the already-established Noise channel through the relay, closing RFC 8827's
  fingerprint-substitution MITM: DTLS certificate fingerprints are pinned at pairing time.
- STUN: Cloudflare (`stun.cloudflare.com` is free and unlimited). TURN mostly unnecessary
  because the relay IS the fallback; optionally Cloudflare TURN (1,000 GB free) later.
- Expected effect: heavy streaming goes peer-to-peer for the ~80% of pairs that punch through;
  relay bandwidth drops to near zero; the tail always works.

### Opt-in: "bring your own network" via Tailscale

Detect a tailnet (`tailscale status --json`), connect plain WSS over the tailnet IP. Near-zero
code, best-in-class security for the many developer users who already run Tailscale. Never the
default (two app installs + SSO is disqualifying friction). App-layer pairing auth still
applies (a tailnet may contain other people's devices).

### Tracked but not chosen

- **iroh** (1.0 June 2026, official Node bindings, Ed25519 dial-by-key, QUIC): architecturally
  the cleanest, but no React Native bindings (we would own Turbo Module wrappers over the
  Swift/Kotlin bindings) and no free production relay tier. Re-evaluate if official RN bindings
  ship.
- **Hyperswarm/bare-kit**: the only stack with a proven RN P2P story (Keet on the App Store),
  but pre-1.0 RN tooling, a one-company (Tether-funded) ecosystem, no public relay fleet, no
  push. Future experimental transport at most.
- **Eliminated:** js-libp2p (no viable RN path, incomplete DCUtR hole punching, two spare-time
  maintainers after the Shipyard exit), raw WireGuard embedding (no NAT traversal without
  rebuilding Tailscale; iOS VPN entitlement restrictions), ngrok/Cloudflare Tunnel (public
  inbound endpoint, per-user accounts, provider-visible plaintext - wrong shape).

## 5. Security architecture

### Pairing ceremony (one-time per device)

Direction: the **desktop displays the QR, the phone scans it**. The desktop is the trust root.

QR contents (a pairing bootstrap, never a long-lived secret - Happy's central mistake):

1. The desktop's static X25519 **public** key (or fingerprint).
2. A short-lived (~10 min), single-use pairing token authorizing exactly one attempt at the
   relay.
3. Relay address / rendezvous ID.
4. Protocol version.

Two-layer authentication of the pairing:

- **Token-bound Noise PSK** (NOT a PAKE): the QR carries a high-entropy (>=128-bit)
  machine-generated token, which is mixed as a Noise PSK in a PSK-mode handshake. This gives the
  same "one online guess, no offline grind" property a PAKE would (a PAKE's offline-grind
  resistance only matters for a LOW-entropy human-typed code, and ours is high-entropy), while
  reusing the single audited Noise module and avoiding a hand-rolled/unaudited SPAKE2. There is no
  maintained audited JS SPAKE2 library (the one npm package is ~6yr stale, draft-08, Node-only,
  which would also break React Native parity). SPAKE2 was the original recommendation from the
  short-code survey; it is unnecessary given a scanned high-entropy token, and the PSK approach
  keeps ONE crypto primitive (Noise) across pairing and ongoing sessions.
- **SAS confirmation**: after key exchange, both screens show a 6-digit or emoji code derived
  from the transcript hash (Matrix-style, commitment-before-reveal). The user confirms they
  match. This defeats a photographed or relayed QR, because the attacker cannot also make both
  SAS values agree.

On success each side stores the other's static public key; the desktop signs the phone's key
into a **device roster** (Tailnet Lock / Matrix cross-signing pattern) with a per-device
capability set. The roster, not the relay, is the source of truth for who is paired.

### Ongoing transport crypto

- **Noise KK** handshake per session (`Noise_KK_25519_ChaChaPoly_BLAKE2s`): both statics are
  pre-messages from pairing, so no trust-on-first-use and neither identity ever travels on the
  wire. Mutual authentication by construction.
- **Version negotiation bound into the Noise prologue** (differing prologues fail the
  handshake), killing downgrade attacks.
- **No state-changing command in the first payload** (KK message 1 is replayable pre-ephemeral).
- **Re-handshake every ~2 minutes** (WireGuard's REKEY_AFTER_TIME = 120s) for bounded
  post-compromise security; libsodium `crypto_secretstream_xchacha20poly1305` per direction for
  framing gives truncation/reorder/replay detection out of the box. **No Double Ratchet**: it
  solves offline-queued asynchronous messaging, which this interactive link does not have.
- Library plan: Node built-in WebCrypto now has stable X25519 + Ed25519; on RN,
  **react-native-quick-crypto** exposes the same algorithms, so the handshake implementation is
  ONE shared TypeScript module tested against official Noise test vectors. libsodium-wrappers
  (WASM) on desktop / react-native-libsodium on mobile for secretstream (verify function
  coverage first; only a subset is implemented).

### Authorization: capability allowlist, enforced desktop-side

The encrypted channel proves WHICH device; a separate layer decides WHAT it may do. Modeled on
Tailscale grants (deny-by-default, application-defined capabilities):

- v1 verbs: `read-stream`, `read-board`, `read-diff`, `send-user-message`, `move-task`,
  `answer-permission-prompt`.
- **There is no shell, file-read, or arbitrary-command verb in the protocol.** Absent, not
  filtered (SSH forced-command lesson; Chrome Remote Desktop and VS Code tunnels are the
  counter-examples: identity-gated but capability-unscoped).
- `answer-permission-prompt` is the most sensitive verb (it can authorize the agent to run a
  command); the phone must render exactly what is being approved, and the desktop enforces
  that the response binds to a specific outstanding prompt id.
- **Revocation = drop the device from the signed roster AND rotate channel keys.** Removal
  without rekey is not revocation. Per-device key expiry (Tailscale-style) so a lost phone
  ages out.
- Replay protection: per-direction 64-bit counter nonces, reject anything at or below the last
  seen value.

### Key storage

- **iOS:** Keychain via expo-secure-store / react-native-keychain. Note the Secure Enclave only
  supports P-256, so X25519 keys cannot be enclave-resident; either accept Keychain protection
  or wrap under an enclave P-256 key later.
- **Android:** Keystore-backed (`SECURE_HARDWARE` / StrongBox where available).
- **Electron:** `safeStorage` (already wrapped in `src/main/boards/shared/auth.ts`); detect the
  Linux `basic_text` backend and refuse to persist the identity key unprotected.
- **No attestation requirement** (Play Integrity / App Attest breaks sideloaded and F-Droid
  builds of an open-source app and buys little against this threat model).

### Top mistakes to avoid (from CVE and prior-art research)

1. Long-lived secret in the QR (Happy: `handy://<32-byte-master-secret>`).
2. One key reused for encryption and identity (Happy).
3. Trusting an identity asserted in a packet field instead of the handshake key (KDE Connect
   CVE-2020-26164, CVE-2025-66270 pairing hijack).
4. Large unauthenticated pre-pairing attack surface (KDE Connect cleartext identity packets,
   unbounded sizes). Size-bound and minimize everything pre-auth.
5. Unauthenticated discovery/UDP establishing any trust (KDE Connect CVE-2025-32900).
6. Static-key channel with no forward secrecy (Happy legacy path).
7. Any "run command" verb in the protocol, even filtered.
8. Trusting the relay for the device roster (Signal Sesame's weakness; DIMVA 2021 rogue-device
   linking). Anchor the roster in the desktop-held signing key.
9. Revoking without rekeying; auto-propagating trust (Syncthing Introducer hazard).
10. No downgrade protection; a LOW-entropy human-typed code without a PAKE (we sidestep this by
    using a high-entropy scanned token as a Noise PSK, so no PAKE is needed); and overclaiming in
    security docs
    (state plainly what the relay sees).

## 6. Notifications

**iOS makes "hold the P2P link and locally notify" impossible.** Apps are suspended ~30s after
backgrounding; background URLSession does not support WebSockets; every workaround
(VoIP/PushKit without CallKit, silent audio, VPN extensions) is OS-terminated, entitlement-
gated, or App-Store-rejected; Apple DTS redirects this exact product shape to APNs alert
pushes. Android CAN hold a socket with a `connectedDevice`-type foreground service (no runtime
cap): that becomes an opt-in Android "local mode" later (F-Droid-friendly, zero Google).

**Recommended pipeline (zero hosted server, E2E content):**

1. Desktop POSTs directly to Expo's push API (`https://exp.host/--/api/v2/push/send`,
   documented auth-free, free service, 600 notifications/sec limit). No maintainer server in
   the path. The only credentials (FCM service-account JSON, APNs .p8) live in the
   maintainer's EAS account, uploaded at build time - never in the repo or binary. This
   sidesteps the open-source credential problem entirely (embedding FCM/APNs keys in an OSS
   desktop app is a known-exploited dead end).
2. The phone's `ExponentPushToken` is exchanged over the paired E2E channel and treated as a
   per-device bearer secret (leak blast radius = spam to one device; revocable by re-register).
3. Payload: desktop encrypts `{taskTitle, snippet, state}` with a per-pairing key.
   iOS: generic placeholder title/body ("Agent needs attention"), `mutableContent: true`,
   ciphertext in `data`; a native Swift **Notification Service Extension** (added via Expo
   config plugin + EAS Build, no eject; key shared via keychain access group) decrypts and
   rewrites the notification on-device. Fires even after force-quit. Every failure mode
   degrades to the generic placeholder, never ciphertext. This is the Signal/Threema pattern.
   Android: high-priority data-only FCM message; background handler decrypts and posts a rich
   local notification via Notifee. Every push yields a visible notification, satisfying FCM's
   priority heuristics.
4. Presence suppression: when the app is foregrounded with the channel up, notify over the
   socket and skip the push.
5. Vendor-swap insurance: isolate the wake channel behind a small interface; the drop-in
   replacement is a stateless ~100-line Cloudflare Worker holding the same two credentials
   (the Bitwarden/Home Assistant pattern).
6. Expected latency: high-priority APNs/FCM pushes land in roughly 1-4 seconds.

Maintainer accounts required: Apple Developer Program ($99/yr), free Firebase project, free
Expo account. Do NOT build on silent/content-available pushes (iOS budget: "two or three per
hour", dead after force-quit) or on expo-notifications' killed-state data path on iOS.

## 7. Mobile stack decision

**React Native + Expo (SDK 55+, New Architecture, development builds from day one via
expo-dev-client; Expo Go is irrelevant because WebRTC and push both require custom native
code).** Runner-up was Capacitor (best Playwright reuse, real xterm.js, but WKWebView WebRTC
quirks, weaker native feel, and no EAS-class cloud build story). Flutter eliminated by the
TypeScript-sharing requirement; bare RN by Expo strictly dominating it here; NativeScript by
ecosystem thinness.

Decisive factors:

- **Proof by twins:** Happy ships Expo ~55 + Zustand + FlashList + libsodium + vitest; Omnara
  corroborates with Expo 54. Validated architecture for exactly this product category.
- **Windows-local testing:** vitest for shared TS logic (unchanged habits), Jest + RNTL v13/14
  for components, **Maestro runs natively on Windows** against the Android emulator for E2E,
  Playwright stays in play via the react-native-web target, and **EAS Workflows runs Maestro
  on cloud iOS simulators** - the only vendor-solved "iOS E2E with no Mac".
- **iOS without a Mac:** EAS Build compiles and signs in the cloud from Windows; TestFlight
  submission via `npx testflight`. Local day-to-day dev on Android emulator.
- **Monorepo/type sharing:** Metro auto-configures for npm workspaces since SDK 52; shared
  protocol package imports directly, keeping strict TS and no-any conventions.
- Key libraries: FlashList v2 (chat-style streaming lists, built for this), react-native-marked
  or Stream's AI chat components for markdown, react-native-quick-crypto (Nitro Modules;
  Ed25519 + X25519 matching Node WebCrypto), expo-secure-store, expo-camera (QR),
  react-native-webrtc, Notifee. Terminal view (if/when built): xterm.js in a WebView
  (`@fressh/react-native-xtermjs-webview` shape) or ANSI-to-styled-Text parsing; there is no
  mature native RN terminal emulator.
- OTA: EAS Update free tier (1,000 MAU) after CodePush's 2025 retirement; self-hostable if
  outgrown.

## 8. Desktop bridge: existing seams (from the codebase survey)

Clean seams already in the main process, directly consumable by a `src/main/mobile-bridge/`
module with no renderer dependency:

- **`src/main/pty/session-manager.ts`** - the session event bus. `write(sessionId, data)` is
  the message-injection path; `getScrollback()` is the focus-independent read path; events:
  `data`, `activity`, `event`, `session-changed`, `exit`, `usage`.
- **`src/main/agent/transcript-service.ts`** - `resolveTaskTranscript` / `resolveSessionTranscript`,
  revision-memoized, adapter-delegated parsing. Directly powers the phone conversation view
  (same transcript-faithful model as the desktop conversation viewer).
- **`src/main/git/diff-service.ts`** + `src/main/ipc/handlers/git-diff.ts` + `DiffWatcher` -
  worktree diffs and change push (`GIT_DIFF_CHANGED`).
- **Repositories** (`src/main/db/repositories/`) for board state; `handleTaskMove` in
  `src/main/ipc/handlers/task-move.ts` as the reusable move entry point (respects the
  transition engine and task lifecycle locks).
- **`src/shared/activity-state.ts`** - `requiresUserInteraction()` is the isolated
  "needs attention" primitive.
- **`src/main/agent/mcp-http-server.ts`** - the architectural model: localhost-bound, random
  per-launch token, timingSafeEqual auth, per-project routing, stateless per-request handlers.
- **`src/main/boards/shared/auth.ts`** - existing safeStorage wrapper (with Linux basic_text
  detection) for storing the bridge identity key and roster.

Refactors required:

1. ~~Notification policy lived in the renderer~~ - **done.** The desktop idle/permission and
   crash notification decision (cooldown, focus gate, active-project gate, title assembly) moved
   to main (`src/main/notifications/desktop-notifier.ts`), which listens to `SessionManager`'s
   own `activity`/`exit` events directly instead of a renderer round-trip. This was purely
   desktop-local robustness/de-duplication by the time it landed - the mobile push rationale
   below (pushes firing with the desktop window closed) was already satisfied by the
   `PushNotifier` built in Phase 2, which listens to `SessionManager` the same way. Full
   notification-CATEGORY parity with the mobile push taxonomy is separate, ongoing work (see
   Bridge Phase 3 below).
2. **Session output is focus-gated**: `SessionManager` emits `data` only for
   `focusedSessionIds`. The bridge needs an unfiltered tap or membership in the focused set;
   `getScrollback` works today as the safe pull path.
3. **Board-change fan-out is ad hoc** (per-mutation `*_BY_AGENT` channels aimed at the
   renderer). The bridge either subscribes to each or a consolidated main-side board event is
   introduced.
4. **Streaming to the phone should be transcript-events-first, not raw ANSI**: the raw TUI is
   sized to desktop columns and reads badly on a phone; the transcript pipeline is the
   phone-native representation. A read-only terminal mirror can come later.

## 9. Phasing (final)

Product decisions locked in the interview: full desktop-parity remote control (interactive
terminal included, `answer-permission-prompt` in v1, full MCP tool surface, voice-to-text with
configurable auto-send); full desktop notification-category parity, user-configurable; iPhone +
Android (Android-first dogfooding on emulator); TestFlight + Play internal distribution; N:N
device roster crypto but 1:1 management UX in v1; `@kangentic/protocol` npm package with source
of truth in the kangentic repo. Mobile UX: activity-triage home (Needs you / Working / Idle) plus
a swipeable Board tab; opening a task is full-screen with a bottom tab bar (Conversation-terminal
/ Terminal / Changes) and a composer pinned at the bottom. The primary session view renders the
TRANSCRIPT styled as a terminal (reflows perfectly to phone width, streams the in-progress turn
token-by-token, renders AskUserQuestion/permission as tappable cards) so the desktop terminal is
never resized; the raw interactive terminal grid is a secondary view (faithful mirror + pinch-zoom
+ quick-key bar) for nested full-screen programs. Transport: Option C (relay-first on a
bandwidth-included VPS, DigitalOcean or Hetzner; see section 4), WebRTC P2P + IPv6-first as a
later speed phase.

Desktop / bridge (kangentic board):

- **Bridge Phase 1 - Protocol, pairing & secure relay transport:** `@kangentic/protocol` package
  (wire schema, shared Noise KK implementation, capability verbs, transcript/board/activity event
  types); device identity + signed roster + revocation-with-rekey; QR pairing ceremony (token-bound
  Noise PSK + SAS) with desktop UI; the desktop's outbound relay CLIENT connection with reconnect (the relay
  SERVER is its own open-core repo, see section 10); capability router;
  swappable transport interface (relay now, P2P later).
- **Bridge Phase 2 - Data feeds, interactive control & capabilities:** bridge subscriptions over
  SessionManager (unfiltered output tap + `getScrollback`), transcript service, repositories,
  DiffService, activity engine; the PTY write path for interactive input from the phone (full
  terminal parity, including `answer-permission-prompt` bound to a specific outstanding prompt
  id); consolidated main-side board event stream; the MCP tool surface exposed to paired devices
  (task CRUD/move/create, board, backlog, search, session, transcript) minus code-execution
  verbs (no devtools/browser/raw-`query_db`).
- **Bridge Phase 3 - Notifications & push sender:** Expo push sender POSTing E2E-encrypted blobs
  directly to `exp.host`; presence suppression; a main-process `PushNotifier`
  (`src/main/mobile-bridge/push/push-notifier.ts`) with cooldown/debounce - all shipped in the
  Phase 2 landing. The desktop's OWN should-fire policy (cooldown, focus/active-project gating,
  title assembly) also moved from the renderer into main
  (`src/main/notifications/desktop-notifier.ts`) as a residual de-duplication pass. Still open:
  full notification-CATEGORY parity between the two (idle, permission-needed, agent-crash,
  plan-complete, spawn-stalled) and paired-devices settings UI (list, per-device capabilities,
  revoke).
- **Bridge Phase 4 (later) - Direct P2P + IPv6 speed upgrade:** WebRTC data channels
  (node-datachannel desktop / react-native-webrtc mobile) with signaling over the existing secure
  channel and DTLS fingerprints pinned at pairing; IPv6-first candidate ordering; opportunistic
  UPnP/NAT-PMP; Cloudflare STUN + optional Cloudflare TURN (or coturn) fallback; Tailscale
  detection for BYON; optional Android foreground-service local mode.
- **Relay (open-core, SEPARATE `kangentic-relay` repo)** - a tiny stateless blind byte-forwarder
  (self-hostable, Docker; Hetzner-hosted for Kangentic's own instance). The account/billing control
  plane is a separate PRIVATE repo, added only when monetizing. See section 10.

Mobile (kangentic-mobile board):

- **App Phase 1 - Foundation, pairing client & secure channel:** Expo SDK 55+ scaffold (dev
  builds, EAS, config plugins), testing harness (vitest for shared logic + Jest/RNTL + Maestro
  on Windows + react-native-web Playwright + GitHub Actions/EAS Workflows CI), navigation shell
  (triage home + Board tab), design system, consumption of `@kangentic/protocol`; pairing client
  (expo-camera QR scan, SAS confirm screen, key storage in Keychain/Keystore); secure channel
  client (shared Noise KK over the relay WebSocket, reconnect/resume).
- **App Phase 2 - Core experience:** activity-triage home + swipeable board with task moves;
  full-screen task view; the transcript-terminal conversation renderer (FlashList block cells,
  markdown, tool cards, inline diffs, token-by-token live streaming, tappable
  AskUserQuestion/permission cards); the raw interactive terminal (xterm-in-WebView or
  ANSI-to-Text, pinch-zoom, quick-key bar) with the PTY write path; message composer;
  changes/diff viewer; MCP-backed actions incl. task creation; voice-to-text (OS speech engines,
  default auto-send, configurable to manual/off).
- **App Phase 3 - Notifications, device management & release:** iOS Notification Service Extension
  (config plugin, no eject) + Android Notifee background handler, both decrypting E2E push blobs
  on-device; full notification-category parity with per-category toggles; device management /
  revocation UX; store-release prep (TestFlight + Play internal, EAS Update).

## 10. Monetization & licensing (open-core)

The desktop app is open source. The mobile app and relay follow an OPEN-CORE model: the software
is open source and self-hostable, while a Kangentic-operated HOSTED service (relay + push, behind
signup and a free/Pro pricing tier) is the paid product. This is the Tailscale / Bitwarden /
Syncthing / Supabase shape and does not conflict with the open-source promise.

Rollout: v1 ships FREE and ACCOUNTLESS while the user base is small and under test. The paid
migration is a purely ADDITIVE flip enabled by the maintainer's existing dual license + SLA - the
account/entitlement gate is layered onto the hosted relay later, NOT a rearchitecture - precisely
because the core stays accountless and cleanly separated. Build v1 as if free forever; add the
gate when ready.

Two things are monetized separately:
- The relay SOFTWARE (`kangentic-relay`) stays open source and self-hostable forever.
- The relay HOSTED SERVICE (Kangentic-operated: accounts, quotas, managed reliability, hosted
  push) is the paid product.

LOAD-BEARING SEPARATION (do not violate): the E2E pairing + transport (device identity, Noise KK,
capability roster) stays ACCOUNTLESS and open source, and works identically self-hosted or on the
paid relay. A Kangentic account/entitlement check sits ONLY on the hosted relay and decides
whether a device may use KANGENTIC'S relay and at what plan limits; it never touches the crypto or
the pairing model. Free/self-host stays zero-signup; the account is required only to use
Kangentic's hosted relay/push beyond a free cap. The relay stays blind either way ("even our paid
relay cannot read your data" - the thing the closest competitor claims but half-breaks).

Repo structure:
- `@kangentic/protocol` (pairing + E2E crypto): OPEN, in the kangentic repo. An auditable crypto
  core is a feature for a security product.
- `kangentic-relay`: OPEN, its own repo. The blind byte-forwarder, self-hostable via Docker.
- Commercial control plane (accounts, billing, quotas, hosted signup): a SEPARATE PRIVATE repo,
  added only when monetizing. Keeps business logic out of the open repos.
- `kangentic-mobile`: its own repo (the app-store build can be the paid product).

Licensing (decide before the first outside contributor - expensive to retrofit):
- License the mobile app + relay defensively (AGPL, or a source-available license like BSL/FSL) so
  a cloud competitor cannot run them as a competing service. The desktop app's license is
  unaffected.
- Require a CLA/DCO from the first external contributor to preserve relicensing / dual-licensing.

Natural Pro/hosted levers (self-hosters cannot easily replicate):
- Hosted PUSH: the Expo/APNs/FCM credentials are inherently the maintainer's; a self-hoster would
  need their own Apple/Google accounts and app build.
- Managed relay reliability, multi-region, higher/unlimited relay limits, priority TURN,
  multi-device beyond a free cap.

The Phase-4 WebRTC/IPv6 direct path REDUCES traffic through the hosted relay, lowering Kangentic's
COGS; the hosted relay's value is reliability + convenience + no self-host ops, not "we carry all
your bytes."

## 11. Sources (load-bearing subset)

- Anthropic Remote Control: https://code.claude.com/docs/en/remote-control
- Happy: https://github.com/slopus/happy and https://happy.engineering/docs/guides/self-hosting/
- iroh relay policy: https://docs.iroh.computer/iroh-services/relays/public.md
- node-datachannel: https://github.com/murat-dogan/node-datachannel
- react-native-webrtc: https://github.com/react-native-webrtc/react-native-webrtc
- RFC 8827 (WebRTC security): https://www.rfc-editor.org/rfc/rfc8827.html
- TURN need (~17-22%): https://webrtchacks.com/usage-stats/
- CGNAT prevalence: Richter et al., ACM IMC 2016, https://dl.acm.org/doi/10.1145/2987443.2987474
- Noise spec (KK, prologue, rekey): https://noiseprotocol.org/noise.html
- SPAKE2: RFC 9382; CPace: draft-irtf-cfrg-cpace; magic-wormhole one-guess property (surveyed for
  the short-code case; our design uses a high-entropy token as a Noise PSK instead, see section 5)
- Matrix SAS verification; Bluetooth numeric comparison commitment
- KDE Connect CVEs: CVE-2020-26164, CVE-2025-32900, CVE-2025-66270
- Tailscale: https://tailscale.com/kb/1226/tailnet-lock, https://tailscale.com/blog/nat-traversal-improvements-pt-1
- iOS background limits (Apple DTS): https://developer.apple.com/forums/thread/685525,
  https://developer.apple.com/forums/thread/770029
- NSE decrypt-before-display: https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
- Expo push: https://docs.expo.dev/push-notifications/sending-notifications/,
  https://docs.expo.dev/push-notifications/faq/
- EAS app extensions: https://docs.expo.dev/build-reference/app-extensions/
- Expo SDK 55 / New Architecture: https://expo.dev/changelog/sdk-55
- Maestro on Windows: https://docs.maestro.dev/
- EAS Workflows E2E (cloud iOS sims): https://docs.expo.dev/eas/workflows/examples/e2e-tests/
- Expo monorepos: https://docs.expo.dev/guides/monorepos
- FlashList v2: https://shopify.engineering/flashlist-v2
- Home Assistant push relay: https://companion.home-assistant.io/docs/notifications/notification-details/
- Bitwarden push relay: https://contributing.bitwarden.com/architecture/deep-dives/push-notifications/mobile/
- Node WebCrypto X25519/Ed25519: https://nodejs.org/api/webcrypto.html
- react-native-quick-crypto: https://github.com/margelo/react-native-quick-crypto
- Cloudflare Durable Objects pricing (relay cost): https://developers.cloudflare.com/durable-objects/platform/pricing/
