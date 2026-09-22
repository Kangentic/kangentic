import type { GpuGraphicsStatus } from '../../shared/types';

/**
 * Whether to tell the user this launch came up without graphics acceleration,
 * and what to say.
 *
 * A pure resolver, matching `idle-toast.ts`: the decision is the part worth a
 * unit test, and App.tsx keeps the `addToast` call beside its siblings.
 *
 * The message carries no count, no date and no adapter, deliberately. Those
 * were in earlier drafts and all three are evidence for US, not guidance for
 * the reader - none of them changes what they do next, and a tally read back
 * at someone reads as surveillance. They go to Sentry instead, which is where
 * they are acted on. Saying "repeated" rather than a number also removes the
 * singular-versus-plural problem this function would otherwise own.
 *
 * It also claims no cause. "usually a display driver problem" was true of the
 * population and unestablished for any given reader, and we never determined
 * what killed the GPU process (see src/main/diagnostics/gpu-health.ts).
 */
export interface GpuNoticeResult {
  message: string;
}

export const GPU_NOTICE_MESSAGE =
  'Graphics acceleration is off. Repeated failures shut down your last run.';

export function resolveGpuNotice(status: GpuGraphicsStatus | null | undefined): GpuNoticeResult | null {
  if (!status?.noticePending) return null;
  // Main only arms the notice on a launch it put into software rendering, but
  // a status claiming one without the other is incoherent enough that saying
  // nothing beats saying something wrong.
  if (!status.softwareRendering) return null;
  return { message: GPU_NOTICE_MESSAGE };
}
