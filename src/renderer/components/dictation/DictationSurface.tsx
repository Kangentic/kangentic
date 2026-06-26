import { LiveDictationChip } from './LiveDictationChip';

/**
 * The dictation live surface: a small status chip shown while the transcript
 * types straight into the focused terminal (the `live` experience, now the only
 * one). Renders nothing while idle, so it is safe to always mount.
 */
export function DictationSurface() {
  return <LiveDictationChip />;
}
