import { memo } from 'react';
import type { CommitGraphLayout } from '../../../../lib/commit-graph-layout';

/**
 * Hand-coded SVG lane gutter for the commit graph: one filled circle per commit
 * and a path per parent edge. No charting dependency (house precedent:
 * `src/renderer/components/debug/ActivityTimeline.tsx`).
 *
 * Unlike ActivityTimeline (a time axis that stretches to fill width via
 * `preserveAspectRatio="none"`), this is sized in exact pixels so nodes stay
 * round and each row lines up 1:1 with its HTML commit row. ROW_HEIGHT is shared
 * with the row list so circle N is centered on text row N.
 */

export const ROW_HEIGHT_PX = 44;
export const LANE_WIDTH_PX = 18;
const NODE_RADIUS_PX = 4.5;
const TIP_RING_RADIUS_PX = 7;

/** Lane colors, cycled by lane index. Chosen for contrast on the dark surface. */
export const LANE_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];

export function laneColor(lane: number): string {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

function laneCenterX(lane: number): number {
  return lane * LANE_WIDTH_PX + LANE_WIDTH_PX / 2;
}

function rowCenterY(row: number): number {
  return row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
}

interface CommitGraphSvgProps {
  layout: CommitGraphLayout;
  /** Full hash of the HEAD tip commit, highlighted with a ring. */
  tipHash: string | null;
}

export const CommitGraphSvg = memo(function CommitGraphSvg({ layout, tipHash }: CommitGraphSvgProps) {
  const width = Math.max(LANE_WIDTH_PX, layout.laneCount * LANE_WIDTH_PX);
  const height = layout.nodes.length * ROW_HEIGHT_PX;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block shrink-0"
      role="img"
      aria-label="Commit graph"
      data-testid="commit-graph-svg"
    >
      {/* Edges first so nodes render on top. Color by the parent's lane so a
          mainline stays one color down its length and a merge line takes the
          color of the branch it merges from. */}
      {layout.edges.map((edge, index) => {
        const fromX = laneCenterX(edge.fromLane);
        const fromY = rowCenterY(edge.fromRow);
        const toX = laneCenterX(edge.toLane);
        const toY = edge.danglingParent ? edge.toRow * ROW_HEIGHT_PX : rowCenterY(edge.toRow);
        const stroke = laneColor(edge.toLane);
        const path =
          edge.fromLane === edge.toLane
            ? `M ${fromX} ${fromY} L ${toX} ${toY}`
            : `M ${fromX} ${fromY} C ${fromX} ${(fromY + toY) / 2}, ${toX} ${(fromY + toY) / 2}, ${toX} ${toY}`;
        return (
          <path
            key={`edge-${index}`}
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={edge.danglingParent ? 0.5 : 0.85}
            strokeDasharray={edge.danglingParent ? '2 3' : undefined}
          />
        );
      })}

      {layout.nodes.map((node) => {
        const cx = laneCenterX(node.lane);
        const cy = rowCenterY(node.row);
        const color = laneColor(node.lane);
        const isTip = tipHash !== null && node.hash === tipHash;
        return (
          <g key={node.hash}>
            {isTip && (
              <circle cx={cx} cy={cy} r={TIP_RING_RADIUS_PX} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />
            )}
            <circle cx={cx} cy={cy} r={NODE_RADIUS_PX} fill={color} />
          </g>
        );
      })}
    </svg>
  );
});
