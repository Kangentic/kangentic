import { LazyStatsDashboard } from '../../components/stats/LazyStatsDashboard';

/** Pop-out root for the 'stats' surface. Mounted inside PopOutWindowFrame by
 *  PopOutSurfaceRoot; renders the same (lazy) StatsDashboardBody the in-app
 *  overlay (StatsPage) uses, so the live pipeline is identical in both hosts.
 *  The lazy wrapper here is load-bearing for the bundle split: this root is
 *  statically reachable from the entry via the surface registry, so a static
 *  StatsDashboardBody import would drag recharts back into the main bundle. */
export function PopOutStatsRoot() {
  return <LazyStatsDashboard />;
}
