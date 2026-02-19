/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    edisconotes: {
      vaultStatus: () => Promise<{ locked: boolean; hasEncryptedDb: boolean; hasPlaintextDb: boolean }>;
      vaultUnlock: (
        passphrase: string
      ) => Promise<{ ok: boolean; migratedDb?: boolean; migratedAttachments?: number; unlockSource?: string; seededLegacyAttachments?: number }>;
      vaultLock: () => Promise<boolean>;
      getDeadlineDashboard: () => Promise<DeadlineDashboard>;
      listProjects: (includeArchived?: boolean) => Promise<Project[]>;
      getProject: (projectId: string) => Promise<Project | null>;
      createProject: (data: ProjectInput) => Promise<Project>;
      updateProject: (projectId: string, data: ProjectInput) => Promise<Project>;
      archiveProject: (projectId: string) => Promise<boolean>;
      restoreProject: (projectId: string) => Promise<Project | null>;
      pinProject: (projectId: string, isPinned: boolean) => Promise<Project>;
      exportProjectBundle: (
        projectId: string
      ) => Promise<{ ok: boolean; canceled?: boolean; error?: string; filePath?: string; notes?: number; todos?: number; attachments?: number }>;
      importProjectBundle: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        error?: string;
        project?: Project;
        counts?: { notes: number; todos: number; timelineTasks: number; attachments: number };
      }>;
      listNotes: (projectId: string) => Promise<Note[]>;
      createNote: (projectId: string, data: NoteInput) => Promise<Note>;
      updateNote: (noteId: string, data: NoteInput) => Promise<Note>;
      deleteNote: (noteId: string) => Promise<boolean>;
      listTodos: (projectId: string) => Promise<Todo[]>;
      createTodo: (projectId: string, data: TodoInput) => Promise<Todo>;
      updateTodo: (todoId: string, data: TodoInput) => Promise<Todo>;
      deleteTodo: (todoId: string) => Promise<boolean>;
      listAttachments: (projectId: string) => Promise<Attachment[]>;
      addAttachments: (projectId: string, filePaths: string[]) => Promise<Attachment[]>;
      openAttachment: (attachmentId: string) => Promise<boolean>;
      previewAttachment: (attachmentId: string) => Promise<AttachmentPreviewResult>;
      revealAttachment: (attachmentId: string) => Promise<boolean>;
      deleteAttachment: (attachmentId: string) => Promise<boolean>;
      searchGlobal: (query: string) => Promise<GlobalSearchResult>;
      openExternalUrl: (targetUrl: string) => Promise<boolean>;
      listAuditLog: (limit?: number, projectId?: string | null) => Promise<AuditLogEntry[]>;
      backupStatus: () => Promise<BackupStatus>;
      createBackupSnapshot: (reason?: string) => Promise<{ ok: boolean; error?: string; snapshot?: BackupSnapshot }>;
      listBackupSnapshots: (limit?: number) => Promise<BackupSnapshot[]>;
      restoreBackupSnapshot: (
        snapshotId: string
      ) => Promise<{ ok: boolean; canceled?: boolean; error?: string; relaunching?: boolean; restoredAttachments?: number; preRestoreSnapshotId?: string | null }>;
      exportBackup: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; backupPath?: string; createdAt?: string }>;
      restoreBackup: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; relaunching?: boolean }>;
      openFileDialog: () => Promise<string[]>;
      exportNotesDocx: (projectId: string) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
      exportNotesPdf: (projectId: string) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
      exportNotesMarkdown: (projectId: string) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
      listTimelineTasks: (projectId?: string) => Promise<TimelineTask[]>;
      upsertTimelineTask: (
        projectId: string,
        data: { phase: string; startDate: string | null; endDate: string | null }
      ) => Promise<TimelineTask | null>;
    };
  }

  interface Project {
    id: string;
    matterName: string;
    clientName: string;
    billingCode: string;
    startDate: string;
    productionDeadline: string;
    relativityUrl?: string | null;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string | null;
    isPinned?: number | boolean;
  }

  interface ProjectInput {
    matterName: string;
    clientName: string;
    billingCode: string;
    startDate: string;
    productionDeadline: string;
    relativityUrl?: string | null;
  }

  interface Note {
    id: string;
    projectId: string;
    title: string;
    noteDate: string;
    contentMarkdown: string;
    createdAt: string;
    updatedAt: string;
  }

  interface NoteInput {
    title: string;
    noteDate: string;
    contentMarkdown: string;
  }

  interface Todo {
    id: string;
    projectId: string;
    text: string;
    isCompleted: number | boolean;
    isPriority: number | boolean;
    createdAt: string;
    completedAt?: string | null;
  }

  interface TodoInput {
    text: string;
    isCompleted: boolean;
    isPriority: boolean;
  }

  interface Attachment {
    id: string;
    projectId: string;
    originalFileName: string;
    storedFileName: string;
    storedRelativePath: string;
    sizeBytes: number;
    addedAt: string;
  }

  interface AttachmentPreviewMetadata {
    id: string;
    projectId: string;
    originalFileName: string;
    sizeBytes: number;
    addedAt: string;
    extension: string;
    isEncryptedAtRest: boolean;
  }

  interface AttachmentPreviewResult {
    ok: boolean;
    error?: string;
    kind?: "image" | "pdf" | "meta";
    url?: string | null;
    metadata?: AttachmentPreviewMetadata;
  }

  interface GlobalSearchProjectHit {
    id: string;
    matterName: string;
    clientName: string;
    billingCode: string;
  }

  interface GlobalSearchNoteHit {
    id: string;
    projectId: string;
    projectName: string;
    title: string;
    noteDate: string;
    snippet: string;
  }

  interface GlobalSearchTodoHit {
    id: string;
    projectId: string;
    projectName: string;
    text: string;
    isCompleted: number | boolean;
    isPriority: number | boolean;
  }

  interface GlobalSearchAttachmentHit {
    id: string;
    projectId: string;
    projectName: string;
    originalFileName: string;
    sizeBytes: number;
    addedAt: string;
  }

  interface GlobalSearchResult {
    query: string;
    projects: GlobalSearchProjectHit[];
    notes: GlobalSearchNoteHit[];
    todos: GlobalSearchTodoHit[];
    attachments: GlobalSearchAttachmentHit[];
  }

  interface BackupStatus {
    hasEncryptedDb: boolean;
    hasPlaintextDb: boolean;
    encryptedDbInUse: boolean;
    dbPath: string | null;
    dbLastModifiedAt: string | null;
    lastBackupAt: string | null;
    lastBackupPath: string | null;
    lastRestoreAt: string | null;
  }

  interface BackupSnapshot {
    id: string;
    createdAt: string | null;
    reason: string;
    dbFileName: string | null;
    encryptedDatabase: boolean;
    attachmentFiles: number;
    path?: string;
  }

  interface AuditLogEntry {
    id: string;
    timestamp: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    projectId?: string | null;
    detailsJson?: string | null;
    details?: Record<string, unknown> | null;
  }

  interface DeadlineDashboardTotals {
    projectsTracked: number;
    overdueTimeline: number;
    dueWithin7Days: number;
    dueWithin30Days: number;
    totalTodos: number;
    openTodos: number;
    priorityOpenTodos: number;
    completedTodos: number;
  }

  interface DeadlineDashboardTimelineItem {
    id: string;
    projectId: string;
    projectName: string;
    phase: string;
    dueDate: string;
    daysFromNow: number;
    tone: "late" | "soon" | "normal";
  }

  interface DeadlineDashboardTodoRollup {
    projectId: string;
    projectName: string;
    productionDeadline: string;
    daysToDeadline: number | null;
    totalTodos: number;
    completedTodos: number;
    openTodos: number;
    priorityOpenTodos: number;
    overdueTimelineItems: number;
    upcomingTimelineItems: number;
  }

  interface DeadlineDashboard {
    generatedAt: string;
    totals: DeadlineDashboardTotals;
    overdueTimeline: DeadlineDashboardTimelineItem[];
    upcomingTimeline: DeadlineDashboardTimelineItem[];
    todoRollups: DeadlineDashboardTodoRollup[];
  }

  interface TimelineTask {
    id: string;
    projectId: string;
    phase: string;
    startDate?: string | null;
    endDate?: string | null;
    createdAt: string;
    updatedAt: string;
  }
}
