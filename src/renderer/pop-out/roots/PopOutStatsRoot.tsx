import { StatsDashboardBody } from '../../components/stats/StatsDashboardBody';

/** Pop-out root for the 'stats' surface. Mounted inside PopOutWindowFrame by
 *  PopOutSurfaceRoot; renders the same StatsDashboardBody the in-app overlay
 *  (StatsPage) uses, so the live pipeline is identical in both hosts. */
export function PopOutStatsRoot() {
  return <StatsDashboardBody />;
}
