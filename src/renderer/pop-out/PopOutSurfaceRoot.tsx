import { ErrorBoundary } from '../components/ErrorBoundary';
import { useBoardStore } from '../stores/board-store';
import { getSurface } from './surface-registry';
import { usePopOutBootstrap } from './usePopOutBootstrap';
import { PopOutWindowFrame } from './PopOutWindowFrame';
import type { PopOutDescriptor, PopOutTaskParams } from '../../shared/pop-out';
import './surfaces';

/** Mounted by index.tsx in place of <App/> when this renderer is a pop-out window
 *  (a URL hash / additionalArguments descriptor is present). Runs the surface's
 *  minimal bootstrap and renders its root inside the shared frameless chrome. */
export function PopOutSurfaceRoot({ descriptor }: { descriptor: PopOutDescriptor }) {
  const surface = getSurface(descriptor.kind);
  usePopOutBootstrap(descriptor);
  // Task-scoped surfaces (changes / browser) title their window with the task's
  // title so the detached window is associable to its task; the global stats
  // surface has no task, so the frame falls back to its own name. board-store is
  // hydrated by those surfaces' bootstrap, so the title lands once it loads.
  const taskId = descriptor.kind === 'stats' ? null : (descriptor.params as PopOutTaskParams).taskId;
  const taskTitle = useBoardStore((state) =>
    taskId ? state.tasks.find((task) => task.id === taskId)?.title ?? null : null,
  );
  return (
    <ErrorBoundary>
      <PopOutWindowFrame kind={descriptor.kind} title={taskTitle ?? undefined}>
        <surface.Root params={descriptor.params} />
      </PopOutWindowFrame>
    </ErrorBoundary>
  );
}
