import { ErrorBoundary } from '../components/ErrorBoundary';
import { useBoardStore } from '../stores/board-store';
import { getSurface } from './surface-registry';
import { usePopOutBootstrap } from './usePopOutBootstrap';
import { PopOutWindowFrame } from './PopOutWindowFrame';
import { POP_OUT_SURFACES, formatTaskAnchor, isGlobalPopOutKind, isProjectPopOutKind, resolveSurfaceTitle } from '../../shared/pop-out';
import type { PopOutChangesFileParams, PopOutDescriptor, PopOutTaskParams } from '../../shared/pop-out';
import './surfaces';
import { ToastContainer } from '../components/layout/ToastContainer';

/** A pop-out has no status bar, so its toasts sit this far above the bottom edge. */
const POP_OUT_TOAST_BOTTOM_OFFSET_PX = 12;

/** Mounted by index.tsx in place of <App/> when this renderer is a pop-out window
 *  (a URL hash / additionalArguments descriptor is present). Runs the surface's
 *  minimal bootstrap and renders its root inside the shared frameless chrome. */
export function PopOutSurfaceRoot({ descriptor }: { descriptor: PopOutDescriptor }) {
  const surface = getSurface(descriptor.kind);
  usePopOutBootstrap(descriptor);
  // Task-scoped surfaces (changes / browser) title their window with the task's
  // title so the detached window is associable to its task; a global surface
  // (stats, Agent Monitor) has no task, so the frame falls back to its own name.
  // board-store is hydrated by those surfaces' bootstrap (`loadAmbientBoard`), so
  // the title lands once it loads. It holds the main window's open project only,
  // so a backgrounded task's window keeps the surface name.
  //
  // Keyed off the shared GLOBAL_KINDS set rather than an inline `=== 'stats'`,
  // for the reason that set exists: a new global kind would otherwise fall
  // through to the task-params branch and read `.taskId` off an empty object.
  const taskId = isGlobalPopOutKind(descriptor.kind) || isProjectPopOutKind(descriptor.kind)
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
  // A project's surface titles by the project name its params carry, in the
  // header and the taskbar alike: the same value main gave the BrowserWindow.
  const projectTitle = isProjectPopOutKind(descriptor.kind)
    ? resolveSurfaceTitle(POP_OUT_SURFACES[descriptor.kind], descriptor.params)
    : null;
  return (
    <ErrorBoundary>
      <PopOutWindowFrame
        kind={descriptor.kind}
        title={fileParams ? `${fileParams.filePath} - ${formatTaskAnchor(fileParams.taskDisplayId, fileParams.taskTitle)}` : projectTitle ?? taskTitle ?? undefined}
        documentTitle={fileParams ? resolveSurfaceTitle(POP_OUT_SURFACES[descriptor.kind], descriptor.params) : undefined}
      >
        <surface.Root params={descriptor.params} />
      </PopOutWindowFrame>
      {/* A pop-out raises toasts too (a task window opened from the detached
          monitor, the detached Knowledge Graph), and before this nothing here
          rendered them. No status bar, so the stack sits nearer the edge. */}
      <ToastContainer bottomOffsetPx={POP_OUT_TOAST_BOTTOM_OFFSET_PX} />
    </ErrorBoundary>
  );
}
