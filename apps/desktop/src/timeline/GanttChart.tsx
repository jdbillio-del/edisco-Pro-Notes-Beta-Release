import React, { useMemo } from "react";
import { GANTT_DAY_WIDTH } from "./constants";
import { buildDateRange, diffInDays, formatRangeLabel, getRangeFromRows, isValidRange, parseIsoDate } from "./utils";

export type GanttRow = {
  id: string;
  label: string;
  startDate?: string | null;
  endDate?: string | null;
  color?: string;
  isGroup?: boolean;
  milestoneDate?: string | null;
  isProjectCompletion?: boolean;
};

type GanttChartProps = {
  rows: GanttRow[];
  dayPadding?: number;
  emptyState?: string;
};

const GanttChart: React.FC<GanttChartProps> = ({ rows, dayPadding = 7, emptyState }) => {
  const range = useMemo(() => getRangeFromRows(rows, dayPadding), [rows, dayPadding]);

  if (!range) {
    return (
      <div className="gantt-empty">
        <p className="muted">{emptyState || "Add dates above to visualize your timeline."}</p>
      </div>
    );
  }

  const days = buildDateRange(range.start, range.end);
  const dayCount = days.length;
  const gridWidth = dayCount * GANTT_DAY_WIDTH;

  const monthSpans: { label: string; span: number }[] = [];
  const weekSpans: { label: string; span: number }[] = [];
  let currentMonth = "";
  let currentMonthSpan = 0;
  let weekIndex = 1;
  let weekSpan = 0;
  let dayIndexInMonth = 0;

  days.forEach((day, index) => {
    const monthLabel = day.toLocaleDateString(undefined, { month: "long" });
    if (monthLabel !== currentMonth) {
      if (currentMonth) {
        monthSpans.push({ label: currentMonth, span: currentMonthSpan });
        weekSpans.push({ label: `W${weekIndex}`, span: weekSpan });
      }
      currentMonth = monthLabel;
      currentMonthSpan = 0;
      weekIndex = 1;
      weekSpan = 0;
      dayIndexInMonth = 0;
    }

    currentMonthSpan += 1;
    weekSpan += 1;
    dayIndexInMonth += 1;

    const isWeekBreak = dayIndexInMonth % 7 === 0;
    const isLastDay = index === days.length - 1;
    if (isWeekBreak || isLastDay) {
      weekSpans.push({ label: `W${weekIndex}`, span: weekSpan });
      weekIndex += 1;
      weekSpan = 0;
    }
  });

  if (currentMonth) {
    monthSpans.push({ label: currentMonth, span: currentMonthSpan });
  }

  const completionWeekOffsets = Array.from(
    new Set(
      rows
        .filter((row) => row.isProjectCompletion)
        .map((row) => row.milestoneDate)
        .filter((value): value is string => Boolean(value))
        .map((value) => {
          const date = parseIsoDate(value);
          if (!date) return null;
          const dayOffset = diffInDays(range.start, date);
          return Math.floor(dayOffset / 7);
        })
        .filter((offset): offset is number => offset !== null)
    )
  );

  return (
    <div className="gantt-wrapper">
      <div className="gantt-left">
        <div className="gantt-left-header">Phase</div>
        {rows.map((row) => (
          <div key={row.id} className={`gantt-left-row ${row.isGroup ? "group" : ""}`}>
            {row.label}
          </div>
        ))}
      </div>
      <div className="gantt-scroll">
        <div
          className="gantt-grid"
          style={{ width: gridWidth, "--gantt-day-width": `${GANTT_DAY_WIDTH}px` } as React.CSSProperties}
        >
          <div className="gantt-header">
            <div className="gantt-month-row">
              {monthSpans.map((month, index) => (
                <div key={`${month.label}-${index}`} className="gantt-month" style={{ width: month.span * GANTT_DAY_WIDTH }}>
                  {month.label}
                </div>
              ))}
            </div>
            <div className="gantt-week-row">
              {weekSpans.map((week, index) => (
                <div key={`${week.label}-${index}`} className="gantt-week" style={{ width: week.span * GANTT_DAY_WIDTH }}>
                  {week.label}
                </div>
              ))}
            </div>
          </div>
          <div className="gantt-body" style={{ height: rows.length * 32 }}>
            {completionWeekOffsets.map((weekOffset) => (
              <div
                key={`completion-week-${weekOffset}`}
                className="gantt-completion-line"
                style={{ left: (weekOffset * 7 + 3.5) * GANTT_DAY_WIDTH }}
                title="Project completion week"
              />
            ))}
            {rows.map((row, index) => {
              const start = parseIsoDate(row.startDate);
              const end = parseIsoDate(row.endDate);
              const valid = isValidRange(row.startDate, row.endDate);
              let barStyle: React.CSSProperties | undefined;

              if (start && end && valid) {
                const offset = diffInDays(range.start, start);
                const duration = diffInDays(start, end) + 1;
                barStyle = {
                  left: offset * GANTT_DAY_WIDTH,
                  width: duration * GANTT_DAY_WIDTH,
                  backgroundColor: row.color
                };
              }

              return (
                <div
                  key={row.id}
                  className={`gantt-row ${row.isGroup ? "group" : ""}`}
                  data-index={index}
                >
                  {barStyle ? (
                    <div className="gantt-bar" style={barStyle} title={formatRangeLabel(row.startDate, row.endDate)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GanttChart;
