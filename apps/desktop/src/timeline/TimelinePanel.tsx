import React, { useEffect, useRef, useState } from "react";

export type TimelinePhase = {
  key: string;
  label: string;
  isMilestone?: boolean;
};

export type TimelinePhaseValue = {
  startDate: string;
  endDate: string;
};

type TimelinePanelProps = {
  phases: TimelinePhase[];
  values: Record<string, TimelinePhaseValue>;
  errors: Record<string, string | null>;
  onChange: (phaseKey: string, field: "startDate" | "endDate", value: string) => void;
};

const TimelinePanel: React.FC<TimelinePanelProps> = ({ phases, values, errors, onChange }) => {
  const [expanded, setExpanded] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<string>("0px");

  useEffect(() => {
    if (!bodyRef.current) return;
    if (expanded) {
      setMaxHeight(`${bodyRef.current.scrollHeight}px`);
    } else {
      setMaxHeight("0px");
    }
  }, [expanded, values, errors]);

  return (
    <div className="timeline-panel">
      <div className="timeline-panel-header">
        <div>
          <h3>Timeline Inputs</h3>
          <p className="muted">Add planned dates for each workflow phase.</p>
        </div>
        <button
          type="button"
          className="timeline-toggle"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse timeline inputs" : "Expand timeline inputs"}
        >
          Edit timeline
          <span className={`timeline-toggle-icon ${expanded ? "expanded" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <div
        ref={bodyRef}
        className={`timeline-panel-body ${expanded ? "expanded" : ""}`}
        style={{ maxHeight }}
      >
        <div className="timeline-grid">
          {phases.map((phase) => {
            const value = values[phase.key] || { startDate: "", endDate: "" };
            const error = errors[phase.key];
            return (
              <div key={phase.key} className="timeline-row">
                <div className="timeline-phase">
                  <span>{phase.label}</span>
                  {error ? <span className="timeline-error">{error}</span> : null}
                </div>
                <div className={`timeline-fields ${phase.isMilestone ? "single" : ""}`}>
                  <input
                    type="date"
                    value={value.startDate}
                    onChange={(event) => onChange(phase.key, "startDate", event.target.value)}
                    placeholder={phase.isMilestone ? "Deadline" : "Start"}
                    aria-invalid={Boolean(error)}
                  />
                  {!phase.isMilestone && (
                    <input
                      type="date"
                      value={value.endDate}
                      onChange={(event) => onChange(phase.key, "endDate", event.target.value)}
                      placeholder="End"
                      aria-invalid={Boolean(error)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TimelinePanel;
