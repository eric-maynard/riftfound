import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RatingPoint } from '../types/ranking';
import {
  buildRatingChartGeometry,
  formatRating,
  formatShortDate,
  formatUncertainty,
  nearestPointIndex,
  parseChartDate,
} from '../lib/ranking';

/**
 * Rating over time for one player, as inline SVG.
 *
 * One series, so there is no legend box, and no caption either - the heading
 * names what is plotted and what the band means lives in the hover hints and in
 * "How rankings work". The hard case this is built for is a sparse
 * series: at launch most players have one to three games, and the chart has to
 * make that look like what it is rather than like a dramatic trend. Three
 * things do that work:
 *
 *  - the x-axis always spans the whole backfill window, so two points two days
 *    apart sit together in three weeks of empty axis;
 *  - the y-axis has a minimum span, so a twenty-point move cannot be
 *    auto-fitted into a cliff;
 *  - the uncertainty band is drawn, not hidden, and at launch it is wide.
 *
 * A one-point series gets a marker and its error bar, never a line: one point
 * is not a trend.
 */

interface RatingChartProps {
  points: RatingPoint[];
  /** Names the series in the chart's own heading. */
  scopeLabel: string;
  /** True when the latest rating has not cleared the confidence gate. */
  provisional?: boolean;
}

const CHART_HEIGHT = 300;
const CHART_HEIGHT_NARROW = 260;
const NARROW_WIDTH = 520;

