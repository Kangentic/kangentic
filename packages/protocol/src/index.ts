export { PROTOCOL_VERSION, encodeProtocolVersion } from './version';

export {
  randomBytes,
  generateX25519KeyPair,
  x25519PublicKeyFrom,
  generateEd25519KeyPair,
  hexToBytes,
  bytesToHex,
  X25519_KEY_LENGTH,
  ED25519_KEY_LENGTH,
  type X25519KeyPair,
  type Ed25519KeyPair,
} from './crypto/primitives';

export { HandshakeState, type HandshakeStateOptions, type HandshakeWriteResult, type HandshakeReadResult } from './crypto/noise/handshake-state';
export { CipherState } from './crypto/noise/cipher-state';
export { KK_PATTERN, IKPSK0_PATTERN, type NoisePattern, type NoiseToken } from './crypto/noise/patterns';
export { createKKHandshake, type KKHandshakeOptions } from './crypto/noise/kk';
export {
  createPairingInitiatorHandshake,
  createPairingResponderHandshake,
  type PairingInitiatorOptions,
  type PairingResponderOptions,
} from './crypto/pairing-handshake';

export {
  SecretstreamState,
  deriveSecretstreamPair,
  FrameTag,
  type SecretstreamDirectionPair,
} from './crypto/secretstream';

export { deriveShortAuthenticationString, type ShortAuthenticationString } from './crypto/sas';
export { deriveSessionSlotId } from './crypto/slot';

export type { JsonValue, BridgeMessage, HeartbeatMessage, CapabilityRequestMessage, CapabilityResponseMessage, EventMessage } from './wire/messages';
export { encodeMessage, decodeMessage, MAX_FRAME_LENGTH } from './wire/framing';
export { isJsonValue, isRecord } from './wire/json-value';
export { SessionFrameKind, wrapSessionFrame, unwrapSessionFrame } from './wire/session-frame';

export {
  parseCapabilityRequestPayload,
  type CapabilityRequestPayloadMap,
  type CapabilityResponsePayloadMap,
  type ReadStreamRequestPayload,
  type ReadStreamResponsePayload,
  type ReadBoardRequestPayload,
  type ReadBoardProjectSummary,
  type ReadBoardProjectListResponsePayload,
  type ReadBoardSnapshotResponsePayload,
  type ReadBoardResponsePayload,
  type ReadDiffScope,
  type ReadDiffRequestPayload,
  type ReadDiffResponsePayload,
  type SendUserMessageRequestPayload,
  type SendUserMessageResponsePayload,
  type MoveTaskRequestPayload,
  type MoveTaskResponsePayload,
  type AnswerPermissionPromptRequestPayload,
  type AnswerPermissionPromptResponsePayload,
  type InteractiveTerminalRequestPayload,
  type InteractiveTerminalResponsePayload,
  type BoardToolRequestPayload,
  type BoardToolResponsePayload,
} from './wire/payloads';

export {
  PAIRING_URI_SCHEME,
  encodePairingQrPayload,
  decodePairingQrPayload,
  type PairingQrPayload,
} from './pairing/qr';

export {
  signRosterEntry,
  verifyRosterEntry,
  encodeRosterEntryForSigning,
  isRosterEntryExpired,
  findRosterDevice,
  rosterDeviceCapabilitySet,
  capabilitySetToRosterCapabilities,
  type RosterDeviceEntry,
  type DeviceRoster,
} from './roster/roster';

export {
  CAPABILITY_VERBS,
  isCapabilityVerb,
  capabilitySetFromArray,
  capabilitySetToArray,
  type CapabilityVerb,
  type CapabilitySet,
} from './capabilities/verbs';

export type {
  BridgeEvent,
  TranscriptEvent,
  ActivityEvent,
  ActivityEventPayload,
  TerminalEvent,
  BoardEvent,
  BoardEventPayload,
  DiffEvent,
} from './events/event';

export type { Transport, TransportState, Unsubscribe } from './transport/transport';
