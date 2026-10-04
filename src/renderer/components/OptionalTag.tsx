import { Pill } from './Pill';

/**
 * Small muted "Optional" tag appended to a field label. Required fields are
 * left unmarked: only the exception (optional) needs calling out. Shared by the
 * Agent tab's remote-execution fields and the Edit automation dialog.
 */
export function OptionalTag() {
  return (
    <Pill size="xs" className="bg-surface-hover text-fg-faint border border-edge/50 font-normal">
      Optional
    </Pill>
  );
}
