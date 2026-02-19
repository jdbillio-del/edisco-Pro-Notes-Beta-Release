export const TIMELINE_PHASES = [
  { key: "Collections", label: "Collections" },
  { key: "Processing", label: "Processing" },
  { key: "TAR", label: "TAR" },
  { key: "Review", label: "Review" },
  { key: "Post-processing", label: "Post-processing" },
  { key: "Production", label: "Production" },
  { key: "Project Completion", label: "Project Completion", isMilestone: true }
];

export const GANTT_DAY_WIDTH = 20;

export const PROJECT_COLOR_PALETTE = [
  "#35d0a6",
  "#f59e0b",
  "#38bdf8",
  "#fb7185",
  "#a78bfa",
  "#22c55e",
  "#f97316",
  "#0ea5e9"
];

export const PHASE_COLOR_MAP: Record<string, string> = {
  Collections: "#f59e0b",
  Processing: "#38bdf8",
  TAR: "#a78bfa",
  Review: "#fb7185",
  "Post-processing": "#22c55e",
  Production: "#0ea5e9",
  "Project Completion": "#f97316"
};
