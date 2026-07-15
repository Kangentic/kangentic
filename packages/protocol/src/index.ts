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
export { encodeMessage, decodeMessage, MAX_FRAME_LENGTH, MAX_DECODED_LENGTH, COMPRESSION_THRESHOLD } from './wire/framing';
export { isJsonValue, isRecord } from './wire/json-value';
export { SessionFrameKind, wrapSessionFrame, unwrapSessionFrame } from './wire/session-frame';

export {
  parseCapabilityRequestPayload,
  parseReadStreamResponsePayload,
  parseReadBoardResponsePayload,
  parseReadDiffResponsePayload,
  parseTranscriptWindowResponsePayload,
  type CapabilityRequestPayloadMap,
  type CapabilityResponsePayloadMap,
  type ReadStreamRequestPayload,
  type ReadStreamResponsePayload,
  type TranscriptWindowResponsePayload,
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

export {
  BOARD_TOOL_READ_NAMES,
  BOARD_TOOL_WRITE_NAMES,
  isBoardToolReadName,
  isBoardToolWriteName,
  type BoardToolReadName,
  type BoardToolWriteName,
  type BoardToolName,
} from './capabilities/board-tools';

export {
  isBridgeEvent,
  parseActivityEventPayload,
  type BridgeEvent,
  type TranscriptEvent,
  type ActivityEvent,
  type ActivityEventPayload,
  type TerminalEvent,
  type BoardEvent,
  type BoardEventPayload,
  type DiffEvent,
} from './events/event';

export {
  parseTranscriptEntriesWire,
  parseTranscriptEventPayload,
  type TranscriptEventPayload,
  type TranscriptUpsertWire,
  isActivityStateWire,
  isActivityReasonWire,
  parseSessionUsageWire,
  parseSessionEventWire,
  parseBoardColumnWire,
  parseBoardTaskWire,
  parseBacklogItemWire,
  parseDiffFileListWire,
  parseDiffFileContentWire,
  type TranscriptBlockWire,
  type TranscriptEntryWire,
  type TranscriptTurnUsageWire,
  type TranscriptSystemSubtypeWire,
  type ActivityStateWire,
  type ActivityReasonWire,
  type SessionUsageWire,
  type SessionEventWire,
  type BoardColumnWire,
  type BoardTaskWire,
  type BacklogItemWire,
  type DiffFileStatusWire,
  type DiffFileWire,
  type DiffFileListWire,
  type DiffFileContentWire,
} from './events/payloads';

export type { Transport, TransportState, Unsubscribe } from './transport/transport';
