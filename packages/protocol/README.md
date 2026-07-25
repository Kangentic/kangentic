# @kangentic/protocol

Shared wire protocol for the Kangentic mobile bridge: frame encoding, the Noise-based pairing
and session handshakes, secretstream-style AEAD framing, the signed device roster, capability
verbs, and the transcript/board/activity event contract types the mobile app consumes.

This package is the single source of truth for the desktop (`src/main/mobile-bridge/`) and
`kangentic-mobile` implementations of the protocol. It is pure TypeScript on top of
[`@noble/curves`](https://github.com/paulmillr/noble-curves),
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes), and
[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) so the exact same handshake code
runs on Node (Electron main) and React Native (via the same pure-JS primitives), with no native
module coupling.

See `docs/mobile-bridge.md` in the main repository for the pairing ceremony, roster/revocation
model, and the honest relay-metadata statement.

## Security

- `Noise_KK_25519_ChaChaPoly_BLAKE2s` for ongoing sessions (mutual authentication by construction,
  no trust-on-first-use).
- A token-bound Noise PSK handshake for the one-time pairing ceremony, confirmed by a Matrix-style
  short authentication string (SAS) compared on both screens - digits only, no emoji.
- A sealed pairing-confirm frame (`pairing/confirm.ts`), sent once the human taps Confirm on the
  phone: it is a liveness/intent signal, not the security boundary. It opens only if both peers
  completed the same handshake transcript, which is exactly the property the SAS comparison
  already vouches for - the human's comparison remains the actual defense.
- No shell, file, or arbitrary-command verb exists in the protocol.

This package has not undergone a third-party security audit. Report suspected vulnerabilities
per the repository's security policy rather than filing a public issue.
