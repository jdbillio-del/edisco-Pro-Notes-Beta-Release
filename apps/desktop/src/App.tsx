import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GanttChart, { GanttRow } from "./timeline/GanttChart";
import TimelinePanel, { TimelinePhaseValue } from "./timeline/TimelinePanel";
import { PHASE_COLOR_MAP, PROJECT_COLOR_PALETTE, TIMELINE_PHASES } from "./timeline/constants";
import { isValidRange, projectColorForId } from "./timeline/utils";

const DEFAULT_TEMPLATE = `Collections\n  • …\n  • …\n\nProcessing\n  • …\n  • …\n\nTAR\n  • …\n  • …\n\nReview\n  • …\n  • …\n\nPost-processing\n  • …\n  • …\n\nProduction\n  • …\n  • …\n\nProject Completion\n  • …\n  • …\n`;

const tabs = ["Notes", "Timelines", "To-Do", "Documents"] as const;

type TabKey = (typeof tabs)[number];

type ExportStatus = "idle" | "working" | "done" | "error";
type NoteSaveStatus = "idle" | "saving" | "saved" | "error";
type SearchScope = "project" | "global";
type BackupActionStatus = "idle" | "working" | "done" | "error";
type ThemeMode = "light" | "dark";
type RichToolState = {
  header: boolean;
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  quote: boolean;
  bullet: boolean;
  subBullet: boolean;
};

type ProjectFormState = {
  matterName: string;
  clientName: string;
  billingCode: string;
  startDate: string;
  productionDeadline: string;
  relativityUrl: string;
};

type TimelineValues = Record<string, TimelinePhaseValue>;

type TimelineView = "project" | "all";

const emptyForm: ProjectFormState = {
  matterName: "",
  clientName: "",
  billingCode: "",
  startDate: "",
  productionDeadline: "",
  relativityUrl: ""
};

const formatDate = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
};

const formatDateTime = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatIsoDate = (value?: string | null) => {
  if (!value) return "";
  return value.slice(0, 10);
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const formatDaysLabel = (days: number | null | undefined) => {
  if (days === null || days === undefined || Number.isNaN(days)) return "No deadline";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  return `${days}d left`;
};

const formatAuditAction = (value: string) =>
  value
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const inlineMarkdown = (value: string) =>
  value
    .replace(/==(.+?)==/g, "<mark>$1</mark>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

const normalizeEditorText = (value: string) => value.replace(/\u00a0/g, " ");

const ALLOWED_EDITOR_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "blockquote", "strong", "em", "mark", "code", "br", "div"]);

const sanitizeEditorHtml = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;

  const sanitizeNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
    if (!(node instanceof HTMLElement)) return null;

    const tag = node.tagName.toLowerCase();
    const fragment = document.createDocumentFragment();
    Array.from(node.childNodes).forEach((child) => {
      const cleaned = sanitizeNode(child);
      if (cleaned) fragment.appendChild(cleaned);
    });

    if (!ALLOWED_EDITOR_TAGS.has(tag)) {
      return fragment;
    }

    const next = document.createElement(tag);
    next.appendChild(fragment);
    return next;
  };

  const out = document.createElement("div");
  Array.from(template.content.childNodes).forEach((child) => {
    const cleaned = sanitizeNode(child);
    if (cleaned) out.appendChild(cleaned);
  });
  return out.innerHTML;
};

const inlineNodeToMarkdown = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeEditorText(node.textContent || "");
  }
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  const content = Array.from(node.childNodes).map((child) => inlineNodeToMarkdown(child)).join("");

  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") return `**${content}**`;
  if (tag === "em" || tag === "i") return `*${content}*`;
  if (tag === "mark") return `==${content}==`;
  if (tag === "code") return `\`${content}\``;

  return content;
};

const hasBlockChildren = (element: HTMLElement) =>
  Array.from(element.children).some((child) => {
    const tag = child.tagName.toLowerCase();
    return ["p", "div", "section", "article", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4"].includes(tag);
  });

const listToMarkdown = (listElement: HTMLElement, depth = 0): string => {
  let output = "";
  Array.from(listElement.children).forEach((child) => {
    if (!(child instanceof HTMLElement) || child.tagName.toLowerCase() !== "li") return;
    let line = "";
    let nested = "";
    Array.from(child.childNodes).forEach((item) => {
      if (item instanceof HTMLElement) {
        const tag = item.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          nested += listToMarkdown(item, depth + 1);
          return;
        }
      }
      line += inlineNodeToMarkdown(item);
    });
    const clean = normalizeEditorText(line).replace(/\s+/g, " ").trim();
    output += `${"  ".repeat(depth)}- ${clean}\n`;
    if (nested) output += nested;
  });
  return output ? `${output}\n` : "";
};

const blockNodesToMarkdown = (nodes: Node[]): string => nodes.map((node) => blockNodeToMarkdown(node)).join("");

const blockNodeToMarkdown = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeEditorText(node.textContent || "").trim();
    return text ? `${text}\n\n` : "";
  }
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";

  if (tag === "ul" || tag === "ol") {
    return listToMarkdown(node, 0);
  }

  if (tag === "blockquote") {
    const content = blockNodesToMarkdown(Array.from(node.childNodes)).trim();
    if (!content) return "> \n\n";
    const quoted = content
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
    return `${quoted}\n\n`;
  }

  if (/^h[1-4]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = inlineNodeToMarkdown(node).trim();
    return text ? `${"#".repeat(level)} ${text}\n\n` : "";
  }

  if (tag === "div" || tag === "section" || tag === "article") {
    if (hasBlockChildren(node)) {
      return blockNodesToMarkdown(Array.from(node.childNodes));
    }
    const text = inlineNodeToMarkdown(node).trim();
    return text ? `${text}\n\n` : "";
  }

  if (tag === "p") {
    const text = inlineNodeToMarkdown(node).trim();
    return text ? `${text}\n\n` : "\n";
  }

  const text = inlineNodeToMarkdown(node).trim();
  return text ? `${text}\n\n` : "";
};

const htmlToMarkdown = (html: string) => {
  const container = document.createElement("div");
  container.innerHTML = sanitizeEditorHtml(html);
  return blockNodesToMarkdown(Array.from(container.childNodes))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const markdownToHtml = (markdown: string) => {
  const lines = String(markdown || "").split("\n");
  const out: string[] = [];
  let inList = false;

  const closeList = () => {
    if (!inList) return;
    out.push("</ul>");
    inList = false;
  };

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.max(1, Math.min(4, heading[1].length));
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote><p>${inlineMarkdown(quote[1])}</p></blockquote>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      out.push("<p></p>");
      continue;
    }

    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  return out.join("");
};

type RgbColor = [number, number, number];
type RgbaColor = [number, number, number, number];

const parseColor = (value: string): RgbaColor | null => {
  const input = value.trim().toLowerCase();
  if (input === "transparent") return [0, 0, 0, 0];
  if (input.startsWith("#")) {
    const hex = input.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        1
      ];
    }
    if (hex.length === 4) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        parseInt(hex[3] + hex[3], 16) / 255
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        1
      ];
    }
    if (hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(6, 8), 16) / 255
      ];
    }
    return null;
  }
  const rgb = input.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgb[4])));
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
};

const toRgb = ([r, g, b]: RgbaColor): RgbColor => [r, g, b];

