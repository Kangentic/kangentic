import { LazyMonitor } from '../../components/monitor/LazyMonitor';
import { MonitorDetailLayer } from '../../components/monitor/MonitorDetailLayer';
import { useMonitorDetailOwnership } from '../../components/monitor/useMonitorDetailOwnership';

/** Pop-out root for the 'monitor' surface. Mounted inside PopOutWindowFrame by
 *  PopOutSurfaceRoot; renders the same (lazy) MonitorBody the in-app overlay
 *  (MonitorPage) uses, so both hosts behave identically. The lazy wrapper here is
 *  load-bearing for the bundle split: this root is statically reachable from the
 *  entry via the surface registry, so a static MonitorBody import would drag the
 *  body (and its virtualizer) back into the main bundle.
 *
 *  The detail layer is mounted here AND by the in-app overlay: a monitor row click
 *  opens the detail in whichever monitor was clicked, so both hosts need one. The
 *  layer behaves the same in each, with one exception it detects itself - in a
 *  detached window it also publishes the focused-session set, because this renderer
 *  has no `useFocusedSessionsSync` to do it (see MonitorDetailLayer).
 *
 *  Ownership is mounted HERE rather than in the layer, for this renderer's whole
 *  lifetime: the layer is allowed to come and go, but whoever reports what is mounted
 *  must outlive it, or a window left in the store becomes an owner nothing can close.
 *  See `useMonitorDetailOwnership`. */
export function PopOutMonitorRoot() {
  useMonitorDetailOwnership();
  return (
    <>
      <LazyMonitor />
      <MonitorDetailLayer />
    </>
  );
}
