/**
 * Dependency-free base64url (RFC 4648 section 5) encode/decode. Node has
 * Buffer.from(...).toString('base64url'), but this package also runs on
 * React Native, which does not provide Buffer without an app-level
 * polyfill this package should not assume is present.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODE_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) DECODE_MAP[ALPHABET[i]] = i;

export function base64UrlEncode(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += ALPHABET[(chunk >> 18) & 0x3f] + ALPHABET[(chunk >> 12) & 0x3f] + ALPHABET[(chunk >> 6) & 0x3f] + ALPHABET[chunk & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    result += ALPHABET[(chunk >> 18) & 0x3f] + ALPHABET[(chunk >> 12) & 0x3f];
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += ALPHABET[(chunk >> 18) & 0x3f] + ALPHABET[(chunk >> 12) & 0x3f] + ALPHABET[(chunk >> 6) & 0x3f];
  }
  return result;
}

export function base64UrlDecode(encoded: string): Uint8Array {
  // Every character is validated against DECODE_MAP below - unlike a
  // "strip anything unrecognized first" approach, an invalid character
  // (or accidental padding, whitespace, etc.) is rejected rather than
  // silently dropped. Decoding untrusted wire input should fail loudly on
  // garbage, not quietly reinterpret it.
  const byteLength = Math.floor((encoded.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const char of encoded) {
    const value = DECODE_MAP[char];
    if (value === undefined) throw new Error(`Invalid base64url character: "${char}"`);
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[outputIndex] = (bitBuffer >> bitCount) & 0xff;
      outputIndex += 1;
    }
  }
  return bytes;
}