const blendRgbaOver = (foreground: RgbaColor, background: RgbaColor): RgbaColor => {
  const a = foreground[3] + background[3] * (1 - foreground[3]);
  if (a <= 0) return [0, 0, 0, 0];
  const r = (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / a;
  const g = (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / a;
  const b = (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / a;
  return [r, g, b, a];
};

const fallbackAuditBase = (): RgbaColor => {
  const root = document.documentElement;
  const explicitTheme = root.dataset.theme;
  const dark = explicitTheme !== "light";
  return dark ? [14, 21, 33, 1] : [248, 250, 255, 1];
};

const resolveEffectiveBackground = (element: HTMLElement | null): RgbColor => {
  let current = element;
  let composite = fallbackAuditBase();
  while (current) {
    const parsed = parseColor(getComputedStyle(current).backgroundColor || "");
    if (parsed && parsed[3] > 0) {
      composite = blendRgbaOver(parsed, composite);
      if (composite[3] >= 0.999) break;
    }
    current = current.parentElement;
  }
  return toRgb(composite);
};

const relativeLuminance = ([r, g, b]: RgbColor) => {
  const normalize = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
};

const contrastRatio = (foreground: string, background: string | RgbColor) => {
  const fg = parseColor(foreground);
  const bg = Array.isArray(background)
    ? [background[0], background[1], background[2], 1] as RgbaColor
    : parseColor(background);
  if (!fg || !bg) return null;
  const l1 = relativeLuminance(toRgb(fg));
  const l2 = relativeLuminance(toRgb(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

const buildNoteTitle = (dateIso: string) => {
  return `Notes – ${dateIso}`;
};

const isChecked = (value: boolean | number) => Boolean(value);

const tabId = (tab: TabKey) => `tab-${tab.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const tabPanelId = (tab: TabKey) => `panel-${tab.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

const buildTimelineValues = (items: TimelineTask[]): TimelineValues => {
  const base: TimelineValues = {};
  TIMELINE_PHASES.forEach((phase) => {
    base[phase.key] = {
      startDate: "",
      endDate: ""
    };
  });

  items.forEach((item) => {
    base[item.phase] = {
      startDate: formatIsoDate(item.startDate),
      endDate: formatIsoDate(item.endDate)
    };
  });

  return base;
};

const buildTimelineErrors = (values: TimelineValues) => {
  const errors: Record<string, string | null> = {};
  TIMELINE_PHASES.forEach((phase) => {
    const value = values[phase.key];
    if (phase.isMilestone) {
      errors[phase.key] = null;
      return;
    }
    if (!value?.startDate || !value?.endDate) {
      errors[phase.key] = null;
      return;
    }
    errors[phase.key] = isValidRange(value.startDate, value.endDate) ? null : "Start must be before end.";
  });
  return errors;
};

const getDeadlineBadge = (value?: string | null): { label: string; tone: "late" | "soon" | "normal" } | null => {
  if (!value) return null;
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) {
    return { label: `Overdue ${Math.abs(days)}d`, tone: "late" };
  }
  if (days <= 7) {
    return { label: `${days}d left`, tone: "soon" };
  }
  return { label: `${days}d left`, tone: "normal" };
};

const copyToClipboard = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
};

const includesQuery = (query: string, ...parts: Array<string | null | undefined>) => {
  if (!query) return true;
  return parts.some((part) => String(part || "").toLowerCase().includes(query));
};

const ONBOARDING_STORAGE_KEY = "edisconotes.onboarding.v1.completed";
const FLASH_MS = 1200;
const THEME_MODE_STORAGE_KEY = "edisconotes.theme.mode.v1";
const THEME_ACCENT_STORAGE_KEY = "edisconotes.theme.accent.v1";
const DEFAULT_ACCENT_COLOR = "#35d0a6";

const normalizeHexColor = (value: string) => {
  const input = String(value || "").trim();
  const short = input.match(/^#?([a-fA-F0-9]{3})$/);
  if (short) {
    const expanded = short[1]
      .split("")
      .map((char) => `${char}${char}`)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  const full = input.match(/^#?([a-fA-F0-9]{6})$/);
  if (full) return `#${full[1].toLowerCase()}`;
  return null;
};

const hexToRgb = (hex: string): [number, number, number] => {
  const safe = normalizeHexColor(hex) || DEFAULT_ACCENT_COLOR;
  return [
    parseInt(safe.slice(1, 3), 16),
    parseInt(safe.slice(3, 5), 16),
    parseInt(safe.slice(5, 7), 16)
  ];
};

const rgbToHex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;

const darkenHex = (hex: string, factor = 0.22) => {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * (1 - factor), g * (1 - factor), b * (1 - factor)]);
};

const hexToRgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
};

const applyThemeTokens = (mode: ThemeMode, accent: string) => {
  const root = document.documentElement;
  const safeAccent = normalizeHexColor(accent) || DEFAULT_ACCENT_COLOR;
  const accentDark = darkenHex(safeAccent, 0.22);
  root.setAttribute("data-theme", mode);
  root.style.colorScheme = mode;
  root.style.setProperty("--accent", safeAccent);
  root.style.setProperty("--accent-dark", accentDark);
  root.style.setProperty("--accent-glow", hexToRgba(safeAccent, 0.4));
  root.style.setProperty("--gradient-accent", `linear-gradient(135deg, ${safeAccent} 0%, ${accentDark} 100%)`);
  root.style.setProperty("--shadow-accent", `0 8px 24px ${hexToRgba(safeAccent, 0.3)}`);
  root.style.setProperty("--shadow-accent-lg", `0 12px 32px ${hexToRgba(safeAccent, 0.35)}`);
};

const NOTE_TEMPLATES = [
  {
    id: "workflow-default",
    label: "Workflow Default",
    description: "Full lifecycle template from collection to completion.",
    content: DEFAULT_TEMPLATE
  },
  {
    id: "daily-standup",
    label: "Daily Standup",
    description: "Short status snapshot for meetings.",
    content:
      "## Daily Snapshot\n\n- Wins\n- Blockers\n- Next 24h\n\n## Risks\n\n- \n\n## Requests\n\n- \n"
  },
  {
    id: "production-check",
    label: "Production Check",
    description: "Pre-flight checks before production delivery.",
    content:
      "## Production Readiness\n\n- Bates plan confirmed\n- Privilege log delta confirmed\n- QC pass complete\n\n## Deliverables\n\n- Production volume\n- Cover memo\n- Exception log\n"
  }
] as const;

const ACCENT_PRESETS = ["#35d0a6", "#3a86ff", "#f97316", "#ef4444", "#14b8a6", "#a855f7"] as const;

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [quickSearch, setQuickSearch] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("project");
  const [globalSearch, setGlobalSearch] = useState<GlobalSearchResult | null>(null);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("Notes");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteSaveStatus, setNoteSaveStatus] = useState<NoteSaveStatus>("idle");
  const [richToolState, setRichToolState] = useState<RichToolState>({
    header: false,
    bold: false,
    italic: false,
    highlight: false,
    quote: false,
    bullet: false,
    subBullet: false
  });
  const [todos, setTodos] = useState<Todo[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectFormState>(emptyForm);
  const [projectFormMode, setProjectFormMode] = useState<"create" | "edit">("create");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [todoText, setTodoText] = useState("");
  const [todoPriority, setTodoPriority] = useState(false);
  const [todoFilter, setTodoFilter] = useState<"all" | "priority">("all");
  const [todoSort, setTodoSort] = useState<"oldest" | "newest">("oldest");
  const [wordExportStatus, setWordExportStatus] = useState<ExportStatus>("idle");
  const [pdfExportStatus, setPdfExportStatus] = useState<ExportStatus>("idle");
  const [markdownExportStatus, setMarkdownExportStatus] = useState<ExportStatus>("idle");
  const [copyRelativityStatus, setCopyRelativityStatus] = useState<"idle" | "done" | "error">("idle");
  const [timelineView, setTimelineView] = useState<TimelineView>("project");
  const [timelineValues, setTimelineValues] = useState<TimelineValues>(() => buildTimelineValues([]));
  const [timelineErrors, setTimelineErrors] = useState<Record<string, string | null>>(() =>
    buildTimelineErrors(buildTimelineValues([]))
  );
  const [allTimelineTasks, setAllTimelineTasks] = useState<TimelineTask[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [dragOverDocs, setDragOverDocs] = useState(false);
  const [newNoteFlashId, setNewNoteFlashId] = useState<string | null>(null);
  const [newTodoFlashId, setNewTodoFlashId] = useState<string | null>(null);
  const [newAttachmentFlashId, setNewAttachmentFlashId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<AttachmentPreviewResult | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [dataSafetyExpanded, setDataSafetyExpanded] = useState(false);
  const [backupActionStatus, setBackupActionStatus] = useState<BackupActionStatus>("idle");
  const [backupActionMessage, setBackupActionMessage] = useState<string | null>(null);
  const [bundleActionStatus, setBundleActionStatus] = useState<BackupActionStatus>("idle");
  const [bundleActionMessage, setBundleActionMessage] = useState<string | null>(null);
  const [snapshotActionStatus, setSnapshotActionStatus] = useState<BackupActionStatus>("idle");
  const [snapshotActionMessage, setSnapshotActionMessage] = useState<string | null>(null);
  const [snapshotItems, setSnapshotItems] = useState<BackupSnapshot[]>([]);
  const [auditLogItems, setAuditLogItems] = useState<AuditLogEntry[]>([]);
  const [deadlineDashboard, setDeadlineDashboard] = useState<DeadlineDashboard | null>(null);
  const [dashboardRefreshing, setDashboardRefreshing] = useState(false);
  const [a11yAuditOpen, setA11yAuditOpen] = useState(false);
  const [a11yAuditRunAt, setA11yAuditRunAt] = useState<string | null>(null);
  const [a11yAuditResults, setA11yAuditResults] = useState<Array<{ label: string; pass: boolean; detail: string }>>([]);
  const [pendingNoteSelectionId, setPendingNoteSelectionId] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch {
      // ignore
    }
    return "dark";
  });
  const [accentColor, setAccentColor] = useState<string>(() => {
    try {
      return normalizeHexColor(window.localStorage.getItem(THEME_ACCENT_STORAGE_KEY) || "") || DEFAULT_ACCENT_COLOR;
    } catch {
      return DEFAULT_ACCENT_COLOR;
    }
  });

  const saveResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSnapshotRef = useRef<{ id: string; title: string; content: string } | null>(null);
  const projectMatterInputRef = useRef<HTMLInputElement | null>(null);
  const archiveCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const quickSearchInputRef = useRef<HTMLInputElement | null>(null);
  const richEditorRef = useRef<HTMLDivElement | null>(null);
  const flashTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const modalReturnFocusRef = useRef<HTMLElement | null>(null);

  const anyModalOpen = showProjectForm || showArchiveConfirm || showShortcuts || showOnboarding || previewOpen || showSettings;

  const getTopModal = () => {
    const modals = Array.from(document.querySelectorAll(".modal-backdrop .modal")) as HTMLElement[];
    return modals.length ? modals[modals.length - 1] : null;
  };

  const getFocusableElements = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getAttribute("aria-hidden") !== "true";
    });

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  useEffect(() => {
    if (!selectedProjectId) return;
    if (projects.some((project) => project.id === selectedProjectId)) return;
    setSelectedProjectId(null);
  }, [projects, selectedProjectId]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) || null,
    [notes, selectedNoteId]
  );

  const projectNameLookup = useMemo(
    () => new Map(projects.map((project) => [project.id, project.matterName])),
    [projects]
  );

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    setOnboardingStep(0);
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    window.edisconotes.listProjects().then((items) => {
      setProjects(items);
    });
  }, []);

  const refreshSafetyData = useCallback(async () => {
    const [backupResult, snapshotResult, auditResult, dashboardResult] = await Promise.allSettled([
      window.edisconotes.backupStatus(),
      window.edisconotes.listBackupSnapshots(12),
      window.edisconotes.listAuditLog(30),
      window.edisconotes.getDeadlineDashboard()
    ]);

    if (backupResult.status === "fulfilled") {
      setBackupStatus(backupResult.value);
    } else {
      console.error("Failed to load backup status", backupResult.reason);
    }

    if (snapshotResult.status === "fulfilled") {
      setSnapshotItems(snapshotResult.value);
    } else {
      console.error("Failed to load snapshots", snapshotResult.reason);
    }

    if (auditResult.status === "fulfilled") {
      setAuditLogItems(auditResult.value);
    } else {
      console.error("Failed to load audit log", auditResult.reason);
    }

    if (dashboardResult.status === "fulfilled") {
      setDeadlineDashboard(dashboardResult.value);
    } else {
      console.error("Failed to load deadline dashboard", dashboardResult.reason);
    }
  }, []);

  const refreshDashboardNow = useCallback(async () => {
    setDashboardRefreshing(true);
    try {
      await refreshSafetyData();
    } finally {
      setDashboardRefreshing(false);
    }
  }, [refreshSafetyData]);

  const goHomeDashboard = useCallback(() => {
    setSelectedProjectId(null);
    setQuickSearch("");
    setSearchScope("project");
    setGlobalSearch(null);
  }, []);

  const openProjectTodoRollup = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveTab("To-Do");
    setQuickSearch("");
    setSearchScope("project");
    setGlobalSearch(null);
  }, []);

  useEffect(() => {
    refreshSafetyData();
    const interval = window.setInterval(refreshSafetyData, 15000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshSafetyData]);

  useEffect(() => {
    if (noteSaveStatus !== "saved") return;
    refreshSafetyData();
  }, [noteSaveStatus, refreshSafetyData]);

  useEffect(() => {
    const safeAccent = normalizeHexColor(accentColor) || DEFAULT_ACCENT_COLOR;
    applyThemeTokens(themeMode, safeAccent);

    try {
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
      window.localStorage.setItem(THEME_ACCENT_STORAGE_KEY, safeAccent);
    } catch {
      // ignore
    }
  }, [themeMode, accentColor]);

  useEffect(() => {
    if (!showArchived) {
      setArchivedProjects([]);
      return;
    }
    window.edisconotes.listProjects(true).then((items) => {
      setArchivedProjects(items.filter((project) => project.archivedAt));
    });
  }, [showArchived, projects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedNoteId(null);
      setNotes([]);
      setTodos([]);
      setAttachments([]);
      setTimelineValues(buildTimelineValues([]));
      setTimelineErrors(buildTimelineErrors(buildTimelineValues([])));
      return;
    }
    setSelectedNoteId(null);

    const timelinePromise = window.edisconotes.listTimelineTasks(selectedProjectId).catch((error) => {
      console.error("Timeline list failed", error);
      return [];
    });

    Promise.all([
      window.edisconotes.listNotes(selectedProjectId),
      window.edisconotes.listTodos(selectedProjectId),
      window.edisconotes.listAttachments(selectedProjectId),
      timelinePromise
    ]).then(([noteItems, todoItems, attachmentItems, timelineItems]) => {
      setNotes(noteItems);
      setTodos(todoItems);
      setAttachments(attachmentItems);
      const nextTimelineValues = buildTimelineValues(timelineItems);
      setTimelineValues(nextTimelineValues);
      setTimelineErrors(buildTimelineErrors(nextTimelineValues));
      if (noteItems.length) {
        setSelectedNoteId(noteItems[0].id);
      }
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!pendingNoteSelectionId) return;
    if (!notes.some((note) => note.id === pendingNoteSelectionId)) return;
    setSelectedNoteId(pendingNoteSelectionId);
    setPendingNoteSelectionId(null);
  }, [notes, pendingNoteSelectionId]);

  useEffect(() => {
    if (searchScope !== "global") {
      setGlobalSearch(null);
      setGlobalSearchLoading(false);
      return;
    }
    const query = quickSearch.trim();
    if (!query) {
      setGlobalSearch(null);
      setGlobalSearchLoading(false);
      return;
    }

    let active = true;
    setGlobalSearchLoading(true);
    const timer = window.setTimeout(() => {
      window.edisconotes
        .searchGlobal(query)
        .then((results) => {
          if (active) {
            setGlobalSearch(results);
          }
        })
        .catch((error) => {
          console.error("Global search failed", error);
          if (active) {
            setGlobalSearch(null);
          }
        })
        .finally(() => {
          if (active) {
            setGlobalSearchLoading(false);
          }
        });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [quickSearch, searchScope]);

  useEffect(() => {
    if (!selectedNote) {
      setNoteDraft("");
      setNoteTitle("");
      setNoteSaveStatus("idle");
      saveSnapshotRef.current = null;
      return;
    }
    setNoteDraft(selectedNote.contentMarkdown);
    setNoteTitle(selectedNote.title);
    setNoteSaveStatus("idle");
    saveSnapshotRef.current = {
      id: selectedNote.id,
      title: selectedNote.title,
      content: selectedNote.contentMarkdown
    };
  }, [selectedNote]);

  const syncRichEditorToDraft = useCallback(() => {
    const editor = richEditorRef.current;
    if (!editor) return;
    const next = htmlToMarkdown(editor.innerHTML);
    setNoteDraft((prev) => (prev === next ? prev : next));
  }, []);

  const findAncestorInEditor = useCallback((selector: string) => {
    const editor = richEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return null;
    const anchorNode = selection.anchorNode;
    if (!anchorNode) return null;
    const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement;
    if (!anchorElement || !editor.contains(anchorElement)) return null;
    const found = anchorElement.closest(selector);
    return found && editor.contains(found) ? (found as HTMLElement) : null;
  }, []);

  const getCommandState = useCallback((command: string) => {
    try {
      return document.queryCommandState(command);
    } catch {
      return false;
    }
  }, []);

  const refreshRichToolState = useCallback(() => {
    const editor = richEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      setRichToolState((prev) =>
        prev.header || prev.bold || prev.italic || prev.highlight || prev.quote || prev.bullet || prev.subBullet
          ? { header: false, bold: false, italic: false, highlight: false, quote: false, bullet: false, subBullet: false }
          : prev
      );
      return;
    }
    const anchorNode = selection.anchorNode;
    if (!anchorNode || !editor.contains(anchorNode)) {
      setRichToolState((prev) =>
        prev.header || prev.bold || prev.italic || prev.highlight || prev.quote || prev.bullet || prev.subBullet
          ? { header: false, bold: false, italic: false, highlight: false, quote: false, bullet: false, subBullet: false }
          : prev
      );
      return;
    }

    let highlight = Boolean(findAncestorInEditor("mark, span[style*='background-color']"));
    try {
      const value = String(document.queryCommandValue("hiliteColor") || "").toLowerCase();
      if (value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)") {
        highlight = true;
      }
    } catch {
      // ignore
    }

    const listItem = findAncestorInEditor("li");
    const subBullet = Boolean(listItem?.parentElement?.closest("li"));

    setRichToolState({
      header: Boolean(findAncestorInEditor("h1, h2, h3, h4")),
      bold: getCommandState("bold"),
      italic: getCommandState("italic"),
      highlight,
      quote: Boolean(findAncestorInEditor("blockquote")),
      bullet: Boolean(listItem),
      subBullet
    });
  }, [findAncestorInEditor, getCommandState]);

  const runRichCommand = useCallback(
    (command: string, value?: string) => {
      const editor = richEditorRef.current;
      if (!editor) return;
      editor.focus();
      document.execCommand(command, false, value);
      syncRichEditorToDraft();
      refreshRichToolState();
    },
    [refreshRichToolState, syncRichEditorToDraft]
  );

  useEffect(() => {
    const editor = richEditorRef.current;
    if (!editor) return;
    if (document.activeElement === editor) return;
    const html = noteDraft.trim() ? sanitizeEditorHtml(markdownToHtml(noteDraft)) : "";
    if (editor.innerHTML !== html) {
      editor.innerHTML = html;
    }
  }, [noteDraft, selectedNoteId]);

  useEffect(() => {
    const editor = richEditorRef.current;
    if (!editor) return;
    const handle = () => refreshRichToolState();
    document.addEventListener("selectionchange", handle);
    editor.addEventListener("input", handle);
    editor.addEventListener("keyup", handle);
    editor.addEventListener("mouseup", handle);
    editor.addEventListener("focus", handle);
    editor.addEventListener("blur", handle);
    handle();
    return () => {
      document.removeEventListener("selectionchange", handle);
      editor.removeEventListener("input", handle);
      editor.removeEventListener("keyup", handle);
      editor.removeEventListener("mouseup", handle);
      editor.removeEventListener("focus", handle);
      editor.removeEventListener("blur", handle);
    };
  }, [refreshRichToolState, selectedNoteId]);

  useEffect(() => {
    if (!selectedNoteId) return;

    const nextTitle = noteTitle.trim() || "Untitled Note";
    const snapshot = saveSnapshotRef.current;
    if (
      snapshot &&
      snapshot.id === selectedNoteId &&
      snapshot.title === nextTitle &&
      snapshot.content === noteDraft
    ) {
      return;
    }

    setNoteSaveStatus("saving");

    const handler = setTimeout(() => {
      window.edisconotes
        .updateNote(selectedNoteId, {
          title: nextTitle,
          noteDate: selectedNote?.noteDate || new Date().toISOString().slice(0, 10),
          contentMarkdown: noteDraft
        })
        .then((updated) => {
          setNotes((prev) => prev.map((note) => (note.id === updated.id ? updated : note)));
          saveSnapshotRef.current = {
            id: updated.id,
            title: updated.title,
            content: updated.contentMarkdown
          };
          setNoteSaveStatus("saved");
          if (saveResetTimerRef.current) {
            clearTimeout(saveResetTimerRef.current);
          }
          saveResetTimerRef.current = setTimeout(() => setNoteSaveStatus("idle"), 1200);
        })
        .catch((error) => {
          console.error("Note autosave failed", error);
          setNoteSaveStatus("error");
        });
    }, 600);

    return () => clearTimeout(handler);
  }, [noteDraft, noteTitle, selectedNoteId, selectedNote?.noteDate]);

  useEffect(() => {
    if (timelineView !== "all") return;
    window.edisconotes
      .listTimelineTasks()
      .then((items) => {
        setAllTimelineTasks(items);
      })
      .catch((error) => {
        console.error("Timeline list failed", error);
        setAllTimelineTasks([]);
      });
  }, [timelineView, projects]);

  useEffect(() => {
    if (projects.length === 0) {
      setAllTimelineTasks([]);
      return;
    }
    window.edisconotes
      .listTimelineTasks()
      .then((items) => setAllTimelineTasks(items))
      .catch((error) => {
        console.error("Timeline summary load failed", error);
      });
  }, [projects.length]);

  useEffect(() => {
    if (!anyModalOpen) {
      const returnFocus = modalReturnFocusRef.current;
      modalReturnFocusRef.current = null;
      if (returnFocus) {
        requestAnimationFrame(() => returnFocus.focus());
      }
      return;
    }
    if (!modalReturnFocusRef.current) {
      modalReturnFocusRef.current = document.activeElement as HTMLElement | null;
    }
    requestAnimationFrame(() => {
      const modal = getTopModal();
      if (!modal) return;
      const focusables = getFocusableElements(modal);
      if (focusables.length > 0) {
        focusables[0].focus();
        return;
      }
      modal.setAttribute("tabindex", "-1");
      modal.focus();
    });
  }, [anyModalOpen]);

  useEffect(() => {
    if (!anyModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const modal = getTopModal();
        if (!modal) return;
        const focusables = getFocusableElements(modal);
        if (focusables.length === 0) {
          event.preventDefault();
          modal.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey) {
          if (active === first || !modal.contains(active)) {
            event.preventDefault();
            last.focus();
          }
          return;
        }
        if (active === last || !modal.contains(active)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key !== "Escape") return;
      if (previewOpen) {
        setPreviewOpen(false);
        return;
      }
      if (showOnboarding) {
        dismissOnboarding();
        return;
      }
      if (showShortcuts) {
        setShowShortcuts(false);
        return;
      }
      if (showSettings) {
        setShowSettings(false);
        return;
      }
      if (showArchiveConfirm) {
        setShowArchiveConfirm(false);
        return;
      }
      if (showProjectForm) {
        setShowProjectForm(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyModalOpen, dismissOnboarding, previewOpen, showArchiveConfirm, showOnboarding, showProjectForm, showSettings, showShortcuts]);

  useEffect(() => {
    if (!showProjectForm) return;
    requestAnimationFrame(() => projectMatterInputRef.current?.focus());
  }, [showProjectForm]);

  useEffect(() => {
    if (!showArchiveConfirm) return;
    requestAnimationFrame(() => archiveCancelButtonRef.current?.focus());
  }, [showArchiveConfirm]);

  useEffect(() => {
    setCopyRelativityStatus("idle");
  }, [selectedProjectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || Boolean(target?.isContentEditable);

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        quickSearchInputRef.current?.focus();
        quickSearchInputRef.current?.select();
        return;
      }

      if (!isTyping && event.key === "?") {
        event.preventDefault();
        setShowShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      flashTimersRef.current.forEach((timer) => clearTimeout(timer));
      flashTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    try {
      const seen = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
      if (!seen) {
        setOnboardingStep(0);
        setShowOnboarding(true);
      }
    } catch {
      setOnboardingStep(0);
      setShowOnboarding(true);
    }
  }, []);

  const resetForm = () => {
    setProjectForm(emptyForm);
    setEditingProjectId(null);
    setProjectFormMode("create");
  };

  const triggerFlash = (setter: React.Dispatch<React.SetStateAction<string | null>>, id: string) => {
    setter(id);
    const timer = setTimeout(() => setter(null), FLASH_MS);
    flashTimersRef.current.push(timer);
  };

  const closeProjectForm = () => {
    setShowProjectForm(false);
    resetForm();
  };

  const openOnboardingGuide = () => {
    setOnboardingStep(0);
    setShowOnboarding(true);
  };

  const openCreateProject = () => {
    resetForm();
    setProjectFormMode("create");
    setShowProjectForm(true);
  };

  const openEditProject = () => {
    if (!selectedProject) return;
    setProjectForm({
      matterName: selectedProject.matterName,
      clientName: selectedProject.clientName,
      billingCode: selectedProject.billingCode,
      startDate: formatIsoDate(selectedProject.startDate),
      productionDeadline: formatIsoDate(selectedProject.productionDeadline),
      relativityUrl: selectedProject.relativityUrl || ""
    });
    setEditingProjectId(selectedProject.id);
    setProjectFormMode("edit");
    setShowProjectForm(true);
  };

  const submitProjectForm = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: ProjectInput = {
      matterName: projectForm.matterName.trim(),
      clientName: projectForm.clientName.trim(),
      billingCode: projectForm.billingCode.trim(),
      startDate: projectForm.startDate,
      productionDeadline: projectForm.productionDeadline,
      relativityUrl: projectForm.relativityUrl.trim() || null
    };

    if (
      !payload.matterName ||
      !payload.clientName ||
      !payload.billingCode ||
      !payload.startDate ||
      !payload.productionDeadline
    ) {
      return;
    }

    if (projectFormMode === "create") {
      const created = await window.edisconotes.createProject(payload);
      setProjects((prev) => [created, ...prev]);
      setSelectedProjectId(created.id);
    } else if (editingProjectId) {
      const updated = await window.edisconotes.updateProject(editingProjectId, payload);
      setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
    }

    setShowProjectForm(false);
    resetForm();
    refreshSafetyData();
  };

  const archiveProject = async () => {
    if (!selectedProject) return;
    await window.edisconotes.archiveProject(selectedProject.id);
    const remaining = projects.filter((project) => project.id !== selectedProject.id);
    setProjects(remaining);
    setSelectedProjectId((prev) => (prev === selectedProject.id ? null : prev));
    if (showArchived) {
      window.edisconotes.listProjects(true).then((items) => {
        setArchivedProjects(items.filter((project) => project.archivedAt));
      });
    }
    refreshSafetyData();
  };

  const restoreProject = async (projectId: string) => {
    const restored = await window.edisconotes.restoreProject(projectId);
    if (!restored) return;
    setProjects((prev) => {
      const next = prev.filter((project) => project.id !== restored.id);
      return [restored, ...next];
    });
    setArchivedProjects((prev) => prev.filter((project) => project.id !== restored.id));
    setSelectedProjectId(restored.id);
    refreshSafetyData();
  };

  const openGlobalResult = (
    projectId: string,
    target: "project" | "note" | "todo" | "document",
    targetId?: string
  ) => {
    setSelectedProjectId(projectId);
    if (target === "note") {
      setActiveTab("Notes");
      if (targetId) {
        setPendingNoteSelectionId(targetId);
      }
      return;
    }
    if (target === "todo") {
      setActiveTab("To-Do");
      return;
    }
    if (target === "document") {
      setActiveTab("Documents");
      return;
    }
  };

  const previewAttachment = async (attachmentId: string) => {
    setPreviewAttachmentId(attachmentId);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewResult(null);
    try {
      const result = await window.edisconotes.previewAttachment(attachmentId);
      setPreviewResult(result);
    } catch (error) {
      console.error("Attachment preview failed", error);
      setPreviewResult({ ok: false, error: "Preview failed. Try opening the file directly." });
    } finally {
      setPreviewLoading(false);
    }
  };

  const exportBackup = async () => {
    setBackupActionMessage(null);
    setBackupActionStatus("working");
    try {
      const result = await window.edisconotes.exportBackup();
      if (result.ok) {
        setBackupActionStatus("done");
        setBackupActionMessage(`Backup created at ${result.backupPath}`);
        refreshSafetyData();
      } else if (!result.canceled) {
        setBackupActionStatus("error");
        setBackupActionMessage(result.error || "Backup export failed.");
      } else {
        setBackupActionStatus("idle");
      }
    } catch (error) {
      console.error("Backup export failed", error);
      setBackupActionStatus("error");
      setBackupActionMessage("Backup export failed.");
    }
  };

  const restoreBackup = async () => {
    const confirmed = window.confirm(
      "Restore will replace current local data and restart the app. Continue?"
    );
    if (!confirmed) return;
    setBackupActionMessage(null);
    setBackupActionStatus("working");
    try {
      const result = await window.edisconotes.restoreBackup();
      if (result.relaunching) {
        setBackupActionStatus("done");
        setBackupActionMessage("Restoring backup and restarting...");
        return;
      }
      if (!result.ok && !result.canceled) {
        setBackupActionStatus("error");
        setBackupActionMessage(result.error || "Backup restore failed.");
        return;
      }
      setBackupActionStatus("idle");
    } catch (error) {
      console.error("Backup restore failed", error);
      setBackupActionStatus("error");
      setBackupActionMessage("Backup restore failed.");
    }
  };

  const createRestorePoint = async () => {
    setSnapshotActionStatus("working");
    setSnapshotActionMessage(null);
    try {
      const result = await window.edisconotes.createBackupSnapshot("manual");
      if (result.ok && result.snapshot) {
        setSnapshotActionStatus("done");
        setSnapshotActionMessage(`Restore point created: ${formatDateTime(result.snapshot.createdAt)}`);
        refreshSafetyData();
      } else {
        setSnapshotActionStatus("error");
        setSnapshotActionMessage(result.error || "Failed to create restore point.");
      }
    } catch (error) {
      console.error("Snapshot creation failed", error);
      setSnapshotActionStatus("error");
      setSnapshotActionMessage("Failed to create restore point.");
    }
  };

  const restoreSnapshot = async (snapshotId: string) => {
    const confirmed = window.confirm("Restore point will replace current local data and restart the app. Continue?");
    if (!confirmed) return;
    setSnapshotActionStatus("working");
    setSnapshotActionMessage(null);
    try {
      const result = await window.edisconotes.restoreBackupSnapshot(snapshotId);
      if (result.relaunching) {
        setSnapshotActionStatus("done");
        setSnapshotActionMessage("Restoring from restore point and restarting...");
        return;
      }
      if (!result.ok && !result.canceled) {
        setSnapshotActionStatus("error");
        setSnapshotActionMessage(result.error || "Restore point restore failed.");
        return;
      }
      setSnapshotActionStatus("idle");
    } catch (error) {
      console.error("Snapshot restore failed", error);
      setSnapshotActionStatus("error");
      setSnapshotActionMessage("Restore point restore failed.");
    }
  };

  const exportProjectBundle = async () => {
    if (!selectedProject) return;
    setBundleActionStatus("working");
    setBundleActionMessage(null);
    try {
      const result = await window.edisconotes.exportProjectBundle(selectedProject.id);
      if (result.ok) {
        setBundleActionStatus("done");
        setBundleActionMessage(
          `Bundle exported (${result.notes || 0} notes, ${result.todos || 0} tasks, ${result.attachments || 0} files).`
        );
        refreshSafetyData();
      } else if (!result.canceled) {
        setBundleActionStatus("error");
        setBundleActionMessage(result.error || "Project bundle export failed.");
      } else {
        setBundleActionStatus("idle");
      }
    } catch (error) {
      console.error("Project bundle export failed", error);
      setBundleActionStatus("error");
      setBundleActionMessage("Project bundle export failed.");
    }
  };

  const importProjectBundle = async () => {
    setBundleActionStatus("working");
    setBundleActionMessage(null);
    try {
      const result = await window.edisconotes.importProjectBundle();
      if (result.ok && result.project) {
        const importedProject = result.project;
        setProjects((prev) => [importedProject, ...prev.filter((item) => item.id !== importedProject.id)]);
        setSelectedProjectId(importedProject.id);
        setBundleActionStatus("done");
        const counts = result.counts;
        setBundleActionMessage(
          `Project imported (${counts?.notes || 0} notes, ${counts?.todos || 0} tasks, ${counts?.attachments || 0} files).`
        );
        refreshSafetyData();
      } else if (!result.canceled) {
        setBundleActionStatus("error");
        setBundleActionMessage(result.error || "Project bundle import failed.");
      } else {
        setBundleActionStatus("idle");
      }
    } catch (error) {
      console.error("Project bundle import failed", error);
      setBundleActionStatus("error");
      setBundleActionMessage("Project bundle import failed.");
    }
  };

  const lockVaultNow = async () => {
    const confirmed = window.confirm("Lock vault now? You will need your passphrase to unlock.");
    if (!confirmed) return;
    setBackupActionStatus("working");
    setBackupActionMessage("Locking vault...");
    try {
      const ok = await window.edisconotes.vaultLock();
      if (ok) {
        window.location.reload();
      } else {
        setBackupActionStatus("error");
        setBackupActionMessage("Vault lock failed.");
      }
    } catch (error) {
      console.error("Vault lock failed", error);
      setBackupActionStatus("error");
      setBackupActionMessage("Vault lock failed.");
    }
  };

  const runAccessibilityAudit = () => {
    const controls = Array.from(document.querySelectorAll("button, input, select, textarea, a[href]"));
    const unlabeled = controls.filter((element) => {
      const node = element as HTMLElement;
      if (node.getAttribute("aria-hidden") === "true") return false;
      if (node instanceof HTMLInputElement && node.type === "hidden") return false;
      const ariaLabel = node.getAttribute("aria-label")?.trim() || "";
      if (ariaLabel) return false;
      if (node instanceof HTMLInputElement && node.labels && node.labels.length > 0) return false;
      if (node.closest("label")) return false;
      const text = node.textContent?.trim() || "";
      return text.length === 0;
    });

    const bodyStyle = getComputedStyle(document.body);
    const panel = (document.querySelector(".project-body, .timeline-summary-card, .data-safety-card, .main-panel") ||
      document.body) as HTMLElement;
    const panelStyle = getComputedStyle(panel);
    const panelBackground = resolveEffectiveBackground(panel);
    const textContrast = contrastRatio(panelStyle.color || bodyStyle.color, panelBackground);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const focusContrast = contrastRatio(accent || "#138a70", panelBackground);

    const checks = [
      {
        label: "ARIA labels on controls",
        pass: unlabeled.length === 0,
        detail: unlabeled.length === 0 ? "No unlabeled controls detected." : `${unlabeled.length} controls need labels.`
      },
      {
        label: "Text contrast",
        pass: Boolean(textContrast && textContrast >= 4.5),
        detail: textContrast ? `Contrast ratio ${textContrast.toFixed(2)}:1` : "Could not compute contrast ratio."
      },
      {
        label: "Focus ring contrast",
        pass: Boolean(focusContrast && focusContrast >= 3),
        detail: focusContrast ? `Contrast ratio ${focusContrast.toFixed(2)}:1` : "Could not compute focus ring contrast."
      }
    ];

    setA11yAuditResults(checks);
    setA11yAuditRunAt(new Date().toISOString());
    setA11yAuditOpen(true);
  };

  const createNote = async () => {
    if (!selectedProject) return;
    const today = new Date().toISOString().slice(0, 10);
    const newNote = await window.edisconotes.createNote(selectedProject.id, {
      title: buildNoteTitle(today),
      noteDate: today,
      contentMarkdown: ""
    });
    setNotes((prev) => [newNote, ...prev]);
    setSelectedNoteId(newNote.id);
    setActiveTab("Notes");
    triggerFlash(setNewNoteFlashId, newNote.id);
  };

  const insertHeading = () => {
    const headingIsActive = Boolean(findAncestorInEditor("h1, h2, h3, h4"));
    if (headingIsActive) {
      runRichCommand("formatBlock", "p");
      return;
    }
    runRichCommand("formatBlock", "h2");
    if (!getCommandState("bold")) {
      runRichCommand("bold");
    }
  };

  const insertBold = () => runRichCommand("bold");
  const insertItalic = () => runRichCommand("italic");
  const insertHighlight = () => {
    if (richToolState.highlight) {
      runRichCommand("hiliteColor", "transparent");
      return;
    }
    runRichCommand("hiliteColor", "#fff59d");
  };

  const insertQuote = () => {
    if (richToolState.quote) {
      runRichCommand("formatBlock", "p");
      return;
    }
    runRichCommand("formatBlock", "blockquote");
  };

  const insertBullet = () => runRichCommand("insertUnorderedList");

  const insertSubBullet = () => {
    const inList = Boolean(findAncestorInEditor("li"));
    if (!inList) {
      runRichCommand("insertUnorderedList");
    }
    runRichCommand("indent");
  };

  const insertDateStamp = () => {
    const today = new Date().toISOString().slice(0, 10);
    runRichCommand("insertText", `${today} `);
  };

  const applyTemplateToNote = (content: string, mode: "replace" | "append") => {
    if (!selectedNote) return;
    if (mode === "replace") {
      setNoteDraft(content);
      requestAnimationFrame(() => richEditorRef.current?.focus());
      return;
    }
    setNoteDraft((prev) => `${prev.trimEnd()}\n\n${content}`);
    requestAnimationFrame(() => richEditorRef.current?.focus());
  };

  const deleteNote = async (noteId: string) => {
    const note = notes.find((item) => item.id === noteId);
    if (!note) return;
    if (!window.confirm(`Delete note \"${note.title}\"?`)) return;

    await window.edisconotes.deleteNote(noteId);
    setNotes((prev) => {
      const next = prev.filter((item) => item.id !== noteId);
      if (selectedNoteId === noteId) {
        setSelectedNoteId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  const handleRichEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      runRichCommand(event.shiftKey ? "outdent" : "indent");
    }
  };

  const handleRichEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    const safeHtml = html ? sanitizeEditorHtml(html) : "";
    if (safeHtml) {
      document.execCommand("insertHTML", false, safeHtml);
    } else {
      document.execCommand("insertText", false, text);
    }
    syncRichEditorToDraft();
    refreshRichToolState();
  };

  const addTodo = async () => {
    if (!selectedProject || !todoText.trim()) return;
    const newTodo = await window.edisconotes.createTodo(selectedProject.id, {
      text: todoText.trim(),
      isCompleted: false,
      isPriority: todoPriority
    });
    setTodos((prev) => [...prev, newTodo]);
    setTodoText("");
    setTodoPriority(false);
    triggerFlash(setNewTodoFlashId, newTodo.id);
    refreshSafetyData();
  };

  const updateTodo = async (todo: Todo, updates: Partial<TodoInput>) => {
    const payload: TodoInput = {
      text: updates.text ?? todo.text,
      isCompleted: updates.isCompleted ?? isChecked(todo.isCompleted),
      isPriority: updates.isPriority ?? isChecked(todo.isPriority)
    };
    const updated = await window.edisconotes.updateTodo(todo.id, payload);
    setTodos((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    refreshSafetyData();
  };

  const deleteTodo = async (todoId: string) => {
    await window.edisconotes.deleteTodo(todoId);
    setTodos((prev) => prev.filter((todo) => todo.id !== todoId));
    refreshSafetyData();
  };

  const filteredTodos = useMemo(() => {
    const query = searchScope === "project" ? quickSearch.trim().toLowerCase() : "";
    let items = [...todos];
    if (todoFilter === "priority") {
      items = items.filter((todo) => isChecked(todo.isPriority));
    }
    if (query) {
      items = items.filter((todo) => includesQuery(query, todo.text));
    }
    items.sort((a, b) => {
      if (todoSort === "newest") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    return items;
  }, [searchScope, todos, todoFilter, todoSort, quickSearch]);

  const handleAddFiles = async (paths?: string[]) => {
    if (!selectedProject) return;
    const filePaths = paths && paths.length ? paths : await window.edisconotes.openFileDialog();
    if (!filePaths.length) return;
    const added = await window.edisconotes.addAttachments(selectedProject.id, filePaths);
    setAttachments((prev) => [...added, ...prev]);
    if (added.length > 0) {
      triggerFlash(setNewAttachmentFlashId, added[0].id);
      refreshSafetyData();
    }
  };

  const openAttachment = async (attachmentId: string) => {
    await window.edisconotes.openAttachment(attachmentId);
  };

  const revealAttachment = async (attachmentId: string) => {
    await window.edisconotes.revealAttachment(attachmentId);
  };

  const deleteAttachment = async (attachmentId: string) => {
    const item = attachments.find((attachment) => attachment.id === attachmentId);
    if (!item) return;
    if (!window.confirm(`Remove \"${item.originalFileName}\" from this project?`)) return;
    await window.edisconotes.deleteAttachment(attachmentId);
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
    refreshSafetyData();
  };

  const runExport = async (
    setter: React.Dispatch<React.SetStateAction<ExportStatus>>,
    handler: () => Promise<{ ok: boolean; canceled?: boolean }>
  ) => {
    setter("working");
    const result = await handler();
    if (result?.ok) {
      setter("done");
      refreshSafetyData();
      setTimeout(() => setter("idle"), 1500);
      return;
    }
    if (!result?.canceled) {
      setter("error");
      setTimeout(() => setter("idle"), 2000);
      return;
    }
    setter("idle");
  };

  const exportNotesWord = async () => {
    if (!selectedProject) return;
    await runExport(setWordExportStatus, () => window.edisconotes.exportNotesDocx(selectedProject.id));
  };

  const exportNotesPdf = async () => {
    if (!selectedProject) return;
    await runExport(setPdfExportStatus, () => window.edisconotes.exportNotesPdf(selectedProject.id));
  };

  const exportNotesMarkdown = async () => {
    if (!selectedProject) return;
    await runExport(setMarkdownExportStatus, () => window.edisconotes.exportNotesMarkdown(selectedProject.id));
  };

  const copyRelativityUrl = async () => {
    const value = selectedProject?.relativityUrl?.trim();
    if (!value) return;
    try {
      await copyToClipboard(value);
      setCopyRelativityStatus("done");
      setTimeout(() => setCopyRelativityStatus("idle"), 1500);
    } catch (error) {
      console.error("Failed to copy URL", error);
      setCopyRelativityStatus("error");
      setTimeout(() => setCopyRelativityStatus("idle"), 2000);
    }
  };

  const openRelativityUrl = async () => {
    const value = selectedProject?.relativityUrl?.trim();
    if (!value) return;
    const ok = await window.edisconotes.openExternalUrl(value);
    if (!ok) {
      setCopyRelativityStatus("error");
      setTimeout(() => setCopyRelativityStatus("idle"), 2000);
    }
  };

  const handleDropFiles = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOverDocs(false);
    if (!event.dataTransfer?.files?.length) return;
    const filePaths = Array.from(event.dataTransfer.files).map((file) => (file as File & { path: string }).path);
    await handleAddFiles(filePaths);
  };

  const ganttRows = useMemo(() => {
    if (timelineView === "project") {
      return TIMELINE_PHASES.map((phase) => {
        const value = timelineValues[phase.key] || { startDate: "", endDate: "" };
        return {
          id: `${selectedProjectId ?? "project"}-${phase.key}`,
          label: phase.label,
          startDate: value.startDate,
          endDate: value.endDate,
          milestoneDate: phase.isMilestone ? value.startDate : undefined,
          isProjectCompletion: phase.key === "Project Completion",
          color: PHASE_COLOR_MAP[phase.key] || PROJECT_COLOR_PALETTE[0]
        } satisfies GanttRow;
      });
    }
    return [];
  }, [timelineView, timelineValues, selectedProjectId]);

  const orderedProjects = useMemo(() => {
    const pinned = projects.filter((project) => isChecked(project.isPinned ?? false));
    const others = projects.filter((project) => !isChecked(project.isPinned ?? false));
    return [...pinned, ...others];
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return orderedProjects;
    return orderedProjects.filter((project) => {
      const haystack = [
        project.matterName,
        project.clientName,
        project.billingCode,
        project.relativityUrl || ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [orderedProjects, projectSearch]);

  const quickQuery = useMemo(
    () => (searchScope === "project" ? quickSearch.trim().toLowerCase() : ""),
    [quickSearch, searchScope]
  );

  const filteredNotes = useMemo(() => {
    if (!quickQuery) return notes;
    return notes.filter((note) =>
      includesQuery(quickQuery, note.title, note.contentMarkdown, note.noteDate)
    );
  }, [notes, quickQuery]);

  useEffect(() => {
    if (!quickQuery || filteredNotes.length === 0) return;
    if (!selectedNoteId || !filteredNotes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(filteredNotes[0].id);
    }
  }, [filteredNotes, quickQuery, selectedNoteId]);

  const filteredAttachments = useMemo(() => {
    if (!quickQuery) return attachments;
    return attachments.filter((attachment) =>
      includesQuery(quickQuery, attachment.originalFileName, attachment.addedAt)
    );
  }, [attachments, quickQuery]);

  const quickHitCounts = useMemo(() => {
    if (!quickQuery || searchScope !== "project") {
      return null;
    }
    return {
      notes: filteredNotes.length,
      todos: todos.filter((todo) => includesQuery(quickQuery, todo.text)).length,
      documents: filteredAttachments.length
    };
  }, [filteredAttachments.length, filteredNotes.length, quickQuery, searchScope, todos]);

  const projectInsights = useMemo(() => {
    const completedTodos = todos.filter((todo) => isChecked(todo.isCompleted)).length;
    const openTodos = todos.length - completedTodos;
    const priorityOpenTodos = todos.filter((todo) => isChecked(todo.isPriority) && !isChecked(todo.isCompleted)).length;
    const totalAttachmentBytes = attachments.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
    return {
      notesCount: notes.length,
      openTodos,
      completedTodos,
      priorityOpenTodos,
      attachmentCount: attachments.length,
      totalAttachmentBytes
    };
  }, [attachments, notes.length, todos]);

  const noteSections = useMemo(() => {
    const sections: Array<{ label: string; offset: number }> = [];
    if (!noteDraft.trim()) return sections;
    const lines = noteDraft.split("\n");
    let offset = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      const isHeading = /^#{1,4}\s+/.test(trimmed);
      const isSectionTitle = /^[A-Za-z][A-Za-z0-9/&()\- ]{2,80}$/.test(trimmed) && !/^[-*•]\s+/.test(trimmed);
      if (isHeading || isSectionTitle) {
        sections.push({
          label: trimmed.replace(/^#{1,4}\s+/, ""),
          offset
        });
      }
      offset += line.length + 1;
    }
    return sections.slice(0, 24);
  }, [noteDraft]);

  const jumpToSection = (offset: number) => {
    const editor = richEditorRef.current;
    if (!editor) return;
    editor.focus();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const target = Math.max(0, offset);
    let remaining = target;
    let node = walker.nextNode() as Text | null;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    while (node) {
      const length = node.textContent?.length || 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode() as Text | null;
    }
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const onboardingChecklist = useMemo(() => {
    const hasProject = projects.length > 0;
    const hasNote = notes.length > 0;
    const hasTodo = todos.length > 0;
    const hasDocument = attachments.length > 0;
    const hasTimeline = Object.values(timelineValues).some((value) => Boolean(value.startDate || value.endDate));
    return [
      { label: "Create your first project", done: hasProject },
      { label: "Capture your first note", done: hasNote },
      { label: "Add at least one task", done: hasTodo },
      { label: "Attach one project file", done: hasDocument },
      { label: "Set a timeline date", done: hasTimeline }
    ];
  }, [attachments.length, notes.length, projects.length, timelineValues, todos.length]);

  const onboardingStepCount = 4;
  const onboardingIsLastStep = onboardingStep >= onboardingStepCount - 1;

  const globalSearchHasHits = useMemo(() => {
    if (!globalSearch) return false;
    return (
      globalSearch.projects.length > 0 ||
      globalSearch.notes.length > 0 ||
      globalSearch.todos.length > 0 ||
      globalSearch.attachments.length > 0
    );
  }, [globalSearch]);

  const ganttRowsByProject = useMemo(() => {
    const taskMap = new Map<string, TimelineTask>();
    allTimelineTasks.forEach((task) => taskMap.set(`${task.projectId}:${task.phase}`, task));
    return orderedProjects.map((project) => {
      const color = projectColorForId(project.id, PROJECT_COLOR_PALETTE);
      const rows = TIMELINE_PHASES.map((phase) => {
        const task = taskMap.get(`${project.id}:${phase.key}`);
        return {
          id: `${project.id}-${phase.key}`,
          label: phase.label,
          startDate: formatIsoDate(task?.startDate),
          endDate: formatIsoDate(task?.endDate),
          milestoneDate: phase.isMilestone ? formatIsoDate(task?.startDate) : undefined,
          isProjectCompletion: phase.key === "Project Completion",
          color
        } satisfies GanttRow;
      });
      return { project, rows };
    });
  }, [allTimelineTasks, orderedProjects]);

  const updateTimelineCache = (
    items: TimelineTask[],
    updated: TimelineTask | null,
    projectId: string,
    phase: string
  ) => {
    const filtered = items.filter((item) => !(item.projectId === projectId && item.phase === phase));
    if (!updated) {
      return filtered;
    }
    return [updated, ...filtered];
  };

  const handleTimelineChange = (phaseKey: string, field: "startDate" | "endDate", value: string) => {
    if (!selectedProject) return;
    const phase = TIMELINE_PHASES.find((item) => item.key === phaseKey);
    if (phase?.isMilestone && field === "endDate") {
      return;
    }
    const projectId = selectedProject.id;
    setTimelineValues((prev) => {
      const current = prev[phaseKey] || { startDate: "", endDate: "" };
      const nextValue = phase?.isMilestone
        ? { ...current, startDate: value, endDate: "" }
        : { ...current, [field]: value };
      const next = { ...prev, [phaseKey]: nextValue };
      const nextErrors = buildTimelineErrors(next);
      setTimelineErrors(nextErrors);

      const startDate = nextValue.startDate ? nextValue.startDate : null;
      const endDate = phase?.isMilestone ? null : nextValue.endDate ? nextValue.endDate : null;
      if (startDate && endDate && !isValidRange(startDate, endDate)) {
        return next;
      }

      window.edisconotes
        .upsertTimelineTask(projectId, {
          phase: phaseKey,
          startDate,
          endDate
        })
        .then((updated) => {
          setAllTimelineTasks((items) => updateTimelineCache(items, updated, projectId, phaseKey));
          return window.edisconotes.listTimelineTasks(projectId);
        })
        .then((items) => {
          const nextValues = buildTimelineValues(items);
          setTimelineValues(nextValues);
          setTimelineErrors(buildTimelineErrors(nextValues));
          refreshSafetyData();
        })
        .catch((error) => {
          console.error("Timeline update failed", error);
        });

      return next;
    });
  };

  const toggleProjectPin = async (project: Project) => {
    const nextPinned = !isChecked(project.isPinned ?? false);
    const updated = await window.edisconotes.pinProject(project.id, nextPinned);
    setProjects((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    refreshSafetyData();
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = tabs.indexOf(activeTab);
    if (currentIndex < 0) return;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActiveTab(tabs[(currentIndex + 1) % tabs.length]);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveTab(tabs[(currentIndex - 1 + tabs.length) % tabs.length]);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveTab(tabs[0]);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveTab(tabs[tabs.length - 1]);
    }
  };

  const noteSaveMessage =
    noteSaveStatus === "saving"
      ? "Saving..."
      : noteSaveStatus === "saved"
        ? "Saved"
        : noteSaveStatus === "error"
          ? "Autosave failed. Keep this window open and try again."
          : "Auto-saves within a second.";

  const noteSaveTone = noteSaveStatus === "error" ? "save-error" : noteSaveStatus === "saved" ? "save-done" : "";

  const wordExportLabel =
    wordExportStatus === "working"
      ? "Exporting..."
      : wordExportStatus === "done"
        ? "Exported"
        : wordExportStatus === "error"
          ? "Export Failed"
          : "Export Word";

  const pdfExportLabel =
    pdfExportStatus === "working"
      ? "Exporting..."
      : pdfExportStatus === "done"
        ? "Exported"
        : pdfExportStatus === "error"
          ? "Export Failed"
          : "Export PDF";

  const markdownExportLabel =
    markdownExportStatus === "working"
      ? "Exporting..."
      : markdownExportStatus === "done"
        ? "Exported"
        : markdownExportStatus === "error"
          ? "Export Failed"
          : "Export MD";

  const projectEmpty = !projects.length;

  return (
    <div className="app-shell">
      <main className="main-panel">
        <header className="main-header">
          <div>
            <p className="kicker">eDisco Pro Notes</p>
            <h1>{selectedProject ? selectedProject.matterName : "Home"}</h1>
            {selectedProject ? (
              <p className="subline">
                {selectedProject.clientName} · Billing {selectedProject.billingCode} · Deadline {formatDate(selectedProject.productionDeadline)}
              </p>
            ) : (
              <p className="subline">
                Cross-project deadline and data safety overview.
              </p>
            )}
          </div>
          <div className="header-actions">
            {selectedProject && (
              <button className="ghost" onClick={goHomeDashboard}>Home</button>
            )}
            <button className="ghost" onClick={() => setShowSettings(true)}>Settings</button>
            <button className="ghost" onClick={openOnboardingGuide}>Guide</button>
            {selectedProject && (
              <>
                <button className="ghost" onClick={() => setShowSidebar((prev) => !prev)}>
                  {showSidebar ? "Hide Projects" : "Show Projects"}
                </button>
                <button className="ghost" onClick={openEditProject}>Edit Project</button>
                <button className="primary" onClick={createNote}>New Note</button>
              </>
            )}
          </div>
        </header>

        {selectedProject?.relativityUrl && (
          <div className="workspace-row">
            <span className="workspace-label">Relativity Workspace</span>
            <span className="workspace-url">{selectedProject.relativityUrl}</span>
            <div className="workspace-actions">
              <button type="button" className="ghost" onClick={copyRelativityUrl}>
                {copyRelativityStatus === "done" ? "Copied" : "Copy URL"}
              </button>
              <button type="button" className="ghost" onClick={openRelativityUrl}>Open in Browser</button>
            </div>
          </div>
        )}

        {selectedProject && (
          <div className="workspace-tools">
            <label className="quick-search-field">
              <span className="quick-search-label">Quick Find</span>
              <input
                ref={quickSearchInputRef}
                className="quick-search-input"
                value={quickSearch}
                onChange={(event) => setQuickSearch(event.target.value)}
                placeholder="Search notes, to-dos, and documents"
                aria-label="Quick find across notes, to-dos, and documents"
              />
            </label>
            <div className="quick-scope-toggle" role="group" aria-label="Quick find scope">
              <button
                type="button"
                className={searchScope === "project" ? "chip active" : "chip"}
                onClick={() => setSearchScope("project")}
              >
                This Project
              </button>
              <button
                type="button"
                className={searchScope === "global" ? "chip active" : "chip"}
                onClick={() => setSearchScope("global")}
              >
                All Projects
              </button>
            </div>
            <div className="workspace-tools-actions">
              {quickHitCounts ? (
                <span className="quick-search-meta">
                  {quickHitCounts.notes} notes · {quickHitCounts.todos} tasks · {quickHitCounts.documents} docs
                </span>
              ) : globalSearchLoading ? (
                <span className="quick-search-meta">Searching all projects…</span>
              ) : (
                <span className="quick-search-meta">Tip: Ctrl/Cmd + K</span>
              )}
              {quickSearch && (
                <button type="button" className="ghost" onClick={() => setQuickSearch("")}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className="ghost"
                onClick={runAccessibilityAudit}
                title="Run a quick accessibility check for labels, text contrast, and focus visibility."
                aria-label="Run accessibility quick check"
              >
                Accessibility Check
              </button>
              <button type="button" className="ghost" onClick={() => setShowShortcuts(true)}>
                Shortcuts
              </button>
            </div>
          </div>
        )}

        {selectedProject && searchScope === "global" && quickSearch.trim() && (
          <section className="global-search-panel" aria-live="polite" aria-label="Global search results">
            {!globalSearchLoading && globalSearch && !globalSearchHasHits && (
              <p className="muted">No matches found across projects.</p>
            )}
            {globalSearch?.projects.length ? (
              <div className="global-search-group">
                <h4>Projects</h4>
                <div className="global-search-items">
                  {globalSearch.projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="global-search-item"
                      onClick={() => openGlobalResult(project.id, "project")}
                    >
                      <strong>{project.matterName}</strong>
                      <span>{project.clientName} · {project.billingCode}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {globalSearch?.notes.length ? (
              <div className="global-search-group">
                <h4>Notes</h4>
                <div className="global-search-items">
                  {globalSearch.notes.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      className="global-search-item"
                      onClick={() => openGlobalResult(note.projectId, "note", note.id)}
                    >
                      <strong>{note.projectName} · {note.title}</strong>
                      <span>{note.snippet || formatDate(note.noteDate)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {globalSearch?.todos.length ? (
              <div className="global-search-group">
                <h4>To-Dos</h4>
                <div className="global-search-items">
                  {globalSearch.todos.map((todo) => (
                    <button
                      key={todo.id}
                      type="button"
                      className="global-search-item"
                      onClick={() => openGlobalResult(todo.projectId, "todo")}
                    >
                      <strong>{todo.projectName}</strong>
                      <span>{todo.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {globalSearch?.attachments.length ? (
              <div className="global-search-group">
                <h4>Documents</h4>
                <div className="global-search-items">
                  {globalSearch.attachments.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="global-search-item"
                      onClick={() => openGlobalResult(file.projectId, "document")}
                    >
                      <strong>{file.projectName} · {file.originalFileName}</strong>
                      <span>{formatBytes(file.sizeBytes)} · {formatDate(file.addedAt)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        )}

        {selectedProject && (
          <section className="insight-grid" aria-label="Project insights">
            <article className="insight-card">
              <span className="insight-label">Notes</span>
              <strong className="insight-value">{projectInsights.notesCount}</strong>
              <p className="insight-sub">Structured updates captured</p>
            </article>
            <article className="insight-card">
              <span className="insight-label">Open Tasks</span>
              <strong className="insight-value">{projectInsights.openTodos}</strong>
              <p className="insight-sub">
                {projectInsights.priorityOpenTodos} priority · {projectInsights.completedTodos} completed
              </p>
            </article>
            <article className="insight-card">
              <span className="insight-label">Documents</span>
              <strong className="insight-value">{projectInsights.attachmentCount}</strong>
              <p className="insight-sub">{formatBytes(projectInsights.totalAttachmentBytes)} attached</p>
            </article>
          </section>
        )}

        {!selectedProject && (
          <section className="timeline-summary-card deadline-dashboard-card" aria-label="Deadline dashboard">
            <div className="timeline-summary-head">
              <div>
                <h3>Deadline Dashboard</h3>
                <p className="muted">Upcoming and overdue phase dates with cross-project task rollups.</p>
              </div>
              <div className="timeline-summary-actions">
                <button type="button" className="ghost dashboard-refresh" onClick={refreshDashboardNow} disabled={dashboardRefreshing}>
                  {dashboardRefreshing ? "Refreshing…" : "Refresh"}
                </button>
                <div className="timeline-summary-badges">
                  <span className="deadline-chip dashboard-chip late">Overdue {deadlineDashboard?.totals.overdueTimeline || 0}</span>
                  <span className="deadline-chip dashboard-chip soon">Due 7d {deadlineDashboard?.totals.dueWithin7Days || 0}</span>
                  <span className="deadline-chip dashboard-chip normal">Open tasks {deadlineDashboard?.totals.openTodos || 0}</span>
                </div>
              </div>
            </div>
            {!deadlineDashboard ? (
              <p className="muted">Loading dashboard…</p>
            ) : (
              <div className="deadline-dashboard-grid">
                <div className="deadline-dashboard-column">
                  <h4>Timeline Risk Queue</h4>
                  {deadlineDashboard.overdueTimeline.length === 0 && deadlineDashboard.upcomingTimeline.length === 0 ? (
                    <p className="muted">No tracked timeline deadlines yet.</p>
                  ) : (
                    <div className="timeline-summary-list">
                      {[...deadlineDashboard.overdueTimeline, ...deadlineDashboard.upcomingTimeline.slice(0, 6)].map((item) => (
                        <div key={item.id} className="timeline-summary-row">
                          <div>
                            <p className="timeline-summary-project">{item.projectName}</p>
                            <p className="muted">{item.phase}</p>
                          </div>
                          <div className={`timeline-summary-due ${item.tone}`}>
                            <strong>{formatDate(item.dueDate)}</strong>
                            <span>{formatDaysLabel(item.daysFromNow)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="deadline-dashboard-column">
                  <h4>To-Do Rollups</h4>
                  {deadlineDashboard.todoRollups.length === 0 ? (
                    <p className="muted">No project tasks yet.</p>
                  ) : (
                    <div className="todo-rollup-list">
                      {deadlineDashboard.todoRollups.slice(0, 8).map((row) => (
                        <button
                          key={row.projectId}
                          type="button"
                          className="todo-rollup-row"
                          onClick={() => openProjectTodoRollup(row.projectId)}
                        >
                          <div>
                            <strong>{row.projectName}</strong>
                            <p className="muted">
                              Open {row.openTodos} · Priority {row.priorityOpenTodos} · Completed {row.completedTodos}
                            </p>
                          </div>
                          <span
                            className={
                              row.daysToDeadline !== null && row.daysToDeadline < 0
                                ? "deadline-chip dashboard-chip late"
                                : "deadline-chip dashboard-chip normal"
                            }
                          >
                            {formatDaysLabel(row.daysToDeadline)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {!selectedProject && (
          <section className="data-safety-card collapsible" aria-label="Backup and encryption status">
            <div className="data-safety-head">
              <div>
                <h3>Data Safety</h3>
                <p className="muted">
                  Local-only storage · Encryption {backupStatus?.hasEncryptedDb ? "enabled" : "pending"}
                </p>
              </div>
              <button
                type="button"
                className="ghost"
                aria-expanded={dataSafetyExpanded}
                aria-controls="data-safety-body"
                onClick={() => setDataSafetyExpanded((prev) => !prev)}
              >
                {dataSafetyExpanded ? "Hide Data Safety" : "Show Data Safety"}
              </button>
            </div>
            {dataSafetyExpanded && (
              <div id="data-safety-body" className="data-safety-body">
                <div className="data-safety-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={lockVaultNow}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    Lock Vault
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={exportBackup}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    {backupActionStatus === "working" ? "Working..." : "Export Backup"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={restoreBackup}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    Restore Backup
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={createRestorePoint}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    {snapshotActionStatus === "working" ? "Working..." : "Create Restore Point"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={exportProjectBundle}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    Export Project Bundle
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={importProjectBundle}
                    disabled={backupActionStatus === "working" || snapshotActionStatus === "working" || bundleActionStatus === "working"}
                  >
                    {bundleActionStatus === "working" ? "Working..." : "Import Project Bundle"}
                  </button>
                </div>
                <div className="data-safety-grid">
                  <p className="muted">
                    Last save: {backupStatus?.dbLastModifiedAt ? formatDateTime(backupStatus.dbLastModifiedAt) : "Unknown"}
                  </p>
                  <p className="muted">
                    Last backup: {backupStatus?.lastBackupAt ? formatDateTime(backupStatus.lastBackupAt) : "Not created yet"}
                  </p>
                  <p className="muted">
                    Last restore: {backupStatus?.lastRestoreAt ? formatDateTime(backupStatus.lastRestoreAt) : "No restore yet"}
                  </p>
                  <p className="muted">Storage: {backupStatus?.dbPath || "Vault file unavailable"}</p>
                </div>
                {backupActionMessage && (
                  <p className="muted" aria-live="polite">
                    {backupActionMessage}
                  </p>
                )}
                {snapshotActionMessage && (
                  <p className="muted" aria-live="polite">
                    {snapshotActionMessage}
                  </p>
                )}
                {bundleActionMessage && (
                  <p className="muted" aria-live="polite">
                    {bundleActionMessage}
                  </p>
                )}
                <div className="snapshot-panel">
                  <div className="a11y-audit-head">
                    <strong>Restore Points</strong>
                    <span className="muted">{snapshotItems.length} saved</span>
                  </div>
                  {snapshotItems.length === 0 ? (
                    <p className="muted">No restore points yet.</p>
                  ) : (
                    <div className="snapshot-list">
                      {snapshotItems.slice(0, 6).map((snapshot) => (
                        <div key={snapshot.id} className="snapshot-row">
                          <div>
                            <strong>{formatDateTime(snapshot.createdAt)}</strong>
                            <p className="muted">
                              {snapshot.reason} · {snapshot.attachmentFiles} files · {snapshot.encryptedDatabase ? "encrypted DB" : "plaintext DB"}
                            </p>
                          </div>
                          <button type="button" className="ghost" onClick={() => restoreSnapshot(snapshot.id)}>
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="audit-log-panel">
                  <div className="a11y-audit-head">
                    <strong>Audit Log</strong>
                    <span className="muted">Latest activity</span>
                  </div>
                  {auditLogItems.length === 0 ? (
                    <p className="muted">No audit events captured yet.</p>
                  ) : (
                    <div className="audit-log-list">
                      {auditLogItems.slice(0, 12).map((entry) => (
                        <div key={entry.id} className="audit-log-row">
                          <p>
                            <strong>{formatAuditAction(entry.action)}</strong>
                            {entry.projectId && (
                              <span className="muted"> · {projectNameLookup.get(entry.projectId) || entry.projectId}</span>
                            )}
                          </p>
                          <span className="muted">{formatDateTime(entry.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {a11yAuditOpen && (
                  <div className="a11y-audit-panel">
                    <div className="a11y-audit-head">
                      <strong>Accessibility Quick Check</strong>
                      <span className="muted">{a11yAuditRunAt ? formatDateTime(a11yAuditRunAt) : ""}</span>
                    </div>
                    <p className="a11y-audit-note">
                      Checks this screen for unlabeled controls, text contrast, and focus-ring contrast. Use this as a quick pass, not a full compliance audit.
                    </p>
                    {a11yAuditResults.map((item) => (
                      <p key={item.label} className={item.pass ? "a11y-audit-result pass" : "a11y-audit-result fail"}>
                        <strong>{item.pass ? "Pass" : "Needs work"}</strong> · {item.label}: {item.detail}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {!selectedProject && projectEmpty && (
          <section className="empty-state">
            <div>
              <h2>No Projects Yet</h2>
              <p>Create your first project to start capturing notes, timelines, tasks, and documents.</p>
              <button className="primary" onClick={openCreateProject}>Add Project</button>
            </div>
          </section>
        )}

        {selectedProject && (
          <section className="project-body">
            <div className="tab-strip" role="tablist" aria-label="Project sections" onKeyDown={onTabKeyDown}>
              {tabs.map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  id={tabId(tab)}
                  aria-controls={tabPanelId(tab)}
                  aria-selected={tab === activeTab}
                  tabIndex={tab === activeTab ? 0 : -1}
                  className={tab === activeTab ? "tab active" : "tab"}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === "Notes" && (
              <div role="tabpanel" id={tabPanelId("Notes")} aria-labelledby={tabId("Notes")} className="notes-layout">
                <aside className="notes-list">
                  <div className="notes-list-header">
                    <h3>Notes</h3>
                    <div className="notes-actions">
                      <button className="ghost notes-action notes-action-primary" onClick={createNote}>+ New</button>
                      <button
                        className="ghost notes-action"
                        onClick={exportNotesWord}
                        disabled={wordExportStatus === "working"}
                      >
                        {wordExportLabel}
                      </button>
                      <button
                        className="ghost notes-action"
                        onClick={exportNotesPdf}
                        disabled={pdfExportStatus === "working"}
                      >
                        {pdfExportLabel}
                      </button>
                      <button
                        className="ghost notes-action"
                        onClick={exportNotesMarkdown}
                        disabled={markdownExportStatus === "working"}
                      >
                        {markdownExportLabel}
                      </button>
                    </div>
                  </div>
                  {notes.length === 0 && (
                    <p className="muted">No notes yet. Create your first workflow note.</p>
                  )}
                  {notes.length > 0 && filteredNotes.length === 0 && (
                    <div className="inline-empty">
                      <p className="muted">No notes match your quick search.</p>
                      <button type="button" className="ghost" onClick={() => setQuickSearch("")}>Clear search</button>
                    </div>
                  )}
                  <div className="notes-items">
                    {filteredNotes.map((note) => (
                      <div key={note.id} className="note-card-row">
                        <button
                          className={[
                            "note-card",
                            note.id === selectedNoteId ? "active" : "",
                            note.id === newNoteFlashId ? "recent" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => setSelectedNoteId(note.id)}
                        >
                          <span className="note-title">{note.title}</span>
                          <span className="note-date">{formatDate(note.noteDate)}</span>
                        </button>
                        <button className="ghost note-delete" onClick={() => deleteNote(note.id)}>
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </aside>

                <div className="note-editor">
                  {selectedNote ? (
                    <>
                      <div className="note-editor-head">
                        <input
                          className="note-title-input"
                          value={noteTitle}
                          onChange={(event) => setNoteTitle(event.target.value)}
                          placeholder="Note title"
                        />
                        <button type="button" className="ghost" onClick={() => setShowTemplatePanel((prev) => !prev)}>
                          {showTemplatePanel ? "Hide Templates" : "Templates"}
                        </button>
                        <button className="ghost danger" onClick={() => deleteNote(selectedNote.id)}>
                          Delete Note
                        </button>
                      </div>
                      <div className="note-toolbar">
                        <button
                          type="button"
                          className={richToolState.header ? "ghost active" : "ghost"}
                          onClick={insertHeading}
                          aria-label="Toggle heading"
                        >
                          Header
                        </button>
                        <button
                          type="button"
                          className={richToolState.bold ? "ghost active" : "ghost"}
                          onClick={insertBold}
                          aria-label="Bold"
                        >
                          B
                        </button>
                        <button
                          type="button"
                          className={richToolState.italic ? "ghost active" : "ghost"}
                          onClick={insertItalic}
                          aria-label="Italic"
                        >
                          I
                        </button>
                        <button
                          type="button"
                          className={richToolState.highlight ? "ghost active" : "ghost"}
                          onClick={insertHighlight}
                          aria-label="Highlight"
                        >
                          HL
                        </button>
                        <button
                          type="button"
                          className={richToolState.quote ? "ghost active" : "ghost"}
                          onClick={insertQuote}
                        >
                          Quote
                        </button>
                        <button
                          type="button"
                          className={richToolState.bullet ? "ghost active" : "ghost"}
                          onClick={insertBullet}
                        >
                          Bullet
                        </button>
                        <button
                          type="button"
                          className={richToolState.subBullet ? "ghost active" : "ghost"}
                          onClick={insertSubBullet}
                        >
                          Sub-bullet
                        </button>
                        <button type="button" className="ghost" onClick={insertDateStamp}>Date Stamp</button>
                        <select
                          aria-label="Jump to note section"
                          defaultValue=""
                          onChange={(event) => {
                            const offset = Number(event.target.value);
                            if (!Number.isNaN(offset)) {
                              jumpToSection(offset);
                            }
                            event.currentTarget.value = "";
                          }}
                        >
                          <option value="">Jump to section</option>
                          {noteSections.map((section) => (
                            <option key={`${section.offset}-${section.label}`} value={section.offset}>
                              {section.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {showTemplatePanel && (
                        <div className="template-panel">
                          {NOTE_TEMPLATES.map((template) => (
                            <article key={template.id} className="template-card">
                              <div>
                                <h4>{template.label}</h4>
                                <p className="muted">{template.description}</p>
                              </div>
                              <div className="template-actions">
                                <button type="button" className="ghost" onClick={() => applyTemplateToNote(template.content, "append")}>
                                  Append
                                </button>
                                <button type="button" className="ghost" onClick={() => applyTemplateToNote(template.content, "replace")}>
                                  Replace
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                      <div className="note-compose">
                        <div
                          ref={richEditorRef}
                          className="note-editor-surface"
                          contentEditable
                          suppressContentEditableWarning
                          role="textbox"
                          aria-multiline="true"
                          aria-label="Rich text note editor"
                          onInput={syncRichEditorToDraft}
                          onBlur={syncRichEditorToDraft}
                          onKeyDown={handleRichEditorKeyDown}
                          onPaste={handleRichEditorPaste}
                        />
                      </div>
                      <p className={`muted ${noteSaveTone}`} aria-live="polite">{noteSaveMessage}</p>
                    </>
                  ) : (
                    <div className="empty-panel">
                      <h3>Choose a note</h3>
                      <p>Create a new note to capture today’s workflow updates.</p>
                      <button className="primary" onClick={createNote}>New Note</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "Timelines" && (
              <div role="tabpanel" id={tabPanelId("Timelines")} aria-labelledby={tabId("Timelines")} className="timeline-placeholder">
                <div className="timeline-toolbar">
                  <div>
                    <h3>Timelines</h3>
                    <p className="muted">Track each phase with dates and visualize progress below.</p>
                  </div>
                  <div className="timeline-view-toggle" role="group" aria-label="Timeline view">
                    <button
                      type="button"
                      className={`chip ${timelineView === "project" ? "active" : ""}`}
                      onClick={() => setTimelineView("project")}
                    >
                      This Project
                    </button>
                    <button
                      type="button"
                      className={`chip ${timelineView === "all" ? "active" : ""}`}
                      onClick={() => setTimelineView("all")}
                    >
                      All Projects
                    </button>
                  </div>
                </div>
                <div className="timeline-shell">
                  <TimelinePanel
                    phases={TIMELINE_PHASES}
                    values={timelineValues}
                    errors={timelineErrors}
                    onChange={handleTimelineChange}
                  />
                </div>
                {timelineView === "project" ? (
                  <div className="gantt-shell">
                    <div className="gantt-stage">
                      <GanttChart rows={ganttRows} emptyState="Add start and end dates above to generate a Gantt view." />
                    </div>
                  </div>
                ) : (
                  <div className="gantt-stack">
                    {ganttRowsByProject.map(({ project, rows }) => (
                      <div key={project.id} className="gantt-shell">
                        <div className="gantt-title">{project.matterName}</div>
                        <div className="gantt-stage">
                          <GanttChart rows={rows} emptyState="Add start and end dates above to generate a Gantt view." />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === "To-Do" && (
              <div role="tabpanel" id={tabPanelId("To-Do")} aria-labelledby={tabId("To-Do")} className="todo-panel">
                <div className="todo-controls">
                  <div className="todo-add">
                    <input
                      value={todoText}
                      onChange={(event) => setTodoText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addTodo();
                        }
                      }}
                      placeholder="Add a task"
                    />
                    <div className="todo-add-actions">
                      <button
                        type="button"
                        className={todoPriority ? "chip active" : "chip"}
                        aria-pressed={todoPriority}
                        onClick={() => setTodoPriority((prev) => !prev)}
                      >
                        Priority
                      </button>
                      <button className="primary" onClick={addTodo}>Add</button>
                    </div>
                  </div>
                  <div className="todo-filters">
                    <select value={todoSort} onChange={(event) => setTodoSort(event.target.value as "oldest" | "newest")}>
                      <option value="oldest">Oldest first</option>
                      <option value="newest">Newest first</option>
                    </select>
                    <select value={todoFilter} onChange={(event) => setTodoFilter(event.target.value as "all" | "priority")}>
                      <option value="all">All</option>
                      <option value="priority">Priority only</option>
                    </select>
                  </div>
                </div>

                <div className="todo-list">
                  {todos.length === 0 && (
                    <div className="inline-empty">
                      <p className="muted">No tasks yet. Add one and press Enter to save quickly.</p>
                    </div>
                  )}
                  {todos.length > 0 && filteredTodos.length === 0 && <p className="muted">No tasks match your quick search or filters.</p>}
                  {filteredTodos.map((todo) => (
                    <div
                      key={todo.id}
                      className={[
                        "todo-item",
                        isChecked(todo.isCompleted) ? "done" : "",
                        todo.id === newTodoFlashId ? "recent" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={isChecked(todo.isCompleted)}
                          onChange={(event) => updateTodo(todo, { isCompleted: event.target.checked })}
                        />
                        <span>{todo.text}</span>
                      </label>
                      <div className="todo-actions">
                        <button
                          className={isChecked(todo.isPriority) ? "chip active" : "chip"}
                          onClick={() => updateTodo(todo, { isPriority: !isChecked(todo.isPriority) })}
                        >
                          Priority
                        </button>
                        <button className="ghost" onClick={() => deleteTodo(todo.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "Documents" && (
              <div role="tabpanel" id={tabPanelId("Documents")} aria-labelledby={tabId("Documents")} className="documents-panel">
                <div className="documents-actions">
                  <div>
                    <h3>Project Documents</h3>
                    <p className="muted">Drop files or add via picker. Files stay local.</p>
                  </div>
                  <button className="primary" onClick={() => handleAddFiles()}>Add Files</button>
                </div>
                <div
                  className={`drop-zone ${dragOverDocs ? "drag-over" : ""}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragOverDocs(true);
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragOverDocs(false);
                  }}
                  onDrop={handleDropFiles}
                >
                  Drag & drop files here
                </div>
                <div className="documents-list">
                  {attachments.length === 0 && (
                    <div className="inline-empty">
                      <p className="muted">No files added yet. Add key specs, productions, and QC artifacts here.</p>
                    </div>
                  )}
                  {attachments.length > 0 && filteredAttachments.length === 0 && (
                    <div className="inline-empty">
                      <p className="muted">No documents match your quick search.</p>
                      <button type="button" className="ghost" onClick={() => setQuickSearch("")}>Clear search</button>
                    </div>
                  )}
                  {filteredAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className={[
                        "document-row",
                        attachment.id === newAttachmentFlashId ? "recent" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <div>
                        <p>{attachment.originalFileName}</p>
                        <span className="muted">
                          Added {formatDate(attachment.addedAt)} · {formatBytes(attachment.sizeBytes)}
                        </span>
                      </div>
                      <div className="document-actions">
                        <button className="ghost" onClick={() => previewAttachment(attachment.id)}>
                          Preview
                        </button>
                        <button className="ghost" onClick={() => openAttachment(attachment.id)}>
                          Open
                        </button>
                        <button className="ghost" onClick={() => revealAttachment(attachment.id)}>
                          Reveal
                        </button>
                        <button className="ghost danger" onClick={() => deleteAttachment(attachment.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedProject && (
              <div className="archive-fab">
                <button className="ghost danger" onClick={() => setShowArchiveConfirm(true)}>
                  Archive Project
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      {showSidebar && (
        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <h2>Projects</h2>
              <p className="muted">{projects.length} active</p>
            </div>
            <button className="primary" onClick={openCreateProject}>Add Project</button>
          </div>
          <input
            className="sidebar-search"
            value={projectSearch}
            onChange={(event) => setProjectSearch(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
          />
          <div className="sidebar-list">
            <div
              className={selectedProjectId === null ? "project-card home-card active" : "project-card home-card"}
              onClick={() => setSelectedProjectId(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedProjectId(null);
                }
              }}
            >
              <div className="project-info">
                <span className="project-title">Home</span>
                <span className="project-meta">Deadline Dashboard · Data Safety</span>
              </div>
            </div>
            {projectEmpty && <p className="muted">No projects yet.</p>}
            {!projectEmpty && filteredProjects.length === 0 && (
              <div className="inline-empty">
                <p className="muted">No matching projects.</p>
                <button type="button" className="ghost" onClick={() => setProjectSearch("")}>Clear search</button>
              </div>
            )}
            {filteredProjects.map((project) => {
              const deadline = getDeadlineBadge(project.productionDeadline);
              return (
                <div
                  key={project.id}
                  className={project.id === selectedProjectId ? "project-card active" : "project-card"}
                  onClick={() => setSelectedProjectId(project.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedProjectId(project.id);
                    }
                  }}
                >
                  <div className="project-info">
                    <span className="project-title">{project.matterName}</span>
                    <span className="project-meta">
                      {project.clientName} · {formatDate(project.productionDeadline)}
                    </span>
                    {deadline && (
                      <span className={`deadline-chip ${deadline.tone}`}>{deadline.label}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={isChecked(project.isPinned ?? false) ? "project-pin active" : "project-pin"}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleProjectPin(project);
                    }}
                  >
                    {isChecked(project.isPinned ?? false) ? "Pinned" : "Pin"}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="sidebar-toggle">
            <button
              className={showArchived ? "ghost active" : "ghost"}
              onClick={() => setShowArchived((prev) => !prev)}
              aria-pressed={showArchived}
            >
              {showArchived ? "Hide Archive" : "Show Archive"}
            </button>
          </div>
          {showArchived && (
            <div className="sidebar-archive">
              <h3>Archived</h3>
              {archivedProjects.length === 0 && <p className="muted">Nothing archived yet.</p>}
              <div className="archive-list">
                {archivedProjects.map((project) => (
                  <div
                    key={project.id}
                    className="archive-card"
                    onClick={() => restoreProject(project.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        restoreProject(project.id);
                      }
                    }}
                  >
                    <div>
                      <span className="project-title">{project.matterName}</span>
                      <span className="project-meta">
                        {project.clientName} · Archived {formatDate(project.archivedAt)}
                      </span>
                    </div>
                    <button
                      className="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        restoreProject(project.id);
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      )}

      {showProjectForm && (
        <div className="modal-backdrop" onClick={closeProjectForm}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>{projectFormMode === "create" ? "New Project" : "Edit Project"}</h3>
            <form onSubmit={submitProjectForm} className="project-form">
              <label>
                Matter Name
                <input
                  ref={projectMatterInputRef}
                  value={projectForm.matterName}
                  onChange={(event) => setProjectForm({ ...projectForm, matterName: event.target.value })}
                  required
                />
              </label>
              <label>
                Client Name
                <input
                  value={projectForm.clientName}
                  onChange={(event) => setProjectForm({ ...projectForm, clientName: event.target.value })}
                  required
                />
              </label>
              <label>
                Billing Code
                <input
                  value={projectForm.billingCode}
                  onChange={(event) => setProjectForm({ ...projectForm, billingCode: event.target.value })}
                  required
                />
              </label>
              <div className="form-row">
                <label>
                  Start Date
                  <input
                    type="date"
                    value={projectForm.startDate}
                    onChange={(event) => setProjectForm({ ...projectForm, startDate: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Production Deadline
                  <input
                    type="date"
                    value={projectForm.productionDeadline}
                    onChange={(event) => setProjectForm({ ...projectForm, productionDeadline: event.target.value })}
                    required
                  />
                </label>
              </div>
              <label>
                Relativity Workspace URL
                <input
                  value={projectForm.relativityUrl}
                  onChange={(event) => setProjectForm({ ...projectForm, relativityUrl: event.target.value })}
                  placeholder="https://..."
                />
              </label>
              <div className="form-actions">
                <button type="button" className="ghost" onClick={closeProjectForm}>
                  Cancel
                </button>
                <button type="submit" className="primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showArchiveConfirm && selectedProject && (
        <div className="modal-backdrop" onClick={() => setShowArchiveConfirm(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Archive project?</h3>
            <p className="muted">
              “{selectedProject.matterName}” will move to the Archive section. You can restore it later.
            </p>
            <div className="form-actions">
              <button
                ref={archiveCancelButtonRef}
                type="button"
                className="ghost"
                onClick={() => setShowArchiveConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  setShowArchiveConfirm(false);
                  await archiveProject();
                }}
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="modal-backdrop" onClick={() => setPreviewOpen(false)}>
          <div className="modal attachment-preview-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Document Preview</h3>
            {previewLoading ? (
              <p className="muted">Loading preview…</p>
            ) : !previewResult?.ok ? (
              <p className="muted save-error">{previewResult?.error || "Preview unavailable."}</p>
            ) : (
              <>
                {previewResult.metadata && (
                  <p className="muted">
                    {previewResult.metadata.originalFileName} · {formatBytes(previewResult.metadata.sizeBytes)} · Added{" "}
                    {formatDate(previewResult.metadata.addedAt)}
                  </p>
                )}
                {previewResult.kind === "image" && previewResult.url ? (
                  <img
                    className="attachment-preview-image"
                    src={previewResult.url}
                    alt={previewResult.metadata?.originalFileName || "Attachment preview"}
                  />
                ) : previewResult.kind === "pdf" && previewResult.url ? (
                  <iframe className="attachment-preview-frame" src={previewResult.url} title="Attachment PDF preview" />
                ) : (
                  <p className="muted">Inline preview is unavailable for this file type. Metadata is shown above.</p>
                )}
              </>
            )}
            <div className="form-actions">
              {previewAttachmentId && (
                <button type="button" className="ghost" onClick={() => openAttachment(previewAttachmentId)}>
                  Open Externally
                </button>
              )}
              <button type="button" className="primary" onClick={() => setPreviewOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Appearance Settings</h3>
            <p className="muted">Set app theme and accent color for your workflow.</p>
            <div className="settings-group">
              <p className="settings-label">Theme</p>
              <div className="settings-options">
                <label className="settings-option">
                  <input
                    type="radio"
                    name="themeMode"
                    value="light"
                    checked={themeMode === "light"}
                    onChange={() => setThemeMode("light")}
                  />
                  <span>Light</span>
                </label>
                <label className="settings-option">
                  <input
                    type="radio"
                    name="themeMode"
                    value="dark"
                    checked={themeMode === "dark"}
                    onChange={() => setThemeMode("dark")}
                  />
                  <span>Dark</span>
                </label>
              </div>
            </div>
            <div className="settings-group">
              <label className="settings-label" htmlFor="accent-color-input">
                Accent Color
              </label>
              <div className="settings-accent-row">
                <input
                  id="accent-color-input"
                  type="color"
                  value={normalizeHexColor(accentColor) || DEFAULT_ACCENT_COLOR}
                  onChange={(event) => setAccentColor(normalizeHexColor(event.target.value) || DEFAULT_ACCENT_COLOR)}
                />
                <code>{normalizeHexColor(accentColor) || DEFAULT_ACCENT_COLOR}</code>
              </div>
              <div className="settings-presets">
                {ACCENT_PRESETS.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    className={`settings-swatch ${normalizeHexColor(accentColor) === hex ? "active" : ""}`}
                    style={{ backgroundColor: hex }}
                    aria-label={`Use ${hex} as accent color`}
                    onClick={() => setAccentColor(hex)}
                  />
                ))}
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="primary" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showShortcuts && (
        <div className="modal-backdrop" onClick={() => setShowShortcuts(false)}>
          <div className="modal shortcuts-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Keyboard Shortcuts</h3>
            <div className="shortcut-list">
              <div className="shortcut-row">
                <span>Quick find</span>
                <kbd className="shortcut-key">Ctrl/Cmd + K</kbd>
              </div>
              <div className="shortcut-row">
                <span>Open shortcut help</span>
                <kbd className="shortcut-key">?</kbd>
              </div>
              <div className="shortcut-row">
                <span>Close dialogs</span>
                <kbd className="shortcut-key">Esc</kbd>
              </div>
              <div className="shortcut-row">
                <span>Switch tabs</span>
                <kbd className="shortcut-key">Left/Right Arrow</kbd>
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="primary" onClick={() => setShowShortcuts(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showOnboarding && (
        <div className="modal-backdrop" onClick={dismissOnboarding}>
          <div className="modal onboarding-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Welcome to eDisco Pro Notes</h3>
            <p className="muted">Step {onboardingStep + 1} of {onboardingStepCount}</p>
            <div className="onboarding-progress">
              <div style={{ width: `${((onboardingStep + 1) / onboardingStepCount) * 100}%` }} />
            </div>

            {onboardingStep === 0 && (
              <div className="onboarding-step">
                <p className="muted">Your data stays on this device. No cloud sync is used.</p>
                <p className="muted">
                  Encryption status: {backupStatus?.hasEncryptedDb ? "Encrypted vault active." : "Vault will encrypt on first unlock."}
                </p>
                <p className="muted">
                  Storage path: {backupStatus?.dbPath || "Not created yet"}
                </p>
              </div>
            )}

            {onboardingStep === 1 && (
              <div className="onboarding-step">
                <p className="muted">Create your first project to unlock notes, timeline, to-dos, and documents.</p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    dismissOnboarding();
                    openCreateProject();
                  }}
                >
                  Create Project
                </button>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="onboarding-step">
                <p className="muted">Tab guide:</p>
                <div className="onboarding-checklist">
                  <div className="onboarding-item"><span className="onboarding-mark">1</span><span>Notes: markdown notes, templates, export.</span></div>
                  <div className="onboarding-item"><span className="onboarding-mark">2</span><span>Timelines: phase dates and Gantt view.</span></div>
                  <div className="onboarding-item"><span className="onboarding-mark">3</span><span>To-Do: project action queue with filters.</span></div>
                  <div className="onboarding-item"><span className="onboarding-mark">4</span><span>Documents: local attachments with preview/open.</span></div>
                </div>
              </div>
            )}

            {onboardingStep === 3 && (
              <div className="onboarding-step">
                <p className="muted">Setup checklist:</p>
                <div className="onboarding-checklist">
                  {onboardingChecklist.map((item) => (
                    <div key={item.label} className={item.done ? "onboarding-item done" : "onboarding-item"}>
                      <span className="onboarding-mark" aria-hidden="true">{item.done ? "✓" : "○"}</span>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="onboarding-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setOnboardingStep((step) => Math.max(0, step - 1))}
                disabled={onboardingStep === 0}
              >
                Back
              </button>
              {!onboardingIsLastStep ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => setOnboardingStep((step) => Math.min(onboardingStepCount - 1, step + 1))}
                >
                  Next
                </button>
              ) : (
                <button type="button" className="primary" onClick={dismissOnboarding}>
                  Finish
                </button>
              )}
              <button type="button" className="ghost" onClick={dismissOnboarding}>
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
