/**
 * Reads the block kind Claude's server encodes in a `thinking` block's
 * `signature`, the same way Claude Code does.
 *
 * Claude Code writes some of the lines it shows as `●` messages into a
 * `thinking` block rather than a `text` block: the server tags those blocks
 * `narration` (its summaries of the prose between tool calls) inside the
 * signature, and the CLI decodes that tag and renders the block as plain text.
 * It also reports them as `narration_block_indexes` in its frame metadata.
 * Every other thinking block decodes to `thinking`, and on the models that
 * emit narration those are always empty.
 *
 * Ported from the decoder in Claude Code 2.1.292: base64, then the last
 * length-delimited field 2, its field 1, and the UTF-8 string in its field 8.
 * Each field read walks the WHOLE buffer and gives up on any malformed byte, so
 * a truncated or hand-written signature reads as no kind at all rather than as
 * a partial match. Measured over 3 days of local transcripts: 3,624 narration
 * blocks with text, all on Opus 5.5 and Sonnet 5.5, and 30,109 thinking-kind
 * blocks, every one empty.
 */

const SIGNATURE_PAYLOAD_FIELD = 2;
const PAYLOAD_METADATA_FIELD = 1;
const METADATA_BLOCK_KIND_FIELD = 8;
const NARRATION_BLOCK_KIND = 'narration';

/** A protobuf varint is at most 10 bytes; anything longer is malformed. */
const MAX_VARINT_BYTES = 10;

const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_FIXED64 = 1;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_FIXED32 = 5;

const utf8Decoder = new TextDecoder('utf-8');

/** One varint at `offset`, or undefined when it runs off the end or past 10 bytes. */
function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let multiplier = 1;
  for (let byteIndex = 0; byteIndex < MAX_VARINT_BYTES; byteIndex += 1) {
    const position = offset + byteIndex;
    if (position >= bytes.length) return undefined;
    const byte = bytes[position];
    // Multiply rather than shift: a shift wraps at 32 bits.
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: position + 1 };
    multiplier *= 128;
  }
  return undefined;
}

/**
 * The bytes of the LAST length-delimited occurrence of `fieldNumber` in a
 * protobuf message, or undefined when the field is absent or any byte of the
 * message fails to parse.
 */
function readLengthDelimitedField(bytes: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return undefined;
    offset = tag.next;
    const wireType = tag.value % 8;
    const tagFieldNumber = Math.floor(tag.value / 8);
    switch (wireType) {
      case WIRE_TYPE_VARINT: {
        const skipped = readVarint(bytes, offset);
        if (!skipped) return undefined;
        offset = skipped.next;
        break;
      }
      case WIRE_TYPE_FIXED64:
        if (offset + 8 > bytes.length) return undefined;
        offset += 8;
        break;
      case WIRE_TYPE_LENGTH_DELIMITED: {
        const length = readVarint(bytes, offset);
        if (!length || length.value > bytes.length - length.next) return undefined;
        offset = length.next + length.value;
        if (tagFieldNumber === fieldNumber) found = bytes.subarray(length.next, offset);
        break;
      }
      case WIRE_TYPE_FIXED32:
        if (offset + 4 > bytes.length) return undefined;
        offset += 4;
        break;
      default:
        return undefined;
    }
  }
  return found;
}

/**
 * The block kind a thinking signature carries (`narration`, `thinking`), or
 * undefined when the signature is not base64 or not the expected message.
 */
export function decodeThinkingSignatureKind(signature: string): string | undefined {
  let binary: string;
  try {
    // `atob`, not `Buffer.from(..., 'base64')`: Buffer skips characters it
    // cannot decode, and the CLI's `atob` rejects them.
    binary = atob(signature);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const payload = readLengthDelimitedField(bytes, SIGNATURE_PAYLOAD_FIELD);
  if (!payload) return undefined;
  const metadata = readLengthDelimitedField(payload, PAYLOAD_METADATA_FIELD);
  if (!metadata) return undefined;
  const blockKind = readLengthDelimitedField(metadata, METADATA_BLOCK_KIND_FIELD);
  return blockKind ? utf8Decoder.decode(blockKind) : undefined;
}

/** The block kind of a signature, or undefined for a non-string or one that fails to decode. Never throws. */
function safeSignatureKind(signature: unknown): string | undefined {
  if (typeof signature !== 'string' || signature.length === 0) return undefined;
  try {
    return decodeThinkingSignatureKind(signature);
  } catch {
    return undefined;
  }
}

/** Whether a thinking block's signature tags it as narration. Never throws. */
export function isNarrationSignature(signature: unknown): boolean {
  return safeSignatureKind(signature) === NARRATION_BLOCK_KIND;
}

let reportedUnrecognizedTextThinking = false;

/**
 * Logs, once per process, a thinking block that carries text but is not
 * narration.
 *
 * Every text-bearing thinking block measured on current models is narration,
 * so one that is not means the signature format or the server's tagging
 * changed. The parser then falls back to `thinking`, and the board trail falls
 * behind the terminal again with nothing else to show for it. The line names
 * the decoded kind and the signature's length, never the text.
 */
export function reportUnrecognizedTextThinking(signature: unknown): void {
  if (reportedUnrecognizedTextThinking) return;
  reportedUnrecognizedTextThinking = true;
  const kind = safeSignatureKind(signature);
  const signatureLength = typeof signature === 'string' ? signature.length : 0;
  console.warn(
    `[claude-transcript] A thinking block carries text but its signature is not narration `
    + `(kind: ${kind ?? 'undecodable'}, signature length: ${signatureLength}). It is kept as thinking, `
    + 'so the board trail will not show it. On a current Claude model, this means Claude Code changed its signature format.',
  );
}

/** Test-only: let the next unrecognized block log again. */
export function resetUnrecognizedTextThinkingReportForTests(): void {
  reportedUnrecognizedTextThinking = false;
}
