import { Plural } from '@lingui/react/macro';

/** Why Save is off when a task description is too long, under the field that holds it. */
export function DescriptionLimitNote({ overage }: { overage: number }) {
  if (overage <= 0) return null;
  return (
    <p className="text-xs text-danger" data-testid="task-description-over-limit">
      <Plural value={overage} one="# character over the limit" other="# characters over the limit" />
    </p>
  );
}