/** Measure the container so SVG text renders at real pixel sizes. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => setWidth(element.clientWidth);
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function RatingChart({ points, scopeLabel, provisional = false }: RatingChartProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const height = width > 0 && width < NARROW_WIDTH ? CHART_HEIGHT_NARROW : CHART_HEIGHT;
  const geometry = useMemo(
    () => (width > 0 ? buildRatingChartGeometry(points, { width, height }) : null),
    [points, width, height]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!geometry) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      setActiveIndex(nearestPointIndex(geometry, event.clientX - bounds.left));
    },
    [geometry]
  );

  // Order matters: this must come BEFORE the empty-series check. The API now
  // withholds the points themselves for a provisional player (serving them
  // would reconstruct the withheld number exactly), so an unranked player
  // arrives here with points.length === 0 and would otherwise be told "no
  // rating history yet" - which reads as "we have no data" to someone who has
  // played, when we have it and are deliberately not publishing it.
  //
  // The chart would publish that number four ways over anyway: the y-axis
  // ticks, the endpoint label, the tooltip's accessible name and the "Show
  // values" table.
  if (provisional) {
    return (
      <div className="rating-chart rating-chart-empty">
        <p className="muted">
          Unranked &mdash; no rating is published yet, so there is no history to chart. It appears
          here once enough games are recorded.
        </p>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="rating-chart rating-chart-empty">
        <p className="muted">
          No rating history yet. Points appear here once games from a recorded event are matched to
          this player.
        </p>
      </div>
    );
  }


  const active = geometry && activeIndex !== null ? geometry.points[activeIndex] : null;
  const last = points[points.length - 1];

  return (
    <div className="rating-chart">
      <div className="rating-chart-head">
        <div>
          {/* The title carries the scope and nothing else. What the band means
              belongs in "How rankings work" and in the hover hints, not as
              prose under every chart. */}
          <h3 className="rating-chart-title">Rating over time &mdash; {scopeLabel}</h3>
        </div>
        <button
          type="button"
          className="chart-table-toggle"
          onClick={() => setShowTable((open) => !open)}
          aria-expanded={showTable}
        >
          {showTable ? 'Hide values' : 'Show values'}
        </button>
      </div>

      <div className="rating-chart-plot" ref={ref}>
        {geometry && (
          <svg
            width={geometry.width}
            height={geometry.height}
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            role="img"
            aria-label={`Rating over time for ${scopeLabel}. ${points.length} point${points.length === 1 ? '' : 's'}, latest ${formatRating(last.rating)} ${formatUncertainty(last.uncertainty)}. Values are also listed in the table below.`}
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setActiveIndex(null)}
          >
            {/* Gridlines: solid hairlines, one step off the surface. */}
            {geometry.yTicks.map((tick) => (
              <line
                key={`grid-${tick.value}`}
                className="chart-grid"
                x1={geometry.plot.left}
                x2={geometry.plot.left + geometry.plot.width}
                y1={tick.y}
                y2={tick.y}
              />
            ))}
            <line
              className="chart-axis"
              x1={geometry.plot.left}
              x2={geometry.plot.left + geometry.plot.width}
              y1={geometry.plot.top + geometry.plot.height}
              y2={geometry.plot.top + geometry.plot.height}
            />

            {geometry.yTicks.map((tick) => (
              <text
                key={`ytick-${tick.value}`}
                className="chart-tick"
                x={geometry.plot.left - 8}
                y={tick.y}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {tick.label}
              </text>
            ))}
            {geometry.xTicks.map((tick) => (
              <text
                key={`xtick-${tick.value}`}
                className="chart-tick"
                x={tick.x}
                y={geometry.plot.top + geometry.plot.height + 18}
                textAnchor="middle"
              >
                {tick.label}
              </text>
            ))}

            {/* The uncertainty band: a wash, never a saturated block. */}
            {geometry.bandPath && <path className="chart-band" d={geometry.bandPath} />}

            {/* A one-point series has no line; its band becomes an error bar. */}
            {!geometry.bandPath &&
              geometry.points
                .filter((placed) => placed.hasBand)
                .map((placed) => (
                  <line
                    key={`bar-${placed.point.date}`}
                    className="chart-error-bar"
                    x1={placed.x}
                    x2={placed.x}
                    y1={placed.hiY}
                    y2={placed.loY}
                  />
                ))}

            {geometry.linePath && <path className="chart-line" d={geometry.linePath} />}

            {active && (
              <line
                className="chart-crosshair"
                x1={active.x}
                x2={active.x}
                y1={geometry.plot.top}
                y2={geometry.plot.top + geometry.plot.height}
              />
            )}

            {geometry.points.map((placed, index) => (
              <g
                key={placed.point.date}
                tabIndex={0}
                role="img"
                aria-label={`${formatShortDate(parseChartDate(placed.point.date))}: rating ${formatRating(placed.point.rating)}, margin ${formatUncertainty(placed.point.uncertainty) || 'unknown'}${placed.point.gamesPlayed !== null ? `, after ${placed.point.gamesPlayed} games` : ''}`}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
                onPointerEnter={() => setActiveIndex(index)}
              >
                {/* Hit target well beyond the 8px mark. */}
                <rect
                  className="chart-hit"
                  x={placed.x - 14}
                  y={placed.y - 14}
                  width={28}
                  height={28}
                />
                <circle className="chart-point" cx={placed.x} cy={placed.y} r={4} />
              </g>
            ))}

            {/* Direct-label the endpoint only. */}
            {geometry.points.length > 0 && (
              <text
                className="chart-end-label"
                x={Math.min(
                  geometry.points[geometry.points.length - 1].x + 10,
                  geometry.width - 4
                )}
                y={geometry.points[geometry.points.length - 1].y}
                dominantBaseline="middle"
              >
                {formatRating(last.rating)}
              </text>
            )}
          </svg>
        )}

        {active && (
          <div
            className="chart-tooltip"
            style={{
              left: `${Math.min(Math.max(active.x, 8), (geometry?.width ?? 0) - 8)}px`,
              top: `${active.y}px`,
            }}
            role="status"
          >
            <div className="chart-tooltip-value">
              {formatRating(active.point.rating)}
              <span className="chart-tooltip-margin">{formatUncertainty(active.point.uncertainty)}</span>
            </div>
            <div className="chart-tooltip-meta">
              <span className="chart-tooltip-key" aria-hidden="true" />
              {formatShortDate(parseChartDate(active.point.date))}
              {active.point.gamesPlayed !== null && ` · ${active.point.gamesPlayed} games`}
            </div>
          </div>
        )}
      </div>

      {showTable && (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Rating over time for {scopeLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Rating</th>
                <th scope="col">Margin</th>
                <th scope="col">Games</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.date}>
                  <td>{formatShortDate(parseChartDate(point.date))}</td>
                  <td className="numeric">{formatRating(point.rating)}</td>
                  <td className="numeric">{formatUncertainty(point.uncertainty) || '--'}</td>
                  <td className="numeric">{point.gamesPlayed ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default RatingChart;
