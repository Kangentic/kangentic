import { ErrorBoundary } from '../components/ErrorBoundary';
import { useBoardStore } from '../stores/board-store';
import { getSurface } from './surface-registry';
import { usePopOutBootstrap } from './usePopOutBootstrap';
import { PopOutWindowFrame } from './PopOutWindowFrame';
import { POP_OUT_SURFACES, formatTaskAnchor, isGlobalPopOutKind, resolveSurfaceTitle } from '../../shared/pop-out';
import type { PopOutChangesFileParams, PopOutDescriptor, PopOutTaskParams } from '../../shared/pop-out';
import './surfaces';

/** Mounted by index.tsx in place of <App/> when this renderer is a pop-out window
 *  (a URL hash / additionalArguments descriptor is present). Runs the surface's
 *  minimal bootstrap and renders its root inside the shared frameless chrome. */
export function PopOutSurfaceRoot({ descriptor }: { descriptor: PopOutDescriptor }) {
  const surface = getSurface(descriptor.kind);
  usePopOutBootstrap(descriptor);
  // Task-scoped surfaces (changes / browser) title their window with the task's
  // title so the detached window is associable to its task; a global surface
  // (stats, Agent Monitor) has no task, so the frame falls back to its own name.
  // board-store is hydrated by those surfaces' bootstrap, so the title lands once
  // it loads.
  //
  // Keyed off the shared GLOBAL_KINDS set rather than an inline `=== 'stats'`,
  // for the reason that set exists: a new global kind would otherwise fall
  // through to the task-params branch and read `.taskId` off an empty object.
  const taskId = isGlobalPopOutKind(descriptor.kind)
    ? null
    : (descriptor.params as PopOutTaskParams).taskId;
  const taskTitle = useBoardStore((state) =>
    taskId ? state.tasks.find((task) => task.id === taskId)?.title ?? null : null,
  );
  // The per-file surface titles by its FILE plus the task anchor: the frame
  // header shows "full/path - #N task title" (params carry the task label as a
  // boot seed), the taskbar the basename form of the same (resolveSurfaceTitle,
  // the same value main gave the BrowserWindow). Needs no board hydration, so
  // it is correct from first paint.
  const fileParams = descriptor.kind === 'changes-file' ? (descriptor.params as PopOutChangesFileParams) : null;
  return (
    <ErrorBoundary>
      <PopOutWindowFrame
        kind={descriptor.kind}
        title={fileParams ? `${fileParams.filePath} - ${formatTaskAnchor(fileParams.taskDisplayId, fileParams.taskTitle)}` : taskTitle ?? undefined}
        documentTitle={fileParams ? resolveSurfaceTitle(POP_OUT_SURFACES[descriptor.kind], descriptor.params) : undefined}
      >
        <surface.Root params={descriptor.params} />
      </PopOutWindowFrame>
    </ErrorBoundary>
  );
}
