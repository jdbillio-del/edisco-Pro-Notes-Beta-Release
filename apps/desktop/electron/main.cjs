const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");
const crypto = require("crypto");
const { randomUUID } = crypto;
const { pathToFileURL } = require("url");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
const vaultCrypto = require("./crypto.cjs");
const fsPromises = require("fs/promises");

const isDev = !app.isPackaged;
const ENCRYPTION_ENABLED = true;
const MIN_PASSPHRASE_LEN = 12;
const DEV_USER_DATA_DIR = "edisconotes-desktop";
let mainWindow = null;
let db = null;
let SQL = null;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_TIMELINE_PHASES = new Set([
  "Collections",
  "Processing",
  "TAR",
  "Review",
  "Post-processing",
  "Production",
  "Project Completion"
]);
const tempOpenFiles = new Set();

const vaultState = {
  locked: ENCRYPTION_ENABLED,
  // { masterKey, dbKey, fileKey, kdfSalt, kdfParams }
  vault: null
};

// When launched via `electron <entry-file>` the app name defaults to "Electron",
// which causes collisions in ~/Library/Application Support/Electron across projects.
if (app.getName() === "Electron") {
  app.setName(DEV_USER_DATA_DIR);
}
app.setPath("userData", path.resolve(app.getPath("appData"), DEV_USER_DATA_DIR));

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const attachmentsRoot = () => path.resolve(app.getPath("userData"), "attachments");
const tempRoot = () => path.resolve(app.getPath("temp"), "edisconotes-decrypted");
const backupMetaPath = () => path.resolve(app.getPath("userData"), "backup-meta.json");
const snapshotsRoot = () => path.resolve(app.getPath("userData"), "snapshots");

const dbPlainPath = () => path.join(app.getPath("userData"), "edisconotes.sqlite");
const dbEncPath = () => path.join(app.getPath("userData"), "edisconotes.sqlite.enc");
const PROJECT_BUNDLE_FORMAT = "edisconotes.project-bundle";
const PROJECT_BUNDLE_VERSION = 1;

const listUserDataRootsForUnlock = () => {
  return [path.resolve(app.getPath("userData"))];
};

const listEncryptedDbCandidates = () => {
  const currentRoot = path.resolve(app.getPath("userData"));
  const candidates = [];
  for (const root of listUserDataRootsForUnlock()) {
    const encryptedPath = path.join(root, "edisconotes.sqlite.enc");
    const backupPath = `${encryptedPath}.bak`;
    if (fs.existsSync(encryptedPath)) {
      candidates.push({
        dbPath: encryptedPath,
        userDataRoot: root,
        source: root === currentRoot ? "current" : "legacy",
        isBackup: false
      });
    }
    if (fs.existsSync(backupPath)) {
      candidates.push({
        dbPath: backupPath,
        userDataRoot: root,
        source: root === currentRoot ? "current" : "legacy",
        isBackup: true
      });
    }
  }
  return candidates;
};

const isDecryptAuthError = (error) =>
  Boolean(error && typeof error.message === "string" && /unable to authenticate data/i.test(error.message));

const describeUnlockSource = (source) => {
  if (!source) return "new";
  const rootLabel = source.source === "current" ? "current" : `legacy:${path.basename(source.userDataRoot)}`;
  return source.isBackup ? `${rootLabel}:backup` : rootLabel;
};

const PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

const readJsonFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJsonFile = (filePath, payload) => {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const readJsonSafe = (raw) => {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
};

const copyDirRecursive = (sourceDir, targetDir) => {
  if (!fs.existsSync(sourceDir)) return 0;
  ensureDir(targetDir);
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirRecursive(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.copyFileSync(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
};

const countFilesRecursive = (rootDir) => {
  if (!fs.existsSync(rootDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(fullPath);
      continue;
    }
    if (entry.isFile()) count += 1;
  }
  return count;
};

const isValidProjectId = (projectId) => typeof projectId === "string" && UUID_V4_REGEX.test(projectId);

const assertUuid = (value, fieldName) => {
  if (!isValidProjectId(value)) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return value;
};

const ensureBoolean = (value, fieldName) => {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be true or false.`);
  }
  return value;
};

const ensureText = (value, fieldName, opts = {}) => {
  const {
    minLen = 1,
    maxLen = 512,
    trim = true,
    allowEmpty = false
  } = opts;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  const out = trim ? value.trim() : value;
  if (!allowEmpty && out.length < minLen) {
    throw new Error(`${fieldName} is required.`);
  }
  if (out.length > maxLen) {
    throw new Error(`${fieldName} is too long.`);
  }
  return out;
};

const ensureIsoDate = (value, fieldName, opts = {}) => {
  const { allowNull = false } = opts;
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new Error(`${fieldName} is required.`);
  }
  if (typeof value !== "string" || !ISO_DATE_REGEX.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return value;
};

const ensureHttpUrl = (value, fieldName, opts = {}) => {
  const { allowNull = false, maxLen = 2048 } = opts;
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new Error(`${fieldName} is required.`);
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a URL string.`);
  }
  const out = value.trim();
  if (out.length > maxLen) {
    throw new Error(`${fieldName} is too long.`);
  }
  let parsed;
  try {
    parsed = new URL(out);
  } catch {
    throw new Error(`${fieldName} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${fieldName} must use http or https.`);
  }
  return parsed.toString();
};

const sanitizeProjectInput = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Project data is required.");
  }
  return {
    matterName: ensureText(data.matterName, "Matter name", { maxLen: 200 }),
    clientName: ensureText(data.clientName, "Client name", { maxLen: 200 }),
    billingCode: ensureText(data.billingCode, "Billing code", { maxLen: 120 }),
    startDate: ensureIsoDate(data.startDate, "Start date"),
    productionDeadline: ensureIsoDate(data.productionDeadline, "Production deadline"),
    relativityUrl: ensureHttpUrl(data.relativityUrl, "Relativity workspace URL", { allowNull: true, maxLen: 2048 })
  };
};

const sanitizeNoteInput = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Note data is required.");
  }
  return {
    title: ensureText(data.title, "Note title", { maxLen: 200 }),
    noteDate: ensureIsoDate(data.noteDate, "Note date"),
    contentMarkdown: ensureText(data.contentMarkdown, "Note content", {
      trim: false,
      allowEmpty: true,
      minLen: 0,
      maxLen: 2_000_000
    })
  };
};

const sanitizeTodoInput = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("To-do data is required.");
  }
  return {
    text: ensureText(data.text, "To-do text", { maxLen: 2000 }),
    isCompleted: ensureBoolean(data.isCompleted, "To-do completed state"),
    isPriority: ensureBoolean(data.isPriority, "To-do priority state")
  };
};

const sanitizeTimelineInput = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Timeline data is required.");
  }
  const phase = ensureText(data.phase, "Timeline phase", { maxLen: 64 });
  if (!ALLOWED_TIMELINE_PHASES.has(phase)) {
    throw new Error("Timeline phase is invalid.");
  }

  const startDate = ensureIsoDate(data.startDate, "Timeline start date", { allowNull: true });
  let endDate = ensureIsoDate(data.endDate, "Timeline end date", { allowNull: true });
  const isMilestone = phase === "Project Completion";
  if (isMilestone) {
    endDate = null;
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error("Timeline start date must be before end date.");
  }

  return {
    phase,
    startDate,
    endDate
  };
};

const getSafeProjectAttachmentDir = (projectId) => {
  if (!isValidProjectId(projectId)) return null;
  const baseDir = attachmentsRoot();
  const targetDir = path.resolve(baseDir, projectId);
  if (targetDir !== baseDir && targetDir.startsWith(`${baseDir}${path.sep}`)) {
    return targetDir;
  }
  return null;
};

const isContainedPath = (candidatePath, basePath) => {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedBase = path.resolve(basePath);
  return (
    resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  );
};

const isAllowedNavigation = (targetUrl) => {
  try {
    const target = new URL(targetUrl);
    if (isDev) {
      return target.origin === "http://localhost:5173";
    }
    return target.protocol === "file:";
  } catch {
    return false;
  }
};

const encryptAttachmentFile = async (sourcePath, destPath, fileKey) => {
  const iv = crypto.randomBytes(vaultCrypto.IV_LEN);
  const header = Buffer.concat([vaultCrypto.FILE_MAGIC, Buffer.from([vaultCrypto.FILE_VERSION]), iv]);
  const aad = Buffer.concat([vaultCrypto.FILE_MAGIC, Buffer.from([vaultCrypto.FILE_VERSION])]);

  const tmpPath = `${destPath}.tmp`;
  await fsPromises.mkdir(path.dirname(destPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(sourcePath);
    const cipher = crypto.createCipheriv("aes-256-gcm", fileKey, iv);
    cipher.setAAD(aad);

    const output = fs.createWriteStream(tmpPath, { mode: 0o600 });
    output.on("error", reject);
    input.on("error", reject);
    cipher.on("error", reject);

    output.write(header);
    input.pipe(cipher).pipe(output, { end: false });
    cipher.on("end", () => {
      try {
        const tag = cipher.getAuthTag();
        output.end(tag);
      } catch (error) {
        reject(error);
      }
    });
    output.on("finish", () => {
      try {
        fs.renameSync(tmpPath, destPath);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
};

const decryptAttachmentFile = async (encryptedPath, destPath, fileKey) => {
  const stat = fs.statSync(encryptedPath);
  const headerLen = vaultCrypto.FILE_MAGIC.length + 1 + vaultCrypto.IV_LEN;
  if (stat.size < headerLen + vaultCrypto.TAG_LEN + 1) {
    throw new Error("Encrypted attachment is corrupted (too small).");
  }

  const fd = fs.openSync(encryptedPath, "r");
  try {
    const header = Buffer.alloc(headerLen);
    fs.readSync(fd, header, 0, headerLen, 0);
    const magic = header.subarray(0, vaultCrypto.FILE_MAGIC.length);
    if (!magic.equals(vaultCrypto.FILE_MAGIC)) {
      throw new Error("Not an encrypted attachment.");
    }
    const version = header.readUInt8(vaultCrypto.FILE_MAGIC.length);
    if (version !== vaultCrypto.FILE_VERSION) {
      throw new Error(`Unsupported encrypted attachment version: ${version}`);
    }
    const iv = header.subarray(vaultCrypto.FILE_MAGIC.length + 1);

    const tag = Buffer.alloc(vaultCrypto.TAG_LEN);
    fs.readSync(fd, tag, 0, vaultCrypto.TAG_LEN, stat.size - vaultCrypto.TAG_LEN);

    const aad = Buffer.concat([vaultCrypto.FILE_MAGIC, Buffer.from([vaultCrypto.FILE_VERSION])]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", fileKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    const tmpPath = `${destPath}.tmp`;
    await fsPromises.mkdir(path.dirname(destPath), { recursive: true });

    const ciphertextStart = headerLen;
    const ciphertextEnd = stat.size - vaultCrypto.TAG_LEN - 1;

    return await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encryptedPath, { start: ciphertextStart, end: ciphertextEnd });
      const output = fs.createWriteStream(tmpPath, { mode: 0o600 });
      output.on("error", reject);
      input.on("error", reject);
      decipher.on("error", reject);

      input.pipe(decipher).pipe(output);
      output.on("finish", () => {
        try {
          fs.renameSync(tmpPath, destPath);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
};

const persistDbInternal = () => {
  if (!db) return;
  if (!ENCRYPTION_ENABLED) {
    const data = db.export();
    fs.writeFileSync(dbPlainPath(), Buffer.from(data));
    return;
  }
  if (vaultState.locked || !vaultState.vault) return;
  const data = db.export();
  const plaintext = Buffer.from(data);
  const envelope = vaultCrypto.sealDatabaseBytes(plaintext, vaultState.vault);
  const targetPath = dbEncPath();
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, envelope);

  // Windows rename() won't overwrite an existing file; do a safe replace.
  const backupPath = `${targetPath}.bak`;
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch {
    // ignore
  }
  if (fs.existsSync(targetPath)) {
    try {
      fs.renameSync(targetPath, backupPath);
    } catch {
      // If we can't move aside, try unlink as a fallback.
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // ignore
      }
    }
  }
  fs.renameSync(tmpPath, targetPath);
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch {
    // ignore
  }
};

const persistDb = () => {
  try {
    persistDbInternal();
  } catch (error) {
    console.error("Failed to persist database", error);
  }
};

const persistDbOrThrow = () => {
  persistDbInternal();
};

const run = (sql, params = []) => {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
};

const all = (sql, params = []) => {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
};

const get = (sql, params = []) => {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
};

const initDatabase = async (initialDbBytes) => {
  if (!SQL) {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    SQL = await initSqlJs({ locateFile: () => wasmPath });
  }

  let openBytes = initialDbBytes || null;
  if (!openBytes && !ENCRYPTION_ENABLED) {
    const plainPath = dbPlainPath();
    if (fs.existsSync(plainPath)) {
      openBytes = fs.readFileSync(plainPath);
    }
  }

  db = new SQL.Database(openBytes || undefined);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      matterName TEXT NOT NULL,
      clientName TEXT NOT NULL,
      billingCode TEXT NOT NULL,
      startDate TEXT NOT NULL,
      productionDeadline TEXT NOT NULL,
      relativityUrl TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      archivedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      noteDate TEXT NOT NULL,
      contentMarkdown TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      text TEXT NOT NULL,
      isCompleted INTEGER NOT NULL,
      isPriority INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      completedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      originalFileName TEXT NOT NULL,
      storedFileName TEXT NOT NULL,
      storedRelativePath TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      addedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      phase TEXT NOT NULL,
      startDate TEXT,
      endDate TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(projectId, phase)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT,
      projectId TEXT,
      detailsJson TEXT
    );
  `);

  const columns = all("PRAGMA table_info(projects)").map((row) => row.name);
  if (!columns.includes("isPinned")) {
    db.exec("ALTER TABLE projects ADD COLUMN isPinned INTEGER NOT NULL DEFAULT 0");
  }
};

const nowIso = () => new Date().toISOString();

const hasEncryptedDb = () => listEncryptedDbCandidates().length > 0;
const hasPlaintextDb = () => fs.existsSync(dbPlainPath());

const getDatabaseFileStatus = () => {
  const encryptedCandidate = listEncryptedDbCandidates()[0];
  if (encryptedCandidate) {
    const stat = fs.statSync(encryptedCandidate.dbPath);
    return {
      encrypted: true,
      dbPath: encryptedCandidate.dbPath,
      dbLastModifiedAt: stat.mtime.toISOString()
    };
  }
  const plaintextPath = dbPlainPath();
  if (fs.existsSync(plaintextPath)) {
    const stat = fs.statSync(plaintextPath);
    return {
      encrypted: false,
      dbPath: plaintextPath,
      dbLastModifiedAt: stat.mtime.toISOString()
    };
  }
  return {
    encrypted: false,
    dbPath: null,
    dbLastModifiedAt: null
  };
};

const getBackupStatus = () => {
  const dbStatus = getDatabaseFileStatus();
  const meta = readJsonFile(backupMetaPath()) || {};
  return {
    hasEncryptedDb: hasEncryptedDb(),
    hasPlaintextDb: hasPlaintextDb(),
    encryptedDbInUse: dbStatus.encrypted,
    dbPath: dbStatus.dbPath,
    dbLastModifiedAt: dbStatus.dbLastModifiedAt,
    lastBackupAt: typeof meta.lastBackupAt === "string" ? meta.lastBackupAt : null,
    lastBackupPath: typeof meta.lastBackupPath === "string" ? meta.lastBackupPath : null,
    lastRestoreAt: typeof meta.lastRestoreAt === "string" ? meta.lastRestoreAt : null
  };
};

const sanitizeAuditDetails = (details) => {
  if (details === null || details === undefined) return null;
  try {
    return JSON.stringify(details);
  } catch {
    return JSON.stringify({ error: "unserializable_details" });
  }
};

const recordAudit = ({ action, entityType = "system", entityId = null, projectId = null, details = null, persist = false }) => {
  if (!db || (ENCRYPTION_ENABLED && vaultState.locked)) {
    return null;
  }
  const id = randomUUID();
  run(
    `INSERT INTO audit_log
    (id, timestamp, action, entityType, entityId, projectId, detailsJson)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, nowIso(), String(action || "unknown"), String(entityType || "system"), entityId, projectId, sanitizeAuditDetails(details)]
  );
  if (persist) {
    persistDb();
  }
  return id;
};

const sanitizeSnapshotId = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{8,128}$/.test(value)) {
    throw new Error("Invalid snapshot ID.");
  }
  return value;
};

const createLocalSnapshot = (reason = "manual") => {
  if (db && (!ENCRYPTION_ENABLED || !vaultState.locked)) {
    persistDbOrThrow();
  }
  const dbStatus = getDatabaseFileStatus();
  if (!dbStatus.dbPath || !fs.existsSync(dbStatus.dbPath)) {
    throw new Error("No database file found.");
  }

  ensureDir(snapshotsRoot());
  const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const snapshotDir = path.resolve(snapshotsRoot(), snapshotId);
  ensureDir(snapshotDir);

  const dbFileName = path.basename(dbStatus.dbPath);
  fs.copyFileSync(dbStatus.dbPath, path.join(snapshotDir, dbFileName));

  const attachmentSource = attachmentsRoot();
  const attachmentTarget = path.join(snapshotDir, "attachments");
  const attachmentFiles = copyDirRecursive(attachmentSource, attachmentTarget);
  const createdAt = nowIso();
  const manifest = {
    format: "edisconotes.snapshot",
    version: 1,
    snapshotId,
    createdAt,
    reason: String(reason || "manual"),
    dbFileName,
    encryptedDatabase: dbStatus.encrypted,
    attachmentFiles
  };
  writeJsonFile(path.join(snapshotDir, "manifest.json"), manifest);
  return {
    id: snapshotId,
    createdAt,
    reason: manifest.reason,
    dbFileName,
    encryptedDatabase: dbStatus.encrypted,
    attachmentFiles
  };
};

const listLocalSnapshots = (limit = 20) => {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 20;
  const root = snapshotsRoot();
  if (!fs.existsSync(root)) return [];

  const snapshots = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    const manifest = readJsonFile(path.join(dirPath, "manifest.json"));
    if (!manifest || typeof manifest !== "object") continue;
    snapshots.push({
      id: typeof manifest.snapshotId === "string" ? manifest.snapshotId : entry.name,
      createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
      reason: typeof manifest.reason === "string" ? manifest.reason : "manual",
      dbFileName: typeof manifest.dbFileName === "string" ? manifest.dbFileName : null,
      encryptedDatabase: Boolean(manifest.encryptedDatabase),
      attachmentFiles: Number(manifest.attachmentFiles || 0),
      path: dirPath
    });
  }

  snapshots.sort((a, b) => {
    const left = new Date(a.createdAt || 0).getTime();
    const right = new Date(b.createdAt || 0).getTime();
    return right - left;
  });
  return snapshots.slice(0, safeLimit);
};

const resolveSnapshotDir = (snapshotId) => {
  const safeId = sanitizeSnapshotId(snapshotId);
  const root = snapshotsRoot();
  const snapshotDir = path.resolve(root, safeId);
  if (!isContainedPath(snapshotDir, root) || !fs.existsSync(snapshotDir) || !fs.statSync(snapshotDir).isDirectory()) {
    throw new Error("Snapshot not found.");
  }
  return snapshotDir;
};

const readAttachmentPlaintextBuffer = async (attachment) => {
  const baseDir = attachmentsRoot();
  const relPath = String(attachment.storedRelativePath || "");
  const fullPath = path.resolve(baseDir, relPath);
  if (!isContainedPath(fullPath, baseDir) || !fs.existsSync(fullPath)) {
    return null;
  }

  const shouldDecrypt = ENCRYPTION_ENABLED && relPath.endsWith(".enc");
  if (!shouldDecrypt) {
    return fs.readFileSync(fullPath);
  }

  ensureDir(tempRoot());
  const ext = path.extname(String(attachment.originalFileName || "")) || ".tmp";
  const tempPath = path.resolve(tempRoot(), `${randomUUID()}${ext}`);
  try {
    await decryptAttachmentFile(fullPath, tempPath, vaultState.vault.fileKey);
    return fs.readFileSync(tempPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
};

const writeAttachmentFromPlaintextBuffer = async (projectId, originalFileName, bytes) => {
  const safeProjectId = assertUuid(projectId, "project ID");
  const attachmentsDir = getSafeProjectAttachmentDir(safeProjectId);
  if (!attachmentsDir) {
    throw new Error("Project attachment path is invalid.");
  }
  ensureDir(attachmentsDir);
  const ext = path.extname(String(originalFileName || ""));
  const storedFileName = ENCRYPTION_ENABLED ? `${randomUUID()}${ext}.enc` : `${randomUUID()}${ext}`;
  const storedRelativePath = path.join(safeProjectId, storedFileName);
  const destPath = path.resolve(attachmentsDir, storedFileName);
  if (!isContainedPath(destPath, attachmentsDir)) {
    throw new Error("Invalid attachment destination.");
  }

  if (ENCRYPTION_ENABLED) {
    ensureDir(tempRoot());
    const tempPath = path.resolve(tempRoot(), `${randomUUID()}${ext || ".tmp"}`);
    try {
      fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
      await encryptAttachmentFile(tempPath, destPath, vaultState.vault.fileKey);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  } else {
    fs.writeFileSync(destPath, bytes, { mode: 0o600 });
  }

  return {
    storedFileName,
    storedRelativePath,
    sizeBytes: bytes.length
  };
};

const findUniqueImportedMatterName = (baseMatterName) => {
  const cleaned = ensureText(baseMatterName, "Matter name", { maxLen: 180 });
  const dateSuffix = new Date().toISOString().slice(0, 10);
  let candidate = `${cleaned} (Imported ${dateSuffix})`;
  let index = 2;
  while (get("SELECT id FROM projects WHERE lower(matterName) = lower(?)", [candidate])) {
    candidate = `${cleaned} (Imported ${dateSuffix} #${index})`;
    index += 1;
  }
  return candidate.slice(0, 200);
};

const resolveBackupDatabaseSource = (backupDir) => {
  const encryptedCandidate = path.join(backupDir, "edisconotes.sqlite.enc");
  const plaintextCandidate = path.join(backupDir, "edisconotes.sqlite");
  const dbSourcePath = fs.existsSync(encryptedCandidate)
    ? encryptedCandidate
    : fs.existsSync(plaintextCandidate)
      ? plaintextCandidate
      : null;
  if (!dbSourcePath) return null;
  return {
    dbSourcePath,
    restoreToEncrypted: path.basename(dbSourcePath) === "edisconotes.sqlite.enc"
  };
};

const restoreFromBackupFolder = (backupDir, reason = "restore") => {
  const source = resolveBackupDatabaseSource(backupDir);
  if (!source) {
    return { ok: false, error: "Selected folder does not contain a valid backup database file." };
  }

  let preRestoreSnapshotId = null;
  try {
    const snapshot = createLocalSnapshot(`pre-restore:${reason}`);
    preRestoreSnapshotId = snapshot.id;
  } catch (error) {
    console.error("Failed to create pre-restore snapshot", error);
  }

  try {
    lockVault();
  } catch (error) {
    console.error("Failed to lock vault before restore", error);
  }

  try {
    if (fs.existsSync(dbEncPath())) fs.unlinkSync(dbEncPath());
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(dbPlainPath())) fs.unlinkSync(dbPlainPath());
  } catch {
    // ignore
  }

  const dbTargetPath = source.restoreToEncrypted ? dbEncPath() : dbPlainPath();
  fs.copyFileSync(source.dbSourcePath, dbTargetPath);

  const attachmentSource = path.join(backupDir, "attachments");
  const attachmentTarget = attachmentsRoot();
  if (fs.existsSync(attachmentTarget)) {
    fs.rmSync(attachmentTarget, { recursive: true, force: true });
  }
  const restoredAttachments = copyDirRecursive(attachmentSource, attachmentTarget);

  const existingMeta = readJsonFile(backupMetaPath()) || {};
  writeJsonFile(backupMetaPath(), {
    ...existingMeta,
    lastRestoreAt: nowIso(),
    lastBackupPath: backupDir
  });

  return {
    ok: true,
    relaunching: true,
    restoredAttachments,
    preRestoreSnapshotId
  };
};

const buildDeadlineDashboard = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const projects = all(
    "SELECT id, matterName, productionDeadline FROM projects WHERE archivedAt IS NULL ORDER BY productionDeadline ASC"
  );
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const rollupMap = new Map(
    projects.map((project) => [
      project.id,
      {
        projectId: project.id,
        projectName: project.matterName,
        productionDeadline: project.productionDeadline,
        daysToDeadline: null,
        totalTodos: 0,
        completedTodos: 0,
        openTodos: 0,
        priorityOpenTodos: 0,
        overdueTimelineItems: 0,
        upcomingTimelineItems: 0
      }
    ])
  );

  for (const rollup of rollupMap.values()) {
    const raw = String(rollup.productionDeadline || "").slice(0, 10);
    if (!raw) continue;
    const due = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(due.getTime())) continue;
    rollup.daysToDeadline = Math.round((due.getTime() - today.getTime()) / 86400000);
  }

  const timelineItems = [];
  for (const task of all("SELECT id, projectId, phase, startDate, endDate FROM timeline_tasks")) {
    if (!projectById.has(task.projectId)) continue;
    const dateOnly = String(task.endDate || task.startDate || "").slice(0, 10);
    if (!dateOnly) continue;
    const due = new Date(`${dateOnly}T00:00:00`);
    if (Number.isNaN(due.getTime())) continue;
    const days = Math.round((due.getTime() - today.getTime()) / 86400000);
    const item = {
      id: task.id,
      projectId: task.projectId,
      projectName: projectById.get(task.projectId)?.matterName || "Unknown Project",
      phase: task.phase,
      dueDate: dateOnly,
      daysFromNow: days,
      tone: days < 0 ? "late" : days <= 7 ? "soon" : "normal"
    };
    timelineItems.push(item);
    const rollup = rollupMap.get(task.projectId);
    if (!rollup) continue;
    if (days < 0) {
      rollup.overdueTimelineItems += 1;
    } else if (days <= 30) {
      rollup.upcomingTimelineItems += 1;
    }
  }
  timelineItems.sort((a, b) => a.daysFromNow - b.daysFromNow);

  for (const todo of all("SELECT projectId, isCompleted, isPriority FROM todos")) {
    const rollup = rollupMap.get(todo.projectId);
    if (!rollup) continue;
    const completed = Boolean(todo.isCompleted);
    const priority = Boolean(todo.isPriority);
    rollup.totalTodos += 1;
    if (completed) {
      rollup.completedTodos += 1;
    } else {
      rollup.openTodos += 1;
      if (priority) {
        rollup.priorityOpenTodos += 1;
      }
    }
  }

  const todoRollups = Array.from(rollupMap.values()).sort((a, b) => {
    const left = a.daysToDeadline === null ? Number.POSITIVE_INFINITY : a.daysToDeadline;
    const right = b.daysToDeadline === null ? Number.POSITIVE_INFINITY : b.daysToDeadline;
    if (left !== right) return left - right;
    if (b.priorityOpenTodos !== a.priorityOpenTodos) return b.priorityOpenTodos - a.priorityOpenTodos;
    if (b.openTodos !== a.openTodos) return b.openTodos - a.openTodos;
    return a.projectName.localeCompare(b.projectName);
  });

  const overdueTimeline = timelineItems.filter((item) => item.daysFromNow < 0);
  const upcomingTimeline = timelineItems.filter((item) => item.daysFromNow >= 0);
  return {
    generatedAt: nowIso(),
    totals: {
      projectsTracked: projects.length,
      overdueTimeline: overdueTimeline.length,
      dueWithin7Days: timelineItems.filter((item) => item.daysFromNow >= 0 && item.daysFromNow <= 7).length,
      dueWithin30Days: timelineItems.filter((item) => item.daysFromNow > 7 && item.daysFromNow <= 30).length,
      totalTodos: todoRollups.reduce((sum, row) => sum + row.totalTodos, 0),
      openTodos: todoRollups.reduce((sum, row) => sum + row.openTodos, 0),
      priorityOpenTodos: todoRollups.reduce((sum, row) => sum + row.priorityOpenTodos, 0),
      completedTodos: todoRollups.reduce((sum, row) => sum + row.completedTodos, 0)
    },
    overdueTimeline: overdueTimeline.slice(0, 10),
    upcomingTimeline: upcomingTimeline.slice(0, 10),
    todoRollups: todoRollups.slice(0, 16)
  };
};

const makeSnippet = (rawText, query, limit = 120) => {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const hit = query ? lower.indexOf(query) : -1;
  if (hit === -1 || text.length <= limit) {
    return text.slice(0, limit);
  }
  const start = Math.max(0, hit - Math.floor(limit / 3));
  const end = Math.min(text.length, start + limit);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};

const includesQuery = (query, ...parts) => {
  if (!query) return true;
  return parts.some((part) => String(part || "").toLowerCase().includes(query));
};

const assertUnlocked = () => {
  if (!ENCRYPTION_ENABLED) {
    if (!db) {
      throw new Error("Database not initialized.");
    }
    return;
  }
  if (vaultState.locked || !vaultState.vault || !db) {
    throw new Error("Vault locked.");
  }
};

const tryCleanupTempFiles = () => {
  for (const filePath of tempOpenFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best effort; file may be open by another process.
    }
  }
  tempOpenFiles.clear();
  try {
    const root = tempRoot();
    if (fs.existsSync(root)) {
      // Remove leftovers from previous runs.
      for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name);
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
};

const deletePlaintextDbAfterVerifiedMigration = () => {
  const plain = dbPlainPath();
  if (!fs.existsSync(plain)) return false;
  try {
    fs.unlinkSync(plain);
    return true;
  } catch (error) {
    console.error("Failed to remove plaintext DB after migration", error);
    return false;
  }
};

const migrateAttachmentsToEncryptedIfNeeded = async () => {
  assertUnlocked();
  const baseDir = attachmentsRoot();
  if (!fs.existsSync(baseDir)) return 0;

  const rows = all("SELECT * FROM attachments");
  let migrated = 0;

  for (const attachment of rows) {
    try {
      const rel = String(attachment.storedRelativePath || "");
      if (!rel || rel.endsWith(".enc")) continue;

      const fullPath = path.resolve(baseDir, rel);
      if (!isContainedPath(fullPath, baseDir) || !fs.existsSync(fullPath)) continue;

      const oldStoredFileName = String(attachment.storedFileName || "");
      const oldRel = rel;
      const ext = path.extname(String(attachment.originalFileName || "")) || path.extname(rel) || "";
      const newStoredFileName = `${randomUUID()}${ext}.enc`;
      const newRel = path.join(String(attachment.projectId), newStoredFileName);
      const targetPath = path.resolve(baseDir, newRel);

      const attachmentsDir = getSafeProjectAttachmentDir(String(attachment.projectId));
      if (!attachmentsDir) continue;
      ensureDir(attachmentsDir);
      if (!isContainedPath(targetPath, attachmentsDir)) continue;

      await encryptAttachmentFile(fullPath, targetPath, vaultState.vault.fileKey);

      run(
        "UPDATE attachments SET storedFileName = ?, storedRelativePath = ? WHERE id = ?",
        [newStoredFileName, newRel, attachment.id]
      );

      try {
        persistDbOrThrow();
        fs.unlinkSync(fullPath);
        migrated += 1;
      } catch (error) {
        // Roll back DB metadata and remove the newly created encrypted file.
        console.error("Failed to persist DB after attachment migration; rolling back", error);
        try {
          run("UPDATE attachments SET storedFileName = ?, storedRelativePath = ? WHERE id = ?", [
            oldStoredFileName,
            oldRel,
            attachment.id
          ]);
          persistDb();
        } catch {
          // ignore
        }
        try {
          if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        } catch {
          // ignore
        }
      }
    } catch (error) {
      console.error("Failed to migrate attachment to encrypted storage", error);
    }
  }

  return migrated;
};

const unlockVault = async (passphrase) => {
  if (!ENCRYPTION_ENABLED) {
    if (!db) {
      await initDatabase();
    }
    vaultState.locked = false;
    return { ok: true, migratedDb: false, migratedAttachments: 0 };
  }

  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`);
  }

  const plainPath = dbPlainPath();

  let migratedDb = false;
  let dbBytes = null;
  let unlockSource = null;
  let seededLegacyAttachments = 0;

  const encryptedCandidates = listEncryptedDbCandidates();
  if (encryptedCandidates.length > 0) {
    let opened = null;
    let lastError = null;
    for (const candidate of encryptedCandidates) {
      try {
        const envelope = fs.readFileSync(candidate.dbPath);
        opened = vaultCrypto.openVaultFromDatabaseEnvelope(envelope, passphrase);
        unlockSource = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!opened) {
      if (isDecryptAuthError(lastError)) {
        throw new Error("Unable to unlock vault. The passphrase may be incorrect or the encrypted database may be corrupted.");
      }
      throw lastError || new Error("Unable to unlock vault.");
    }
    vaultState.vault = opened.vault;
    dbBytes = opened.plaintext;
  } else {
    // First-time setup (or plaintext migration). Create new KDF salt/params deterministically for this vault.
    const salt = crypto.randomBytes(16);
    vaultState.vault = vaultCrypto.deriveKeysFromPassphrase(passphrase, salt, vaultCrypto.DEFAULT_SCRYPT_PARAMS);
    if (fs.existsSync(plainPath)) {
      dbBytes = fs.readFileSync(plainPath);
      migratedDb = true;
    } else {
      dbBytes = null;
    }
  }

  await initDatabase(dbBytes);
  vaultState.locked = false;

  if (unlockSource && unlockSource.source === "legacy") {
    const sourceAttachmentsRoot = path.resolve(unlockSource.userDataRoot, "attachments");
    const targetAttachmentsRoot = attachmentsRoot();
    if (
      sourceAttachmentsRoot !== targetAttachmentsRoot &&
      fs.existsSync(sourceAttachmentsRoot) &&
      countFilesRecursive(targetAttachmentsRoot) === 0
    ) {
      seededLegacyAttachments = copyDirRecursive(sourceAttachmentsRoot, targetAttachmentsRoot);
    }
  }

  // Ensure we write an encrypted DB file immediately (creates it on first-run, or after plaintext migration).
  persistDbOrThrow();

  // Verify the written file can be decrypted with the provided passphrase before deleting plaintext data.
  try {
    const written = fs.readFileSync(dbEncPath());
    vaultCrypto.openVaultFromDatabaseEnvelope(written, passphrase);
  } catch (error) {
    console.error("Encrypted DB verification failed", error);
    throw new Error("Encrypted database write verification failed.");
  }

  if (migratedDb) {
    deletePlaintextDbAfterVerifiedMigration();
  }

  const migratedAttachments = await migrateAttachmentsToEncryptedIfNeeded();
  const unlockSourceLabel = describeUnlockSource(unlockSource);
  recordAudit({
    action: "vault.unlock",
    entityType: "vault",
    details: { migratedDb, migratedAttachments, unlockSource: unlockSourceLabel, seededLegacyAttachments },
    persist: true
  });
  return { ok: true, migratedDb, migratedAttachments, unlockSource: unlockSourceLabel, seededLegacyAttachments };
};

const lockVault = () => {
  if (!ENCRYPTION_ENABLED) {
    try {
      persistDb();
    } catch {
      // ignore
    }
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    db = null;
    vaultState.locked = false;
    tryCleanupTempFiles();
    return true;
  }

  // Persist/close while we still have the vault keys available.
  if (db && !vaultState.locked) {
    recordAudit({
      action: "vault.lock",
      entityType: "vault",
      persist: false
    });
    try {
      persistDb();
    } catch {
      // ignore
    }
  }
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  db = null;
  if (vaultState.vault) {
    vaultCrypto.destroyKeyMaterial(vaultState.vault);
  }
  vaultState.vault = null;
  vaultState.locked = true;
  tryCleanupTempFiles();
  return true;
};

const buildNotesMarkdown = (project, notes) => {
  const lines = [];
  lines.push(`# ${project.matterName}`);
  lines.push("");
  lines.push(`Client: ${project.clientName}`);
  lines.push(`Billing: ${project.billingCode}`);
  if (project.relativityUrl) {
    lines.push(`Relativity: ${project.relativityUrl}`);
  }
  lines.push("");

  notes.forEach((note) => {
    lines.push(`## ${note.title}`);
    lines.push(`Date: ${note.noteDate}`);
    lines.push("");
    const contentLines = String(note.contentMarkdown || "").split("\n");
    contentLines.forEach((line) => lines.push(line));
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
};

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderMarkdownLineAsHtml = (line) => {
  const safe = escapeHtml(line);
  if (!safe.trim()) return "<p class=\"note-empty\"></p>";
  const heading = safe.match(/^(#{1,4})\s+(.+)$/);
  if (heading) {
    const level = Math.max(1, Math.min(4, heading[1].length));
    return `<h${level}>${heading[2]}</h${level}>`;
  }
  const bullet = safe.match(/^\s*[-*•]\s+(.+)$/);
  if (bullet) {
    return `<li>${bullet[1]}</li>`;
  }
  return `<p>${safe}</p>`;
};

const buildNotesPdfHtml = (project, notes) => {
  const noteSections = notes
    .map((note) => {
      const lines = String(note.contentMarkdown || "").split("\n");
      const renderedLines = [];
      let inList = false;
      for (const line of lines) {
        const candidate = renderMarkdownLineAsHtml(line);
        if (candidate.startsWith("<li>")) {
          if (!inList) {
            renderedLines.push("<ul>");
            inList = true;
          }
          renderedLines.push(candidate);
          continue;
        }
        if (inList) {
          renderedLines.push("</ul>");
          inList = false;
        }
        renderedLines.push(candidate);
      }
      if (inList) renderedLines.push("</ul>");
      return `
        <section class="note-block">
          <h2>${escapeHtml(note.title)}</h2>
          <p class="note-date">Date: ${escapeHtml(note.noteDate)}</p>
          ${renderedLines.join("\n")}
        </section>
      `;
    })
    .join("\n");

  const relativityRow = project.relativityUrl
    ? `<p class="meta">Relativity: ${escapeHtml(project.relativityUrl)}</p>`
    : "";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(project.matterName)} Notes</title>
      <style>
        :root { color-scheme: light; }
        body {
          font-family: "Segoe UI", "Avenir Next", sans-serif;
          color: #111827;
          margin: 28px 34px;
          line-height: 1.45;
          font-size: 12px;
        }
        h1 {
          margin: 0 0 6px;
          font-size: 23px;
        }
        h2 {
          margin: 0 0 6px;
          font-size: 16px;
        }
        h3 {
          margin: 10px 0 4px;
          font-size: 14px;
        }
        h4 {
          margin: 8px 0 4px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .meta {
          margin: 0;
          color: #4b5563;
          font-size: 11px;
        }
        .note-date {
          margin: 0 0 8px;
          color: #6b7280;
          font-size: 11px;
        }
        .note-block {
          border-top: 1px solid #e5e7eb;
          padding-top: 14px;
          margin-top: 14px;
          break-inside: avoid-page;
        }
        ul {
          margin: 2px 0 8px 18px;
          padding: 0;
        }
        p {
          margin: 0 0 6px;
          white-space: pre-wrap;
        }
        .note-empty { min-height: 8px; margin: 0 0 4px; }
      </style>
    </head>
    <body>
      <header>
        <h1>${escapeHtml(project.matterName)}</h1>
        <p class="meta">${escapeHtml(project.clientName)} · Billing ${escapeHtml(project.billingCode)}</p>
        ${relativityRow}
      </header>
      ${noteSections || "<p>No notes available.</p>"}
    </body>
  </html>
  `;
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#10151f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(__dirname, "..", "dist", "index.html");
    mainWindow.loadFile(indexPath);
  }
};

const registerIpc = () => {
  ipcMain.handle("vault:status", () => {
    return {
      locked: vaultState.locked,
      hasEncryptedDb: hasEncryptedDb(),
      hasPlaintextDb: hasPlaintextDb()
    };
  });

  ipcMain.handle("vault:unlock", async (_event, passphrase) => {
    if (!vaultState.locked) {
      return { ok: true, migratedDb: false, migratedAttachments: 0 };
    }
    return unlockVault(passphrase);
  });

  ipcMain.handle("vault:lock", () => {
    return lockVault();
  });

  ipcMain.handle("projects:list", (_event, includeArchived = false) => {
    assertUnlocked();
    const includeArchivedSafe = Boolean(includeArchived);
    return includeArchivedSafe
      ? all("SELECT * FROM projects ORDER BY isPinned DESC, updatedAt DESC")
      : all("SELECT * FROM projects WHERE archivedAt IS NULL ORDER BY isPinned DESC, updatedAt DESC");
  });

  ipcMain.handle("projects:get", (_event, projectId) => {
    assertUnlocked();
    if (!isValidProjectId(projectId)) {
      return null;
    }
    return get("SELECT * FROM projects WHERE id = ?", [projectId]);
  });

  ipcMain.handle("projects:create", (_event, data) => {
    assertUnlocked();
    const payload = sanitizeProjectInput(data);
    const id = randomUUID();
    const timestamp = nowIso();
    run(
      `INSERT INTO projects
      (id, matterName, clientName, billingCode, startDate, productionDeadline, relativityUrl, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        id,
        payload.matterName,
        payload.clientName,
        payload.billingCode,
        payload.startDate,
        payload.productionDeadline,
        payload.relativityUrl,
        timestamp,
        timestamp
      ]
    );
    recordAudit({
      action: "project.create",
      entityType: "project",
      entityId: id,
      projectId: id,
      details: { matterName: payload.matterName, clientName: payload.clientName, billingCode: payload.billingCode }
    });
    persistDb();
    return get("SELECT * FROM projects WHERE id = ?", [id]);
  });

  ipcMain.handle("projects:update", (_event, projectId, data) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const payload = sanitizeProjectInput(data);
    const timestamp = nowIso();
    run(
      `UPDATE projects
      SET matterName = ?, clientName = ?, billingCode = ?, startDate = ?, productionDeadline = ?, relativityUrl = ?, updatedAt = ?
      WHERE id = ?`,
      [
        payload.matterName,
        payload.clientName,
        payload.billingCode,
        payload.startDate,
        payload.productionDeadline,
        payload.relativityUrl,
        timestamp,
        safeProjectId
      ]
    );
    recordAudit({
      action: "project.update",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId,
      details: { matterName: payload.matterName, clientName: payload.clientName, billingCode: payload.billingCode }
    });
    persistDb();
    return get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
  });

  ipcMain.handle("projects:archive", (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const timestamp = nowIso();
    run("UPDATE projects SET archivedAt = ?, updatedAt = ? WHERE id = ?", [timestamp, timestamp, safeProjectId]);
    recordAudit({
      action: "project.archive",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId
    });
    persistDb();
    return true;
  });

  ipcMain.handle("projects:restore", (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const timestamp = nowIso();
    run("UPDATE projects SET archivedAt = NULL, updatedAt = ? WHERE id = ?", [timestamp, safeProjectId]);
    recordAudit({
      action: "project.restore",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId
    });
    persistDb();
    return get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
  });

  ipcMain.handle("projects:pin", (_event, projectId, isPinned) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const safePinned = ensureBoolean(isPinned, "Pinned state");
    const timestamp = nowIso();
    run("UPDATE projects SET isPinned = ?, updatedAt = ? WHERE id = ?", [safePinned ? 1 : 0, timestamp, safeProjectId]);
    recordAudit({
      action: "project.pin",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId,
      details: { isPinned: safePinned }
    });
    persistDb();
    return get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
  });

  ipcMain.handle("notes:list", (_event, projectId) => {
    assertUnlocked();
    if (!isValidProjectId(projectId)) {
      return [];
    }
    return all("SELECT * FROM notes WHERE projectId = ? ORDER BY noteDate DESC, createdAt DESC", [projectId]);
  });

  ipcMain.handle("notes:create", (_event, projectId, data) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const payload = sanitizeNoteInput(data);
    const id = randomUUID();
    const timestamp = nowIso();
    run(
      `INSERT INTO notes
      (id, projectId, title, noteDate, contentMarkdown, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, safeProjectId, payload.title, payload.noteDate, payload.contentMarkdown, timestamp, timestamp]
    );
    recordAudit({
      action: "note.create",
      entityType: "note",
      entityId: id,
      projectId: safeProjectId,
      details: { title: payload.title, noteDate: payload.noteDate, contentLength: payload.contentMarkdown.length }
    });
    persistDb();
    return get("SELECT * FROM notes WHERE id = ?", [id]);
  });

  ipcMain.handle("notes:update", (_event, noteId, data) => {
    assertUnlocked();
    const safeNoteId = assertUuid(noteId, "note ID");
    const payload = sanitizeNoteInput(data);
    const timestamp = nowIso();
    run(
      "UPDATE notes SET title = ?, contentMarkdown = ?, updatedAt = ? WHERE id = ?",
      [payload.title, payload.contentMarkdown, timestamp, safeNoteId]
    );
    const current = get("SELECT projectId FROM notes WHERE id = ?", [safeNoteId]);
    recordAudit({
      action: "note.update",
      entityType: "note",
      entityId: safeNoteId,
      projectId: current?.projectId || null,
      details: { title: payload.title, contentLength: payload.contentMarkdown.length }
    });
    persistDb();
    return get("SELECT * FROM notes WHERE id = ?", [safeNoteId]);
  });

  ipcMain.handle("notes:delete", (_event, noteId) => {
    assertUnlocked();
    const safeNoteId = assertUuid(noteId, "note ID");
    const current = get("SELECT projectId, title FROM notes WHERE id = ?", [safeNoteId]);
    run("DELETE FROM notes WHERE id = ?", [safeNoteId]);
    recordAudit({
      action: "note.delete",
      entityType: "note",
      entityId: safeNoteId,
      projectId: current?.projectId || null,
      details: { title: current?.title || null }
    });
    persistDb();
    return true;
  });

  ipcMain.handle("todos:list", (_event, projectId) => {
    assertUnlocked();
    if (!isValidProjectId(projectId)) {
      return [];
    }
    return all("SELECT * FROM todos WHERE projectId = ? ORDER BY createdAt ASC", [projectId]);
  });

  ipcMain.handle("todos:create", (_event, projectId, data) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const payload = sanitizeTodoInput(data);
    const id = randomUUID();
    const timestamp = nowIso();
    run(
      "INSERT INTO todos (id, projectId, text, isCompleted, isPriority, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      [id, safeProjectId, payload.text, payload.isCompleted ? 1 : 0, payload.isPriority ? 1 : 0, timestamp]
    );
    recordAudit({
      action: "todo.create",
      entityType: "todo",
      entityId: id,
      projectId: safeProjectId,
      details: { isPriority: payload.isPriority, isCompleted: payload.isCompleted }
    });
    persistDb();
    return get("SELECT * FROM todos WHERE id = ?", [id]);
  });

  ipcMain.handle("todos:update", (_event, todoId, data) => {
    assertUnlocked();
    const safeTodoId = assertUuid(todoId, "to-do ID");
    const current = get("SELECT projectId FROM todos WHERE id = ?", [safeTodoId]);
    const payload = sanitizeTodoInput(data);
    const completedAt = payload.isCompleted ? nowIso() : null;
    run(
      "UPDATE todos SET text = ?, isCompleted = ?, isPriority = ?, completedAt = ? WHERE id = ?",
      [payload.text, payload.isCompleted ? 1 : 0, payload.isPriority ? 1 : 0, completedAt, safeTodoId]
    );
    recordAudit({
      action: "todo.update",
      entityType: "todo",
      entityId: safeTodoId,
      projectId: current?.projectId || null,
      details: { isPriority: payload.isPriority, isCompleted: payload.isCompleted }
    });
    persistDb();
    return get("SELECT * FROM todos WHERE id = ?", [safeTodoId]);
  });

  ipcMain.handle("todos:delete", (_event, todoId) => {
    assertUnlocked();
    const safeTodoId = assertUuid(todoId, "to-do ID");
    const current = get("SELECT projectId FROM todos WHERE id = ?", [safeTodoId]);
    run("DELETE FROM todos WHERE id = ?", [safeTodoId]);
    recordAudit({
      action: "todo.delete",
      entityType: "todo",
      entityId: safeTodoId,
      projectId: current?.projectId || null
    });
    persistDb();
    return true;
  });

  ipcMain.handle("search:global", (_event, rawQuery) => {
    assertUnlocked();
    const query = String(rawQuery || "").trim().toLowerCase();
    if (!query) {
      return { query: "", projects: [], notes: [], todos: [], attachments: [] };
    }

    const projects = all(
      "SELECT id, matterName, clientName, billingCode, archivedAt FROM projects ORDER BY updatedAt DESC"
    );
    const projectById = new Map(projects.map((project) => [project.id, project]));

    const projectHits = projects
      .filter((project) => includesQuery(query, project.matterName, project.clientName, project.billingCode))
      .slice(0, 12)
      .map((project) => ({
        id: project.id,
        matterName: project.matterName,
        clientName: project.clientName,
        billingCode: project.billingCode
      }));

    const noteHits = [];
    for (const note of all("SELECT id, projectId, title, contentMarkdown, noteDate, updatedAt FROM notes ORDER BY updatedAt DESC")) {
      if (!projectById.has(note.projectId)) continue;
      if (!includesQuery(query, note.title, note.contentMarkdown, note.noteDate)) continue;
      const project = projectById.get(note.projectId);
      noteHits.push({
        id: note.id,
        projectId: note.projectId,
        projectName: project?.matterName || "Unknown Project",
        title: note.title,
        noteDate: note.noteDate,
        snippet: makeSnippet(note.contentMarkdown, query)
      });
      if (noteHits.length >= 20) break;
    }

    const todoHits = [];
    for (const todo of all("SELECT id, projectId, text, isCompleted, isPriority, createdAt FROM todos ORDER BY createdAt DESC")) {
      if (!projectById.has(todo.projectId)) continue;
      if (!includesQuery(query, todo.text)) continue;
      const project = projectById.get(todo.projectId);
      todoHits.push({
        id: todo.id,
        projectId: todo.projectId,
        projectName: project?.matterName || "Unknown Project",
        text: todo.text,
        isCompleted: todo.isCompleted,
        isPriority: todo.isPriority
      });
      if (todoHits.length >= 20) break;
    }

    const attachmentHits = [];
    for (const attachment of all("SELECT id, projectId, originalFileName, sizeBytes, addedAt FROM attachments ORDER BY addedAt DESC")) {
      if (!projectById.has(attachment.projectId)) continue;
      if (!includesQuery(query, attachment.originalFileName, attachment.addedAt)) continue;
      const project = projectById.get(attachment.projectId);
      attachmentHits.push({
        id: attachment.id,
        projectId: attachment.projectId,
        projectName: project?.matterName || "Unknown Project",
        originalFileName: attachment.originalFileName,
        sizeBytes: Number(attachment.sizeBytes || 0),
        addedAt: attachment.addedAt
      });
      if (attachmentHits.length >= 20) break;
    }

    return {
      query,
      projects: projectHits,
      notes: noteHits,
      todos: todoHits,
      attachments: attachmentHits
    };
  });

  ipcMain.handle("attachments:list", (_event, projectId) => {
    assertUnlocked();
    if (!isValidProjectId(projectId)) {
      return [];
    }
    return all("SELECT * FROM attachments WHERE projectId = ? ORDER BY addedAt DESC", [projectId]);
  });

  ipcMain.handle("attachments:add", async (_event, projectId, filePaths) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const attachmentsDir = getSafeProjectAttachmentDir(safeProjectId);
    if (!attachmentsDir || !Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 100) {
      return [];
    }
    ensureDir(attachmentsDir);

    const inserted = [];
    for (const sourcePath of filePaths) {
      try {
        if (typeof sourcePath !== "string" || sourcePath.length === 0) {
          continue;
        }
        const resolvedSourcePath = path.resolve(sourcePath);
        if (!fs.existsSync(resolvedSourcePath)) {
          continue;
        }
        const sourceStat = fs.statSync(resolvedSourcePath);
        if (!sourceStat.isFile()) {
          continue;
        }
        if (sourceStat.size > 1024 * 1024 * 1024) {
          // Limit individual files to 1GB to avoid abuse and accidental resource exhaustion.
          continue;
        }
        const originalFileName = path.basename(resolvedSourcePath);
        const ext = path.extname(originalFileName);
        const storedFileName = ENCRYPTION_ENABLED ? `${randomUUID()}${ext}.enc` : `${randomUUID()}${ext}`;
        const storedRelativePath = path.join(safeProjectId, storedFileName);
        const destPath = path.resolve(attachmentsDir, storedFileName);
        if (!isContainedPath(destPath, attachmentsDir)) {
          continue;
        }

        if (ENCRYPTION_ENABLED) {
          await encryptAttachmentFile(resolvedSourcePath, destPath, vaultState.vault.fileKey);
        } else {
          fs.copyFileSync(resolvedSourcePath, destPath);
        }
        const id = randomUUID();
        const addedAt = nowIso();

        run(
          `INSERT INTO attachments
          (id, projectId, originalFileName, storedFileName, storedRelativePath, sizeBytes, addedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, safeProjectId, originalFileName, storedFileName, storedRelativePath, sourceStat.size, addedAt]
        );
        recordAudit({
          action: "attachment.add",
          entityType: "attachment",
          entityId: id,
          projectId: safeProjectId,
          details: { originalFileName, sizeBytes: sourceStat.size }
        });

        inserted.push(get("SELECT * FROM attachments WHERE id = ?", [id]));
      } catch (error) {
        console.error("Failed to add attachment", error);
      }
    }

    persistDb();
    return inserted;
  });

  ipcMain.handle("attachments:open", async (_event, attachmentId) => {
    assertUnlocked();
    const safeAttachmentId = assertUuid(attachmentId, "attachment ID");
    const attachment = get("SELECT * FROM attachments WHERE id = ?", [safeAttachmentId]);
    if (!attachment) {
      return false;
    }
    const baseDir = attachmentsRoot();
    const fullPath = path.resolve(baseDir, attachment.storedRelativePath);
    if (!isContainedPath(fullPath, baseDir) || !fs.existsSync(fullPath)) {
      return false;
    }
    try {
      if (ENCRYPTION_ENABLED) {
        ensureDir(tempRoot());
        const ext = path.extname(String(attachment.originalFileName || "")) || "";
        const tempPath = path.resolve(tempRoot(), `${randomUUID()}${ext}`);
        await decryptAttachmentFile(fullPath, tempPath, vaultState.vault.fileKey);
        tempOpenFiles.add(tempPath);
        shell.openPath(tempPath);
      } else {
        shell.openPath(fullPath);
      }
      recordAudit({
        action: "attachment.open",
        entityType: "attachment",
        entityId: safeAttachmentId,
        projectId: attachment.projectId,
        details: { originalFileName: attachment.originalFileName },
        persist: true
      });
    } catch (error) {
      console.error("Failed to open attachment", error);
      return false;
    }
    return true;
  });

  ipcMain.handle("attachments:preview", async (_event, attachmentId) => {
    assertUnlocked();
    const safeAttachmentId = assertUuid(attachmentId, "attachment ID");
    const attachment = get("SELECT * FROM attachments WHERE id = ?", [safeAttachmentId]);
    if (!attachment) {
      return { ok: false, error: "Attachment not found." };
    }

    const baseDir = attachmentsRoot();
    const fullPath = path.resolve(baseDir, String(attachment.storedRelativePath || ""));
    if (!isContainedPath(fullPath, baseDir) || !fs.existsSync(fullPath)) {
      return { ok: false, error: "Attachment file is missing." };
    }

    const ext = path.extname(String(attachment.originalFileName || "")).toLowerCase();
    const isImage = PREVIEW_IMAGE_EXTENSIONS.has(ext);
    const isPdf = ext === ".pdf";
    const kind = isImage ? "image" : isPdf ? "pdf" : "meta";
    const sourceStat = fs.statSync(fullPath);

    let previewPath = null;
    if (kind !== "meta") {
      if (ENCRYPTION_ENABLED) {
        ensureDir(tempRoot());
        previewPath = path.resolve(tempRoot(), `${randomUUID()}${ext || ".tmp"}`);
        await decryptAttachmentFile(fullPath, previewPath, vaultState.vault.fileKey);
        tempOpenFiles.add(previewPath);
      } else {
        previewPath = fullPath;
      }
    }

    const result = {
      ok: true,
      kind,
      url: previewPath ? pathToFileURL(previewPath).toString() : null,
      metadata: {
        id: attachment.id,
        projectId: attachment.projectId,
        originalFileName: attachment.originalFileName,
        sizeBytes: Number(attachment.sizeBytes || sourceStat.size || 0),
        addedAt: attachment.addedAt,
        extension: ext || "",
        isEncryptedAtRest: ENCRYPTION_ENABLED
      }
    };
    recordAudit({
      action: "attachment.preview",
      entityType: "attachment",
      entityId: safeAttachmentId,
      projectId: attachment.projectId,
      details: { kind, originalFileName: attachment.originalFileName },
      persist: true
    });
    return result;
  });

  ipcMain.handle("attachments:reveal", (_event, attachmentId) => {
    assertUnlocked();
    const safeAttachmentId = assertUuid(attachmentId, "attachment ID");
    const attachment = get("SELECT * FROM attachments WHERE id = ?", [safeAttachmentId]);
    if (!attachment) {
      return false;
    }
    const baseDir = attachmentsRoot();
    const fullPath = path.resolve(baseDir, attachment.storedRelativePath);
    if (!isContainedPath(fullPath, baseDir) || !fs.existsSync(fullPath)) {
      return false;
    }
    shell.showItemInFolder(fullPath);
    recordAudit({
      action: "attachment.reveal",
      entityType: "attachment",
      entityId: safeAttachmentId,
      projectId: attachment.projectId,
      details: { originalFileName: attachment.originalFileName },
      persist: true
    });
    return true;
  });

  ipcMain.handle("attachments:delete", (_event, attachmentId) => {
    assertUnlocked();
    const safeAttachmentId = assertUuid(attachmentId, "attachment ID");
    const attachment = get("SELECT * FROM attachments WHERE id = ?", [safeAttachmentId]);
    if (!attachment) {
      return false;
    }
    const baseDir = attachmentsRoot();
    const fullPath = path.resolve(baseDir, attachment.storedRelativePath);
    if (isContainedPath(fullPath, baseDir) && fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (error) {
        console.error("Failed to delete attachment file", error);
      }
    }
    run("DELETE FROM attachments WHERE id = ?", [safeAttachmentId]);
    recordAudit({
      action: "attachment.delete",
      entityType: "attachment",
      entityId: safeAttachmentId,
      projectId: attachment.projectId,
      details: { originalFileName: attachment.originalFileName, sizeBytes: Number(attachment.sizeBytes || 0) }
    });
    persistDb();
    return true;
  });

  ipcMain.handle("timeline:list", (_event, projectId) => {
    assertUnlocked();
    if (projectId) {
      if (!isValidProjectId(projectId)) {
        return [];
      }
      return all("SELECT * FROM timeline_tasks WHERE projectId = ? ORDER BY updatedAt DESC", [projectId]);
    }
    return all("SELECT * FROM timeline_tasks ORDER BY updatedAt DESC");
  });

  ipcMain.handle("timeline:upsert", (_event, projectId, data) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const payload = sanitizeTimelineInput(data);
    const startDate = payload.startDate;
    const endDate = payload.endDate;

    if (!startDate && !endDate) {
      run("DELETE FROM timeline_tasks WHERE projectId = ? AND phase = ?", [safeProjectId, payload.phase]);
      recordAudit({
        action: "timeline.delete",
        entityType: "timeline_task",
        projectId: safeProjectId,
        details: { phase: payload.phase }
      });
      persistDb();
      return null;
    }

    const existing = get("SELECT * FROM timeline_tasks WHERE projectId = ? AND phase = ?", [safeProjectId, payload.phase]);
    const timestamp = nowIso();

    if (existing) {
      run(
        "UPDATE timeline_tasks SET startDate = ?, endDate = ?, updatedAt = ? WHERE id = ?",
        [startDate, endDate, timestamp, existing.id]
      );
      recordAudit({
        action: "timeline.update",
        entityType: "timeline_task",
        entityId: existing.id,
        projectId: safeProjectId,
        details: { phase: payload.phase, startDate, endDate }
      });
      persistDb();
      return get("SELECT * FROM timeline_tasks WHERE id = ?", [existing.id]);
    }

    const id = randomUUID();
    run(
      `INSERT INTO timeline_tasks
      (id, projectId, phase, startDate, endDate, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, safeProjectId, payload.phase, startDate, endDate, timestamp, timestamp]
    );
    recordAudit({
      action: "timeline.create",
      entityType: "timeline_task",
      entityId: id,
      projectId: safeProjectId,
      details: { phase: payload.phase, startDate, endDate }
    });
    persistDb();
    return get("SELECT * FROM timeline_tasks WHERE id = ?", [id]);
  });

  ipcMain.handle("dialog:openFiles", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) {
      return [];
    }
    return result.filePaths;
  });

  ipcMain.handle("system:openExternal", async (_event, targetUrl) => {
    try {
      const safeUrl = ensureHttpUrl(targetUrl, "External URL");
      await shell.openExternal(safeUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("backup:status", () => {
    return getBackupStatus();
  });

  ipcMain.handle("backup:createSnapshot", (_event, reason = "manual") => {
    try {
      const snapshot = createLocalSnapshot(String(reason || "manual"));
      recordAudit({
        action: "backup.snapshot.create",
        entityType: "snapshot",
        entityId: snapshot.id,
        details: { reason: snapshot.reason, attachmentFiles: snapshot.attachmentFiles },
        persist: true
      });
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, error: error?.message || "Failed to create snapshot." };
    }
  });

  ipcMain.handle("backup:listSnapshots", (_event, limit = 20) => {
    return listLocalSnapshots(limit);
  });

  ipcMain.handle("backup:restoreSnapshot", (_event, snapshotId) => {
    try {
      recordAudit({
        action: "backup.snapshot.restore.request",
        entityType: "snapshot",
        entityId: String(snapshotId || ""),
        persist: true
      });
      const snapshotDir = resolveSnapshotDir(snapshotId);
      const result = restoreFromBackupFolder(snapshotDir, "snapshot");
      if (!result.ok) return result;
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 150);
      return result;
    } catch (error) {
      return { ok: false, error: error?.message || "Snapshot restore failed." };
    }
  });

  ipcMain.handle("backup:export", async () => {
    assertUnlocked();
    persistDbOrThrow();

    const result = await dialog.showOpenDialog({
      title: "Choose Backup Destination",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const selectedDir = result.filePaths[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.resolve(selectedDir, `edisconotes-backup-${stamp}`);
    ensureDir(backupDir);

    const dbStatus = getDatabaseFileStatus();
    if (!dbStatus.dbPath || !fs.existsSync(dbStatus.dbPath)) {
      return { ok: false, error: "No database file found." };
    }
    const dbFileName = path.basename(dbStatus.dbPath);
    fs.copyFileSync(dbStatus.dbPath, path.join(backupDir, dbFileName));

    const attachmentSource = attachmentsRoot();
    const attachmentTarget = path.join(backupDir, "attachments");
    const copiedAttachments = copyDirRecursive(attachmentSource, attachmentTarget);
    const createdAt = nowIso();
    const manifest = {
      createdAt,
      dbFileName,
      encryptedDatabase: dbStatus.encrypted,
      attachmentFiles: copiedAttachments
    };
    writeJsonFile(path.join(backupDir, "manifest.json"), manifest);
    const existingMeta = readJsonFile(backupMetaPath()) || {};
    writeJsonFile(backupMetaPath(), {
      ...existingMeta,
      lastBackupAt: createdAt,
      lastBackupPath: backupDir
    });
    recordAudit({
      action: "backup.export",
      entityType: "backup",
      details: { backupPath: backupDir, attachmentFiles: copiedAttachments },
      persist: true
    });

    return {
      ok: true,
      backupPath: backupDir,
      createdAt,
      attachmentFiles: copiedAttachments
    };
  });

  ipcMain.handle("backup:restore", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select Backup Folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const backupDir = result.filePaths[0];
    recordAudit({
      action: "backup.restore.request",
      entityType: "backup",
      details: { backupPath: backupDir },
      persist: true
    });
    const restoreResult = restoreFromBackupFolder(backupDir, "backup");
    if (!restoreResult.ok) {
      return restoreResult;
    }

    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 150);

    return restoreResult;
  });

  ipcMain.handle("projects:exportBundle", async (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const project = get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
    if (!project) {
      return { ok: false, error: "Project not found." };
    }

    const notes = all("SELECT * FROM notes WHERE projectId = ? ORDER BY noteDate DESC, createdAt DESC", [safeProjectId]);
    const todos = all("SELECT * FROM todos WHERE projectId = ? ORDER BY createdAt ASC", [safeProjectId]);
    const timelineTasks = all("SELECT * FROM timeline_tasks WHERE projectId = ? ORDER BY updatedAt DESC", [safeProjectId]);
    const attachments = all("SELECT * FROM attachments WHERE projectId = ? ORDER BY addedAt DESC", [safeProjectId]);

    const bundleAttachments = [];
    let exportedAttachments = 0;
    for (const attachment of attachments) {
      try {
        const bytes = await readAttachmentPlaintextBuffer(attachment);
        if (!bytes) continue;
        bundleAttachments.push({
          originalFileName: attachment.originalFileName,
          addedAt: attachment.addedAt,
          sizeBytes: Number(attachment.sizeBytes || bytes.length),
          dataBase64: bytes.toString("base64")
        });
        exportedAttachments += 1;
      } catch (error) {
        console.error("Failed to include attachment in project bundle", error);
      }
    }

    const bundle = {
      format: PROJECT_BUNDLE_FORMAT,
      version: PROJECT_BUNDLE_VERSION,
      exportedAt: nowIso(),
      project: {
        matterName: project.matterName,
        clientName: project.clientName,
        billingCode: project.billingCode,
        startDate: project.startDate,
        productionDeadline: project.productionDeadline,
        relativityUrl: project.relativityUrl || null
      },
      notes: notes.map((item) => ({
        title: item.title,
        noteDate: item.noteDate,
        contentMarkdown: item.contentMarkdown,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      todos: todos.map((item) => ({
        text: item.text,
        isCompleted: Boolean(item.isCompleted),
        isPriority: Boolean(item.isPriority),
        createdAt: item.createdAt,
        completedAt: item.completedAt || null
      })),
      timelineTasks: timelineTasks.map((item) => ({
        phase: item.phase,
        startDate: item.startDate || null,
        endDate: item.endDate || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      attachments: bundleAttachments
    };

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Project Bundle",
      defaultPath: `${project.matterName.replace(/[^a-z0-9-_]+/gi, "_")}.ediscobundle`,
      filters: [{ name: "eDisco Project Bundle", extensions: ["ediscobundle", "json"] }]
    });

    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    recordAudit({
      action: "project.bundle.export",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId,
      details: { filePath, notes: notes.length, todos: todos.length, attachments: exportedAttachments },
      persist: true
    });
    return {
      ok: true,
      filePath,
      notes: notes.length,
      todos: todos.length,
      attachments: exportedAttachments
    };
  });

  ipcMain.handle("projects:importBundle", async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog({
      title: "Import Project Bundle",
      properties: ["openFile"],
      filters: [{ name: "eDisco Project Bundle", extensions: ["ediscobundle", "json"] }]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const bundlePath = result.filePaths[0];
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    } catch {
      return { ok: false, error: "Bundle file is not valid JSON." };
    }
    if (!payload || payload.format !== PROJECT_BUNDLE_FORMAT || Number(payload.version) !== PROJECT_BUNDLE_VERSION) {
      return { ok: false, error: "Bundle format is not supported." };
    }
    if (!payload.project || typeof payload.project !== "object") {
      return { ok: false, error: "Bundle project payload is missing." };
    }

    const importedProject = {
      matterName: findUniqueImportedMatterName(String(payload.project.matterName || "Imported Matter")),
      clientName: ensureText(String(payload.project.clientName || "Imported Client"), "Client name", { maxLen: 200 }),
      billingCode: ensureText(String(payload.project.billingCode || "IMPORTED"), "Billing code", { maxLen: 120 }),
      startDate: ensureIsoDate(String(payload.project.startDate || new Date().toISOString().slice(0, 10)), "Start date"),
      productionDeadline: ensureIsoDate(
        String(payload.project.productionDeadline || new Date().toISOString().slice(0, 10)),
        "Production deadline"
      ),
      relativityUrl: payload.project.relativityUrl ? ensureHttpUrl(payload.project.relativityUrl, "Relativity URL", { allowNull: true }) : null
    };

    const projectId = randomUUID();
    const timestamp = nowIso();
    run(
      `INSERT INTO projects
      (id, matterName, clientName, billingCode, startDate, productionDeadline, relativityUrl, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        importedProject.matterName,
        importedProject.clientName,
        importedProject.billingCode,
        importedProject.startDate,
        importedProject.productionDeadline,
        importedProject.relativityUrl,
        timestamp,
        timestamp
      ]
    );

    let importedNotes = 0;
    const notes = Array.isArray(payload.notes) ? payload.notes : [];
    for (const note of notes) {
      try {
        const noteId = randomUUID();
        run(
          `INSERT INTO notes
          (id, projectId, title, noteDate, contentMarkdown, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            noteId,
            projectId,
            ensureText(String(note.title || "Imported Note"), "Note title", { maxLen: 200 }),
            ensureIsoDate(String(note.noteDate || new Date().toISOString().slice(0, 10)), "Note date"),
            ensureText(String(note.contentMarkdown || ""), "Note content", { allowEmpty: true, minLen: 0, trim: false, maxLen: 2_000_000 }),
            typeof note.createdAt === "string" ? note.createdAt : timestamp,
            typeof note.updatedAt === "string" ? note.updatedAt : timestamp
          ]
        );
        importedNotes += 1;
      } catch (error) {
        console.error("Skipping invalid imported note", error);
      }
    }

    let importedTodos = 0;
    const todos = Array.isArray(payload.todos) ? payload.todos : [];
    for (const todo of todos) {
      try {
        const todoId = randomUUID();
        const todoText = ensureText(String(todo.text || ""), "To-do text", { maxLen: 2000 });
        const isCompleted = Boolean(todo.isCompleted);
        const isPriority = Boolean(todo.isPriority);
        run(
          "INSERT INTO todos (id, projectId, text, isCompleted, isPriority, createdAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [todoId, projectId, todoText, isCompleted ? 1 : 0, isPriority ? 1 : 0, todo.createdAt || timestamp, todo.completedAt || null]
        );
        importedTodos += 1;
      } catch (error) {
        console.error("Skipping invalid imported to-do", error);
      }
    }

    let importedTimeline = 0;
    const timelineTasks = Array.isArray(payload.timelineTasks) ? payload.timelineTasks : [];
    for (const task of timelineTasks) {
      try {
        const sanitized = sanitizeTimelineInput({
          phase: task.phase,
          startDate: task.startDate || null,
          endDate: task.endDate || null
        });
        if (!sanitized.startDate && !sanitized.endDate) continue;
        const timelineId = randomUUID();
        run(
          `INSERT INTO timeline_tasks
          (id, projectId, phase, startDate, endDate, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            timelineId,
            projectId,
            sanitized.phase,
            sanitized.startDate,
            sanitized.endDate,
            typeof task.createdAt === "string" ? task.createdAt : timestamp,
            typeof task.updatedAt === "string" ? task.updatedAt : timestamp
          ]
        );
        importedTimeline += 1;
      } catch (error) {
        console.error("Skipping invalid imported timeline row", error);
      }
    }

    let importedAttachments = 0;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const attachment of attachments) {
      try {
        const originalFileName = ensureText(String(attachment.originalFileName || "attachment.bin"), "Attachment name", {
          maxLen: 260
        });
        const base64 = ensureText(String(attachment.dataBase64 || ""), "Attachment bytes", { maxLen: 256 * 1024 * 1024 });
        const bytes = Buffer.from(base64, "base64");
        const stored = await writeAttachmentFromPlaintextBuffer(projectId, originalFileName, bytes);
        const attachmentId = randomUUID();
        run(
          `INSERT INTO attachments
          (id, projectId, originalFileName, storedFileName, storedRelativePath, sizeBytes, addedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            attachmentId,
            projectId,
            originalFileName,
            stored.storedFileName,
            stored.storedRelativePath,
            stored.sizeBytes,
            typeof attachment.addedAt === "string" ? attachment.addedAt : timestamp
          ]
        );
        importedAttachments += 1;
      } catch (error) {
        console.error("Skipping invalid imported attachment", error);
      }
    }

    recordAudit({
      action: "project.bundle.import",
      entityType: "project",
      entityId: projectId,
      projectId,
      details: {
        bundlePath,
        importedNotes,
        importedTodos,
        importedTimeline,
        importedAttachments
      }
    });
    persistDb();
    return {
      ok: true,
      project: get("SELECT * FROM projects WHERE id = ?", [projectId]),
      counts: {
        notes: importedNotes,
        todos: importedTodos,
        timelineTasks: importedTimeline,
        attachments: importedAttachments
      }
    };
  });

  ipcMain.handle("dashboard:deadlines", () => {
    assertUnlocked();
    return buildDeadlineDashboard();
  });

  ipcMain.handle("audit:list", (_event, limit = 100, projectId = null) => {
    assertUnlocked();
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;
    const params = [];
    let sql = "SELECT * FROM audit_log";
    if (projectId) {
      if (!isValidProjectId(projectId)) return [];
      sql += " WHERE projectId = ?";
      params.push(projectId);
    }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(safeLimit);
    return all(sql, params).map((row) => ({
      ...row,
      details: row.detailsJson ? readJsonSafe(row.detailsJson) : null
    }));
  });

  ipcMain.handle("notes:exportDocx", async (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const project = get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
    if (!project) {
      return { ok: false, error: "Project not found." };
    }
    const notes = all(
      "SELECT * FROM notes WHERE projectId = ? ORDER BY noteDate DESC, createdAt DESC",
      [safeProjectId]
    );

    const paragraphs = [];
    paragraphs.push(
      new Paragraph({
        text: project.matterName,
        heading: HeadingLevel.TITLE
      })
    );
    paragraphs.push(
      new Paragraph({
        text: `${project.clientName} · Billing ${project.billingCode}`,
        spacing: { after: 200 }
      })
    );

    if (project.relativityUrl) {
      paragraphs.push(
        new Paragraph({
          text: `Relativity: ${project.relativityUrl}`,
          spacing: { after: 200 }
        })
      );
    }

    notes.forEach((note) => {
      paragraphs.push(
        new Paragraph({
          text: note.title,
          heading: HeadingLevel.HEADING_1
        })
      );
      paragraphs.push(
        new Paragraph({
          text: `Date: ${note.noteDate}`,
          spacing: { after: 200 }
        })
      );

      const lines = String(note.contentMarkdown || "").split("\n");
      lines.forEach((line) => {
        if (!line.trim()) {
          paragraphs.push(new Paragraph({ text: "" }));
          return;
        }
        const trimmed = line.replace(/^\s+/, "");
        const indentLevel = Math.floor((line.length - trimmed.length) / 2);
        const isBullet = /^[-•*]\s+/.test(trimmed);
        const text = trimmed.replace(/^[-•*]\s+/, "");
        if (isBullet) {
          paragraphs.push(
            new Paragraph({
              text,
              bullet: { level: Math.min(indentLevel, 4) }
            })
          );
        } else {
          paragraphs.push(
            new Paragraph({
              text,
              spacing: { after: 120 }
            })
          );
        }
      });
    });

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: paragraphs
        }
      ]
    });

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Notes",
      defaultPath: `${project.matterName.replace(/[^a-z0-9-_]+/gi, "_")}-notes.docx`,
      filters: [{ name: "Word Document", extensions: ["docx"] }]
    });

    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
    recordAudit({
      action: "notes.export.docx",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId,
      details: { filePath, noteCount: notes.length },
      persist: true
    });
    return { ok: true, filePath };
  });

  ipcMain.handle("notes:exportPdf", async (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const project = get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
    if (!project) {
      return { ok: false, error: "Project not found." };
    }
    const notes = all(
      "SELECT * FROM notes WHERE projectId = ? ORDER BY noteDate DESC, createdAt DESC",
      [safeProjectId]
    );

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Notes as PDF",
      defaultPath: `${project.matterName.replace(/[^a-z0-9-_]+/gi, "_")}-notes.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    const printWindow = new BrowserWindow({
      show: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    try {
      const html = buildNotesPdfHtml(project, notes);
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdfBuffer = await printWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        marginsType: 1
      });
      fs.writeFileSync(filePath, pdfBuffer);
      recordAudit({
        action: "notes.export.pdf",
        entityType: "project",
        entityId: safeProjectId,
        projectId: safeProjectId,
        details: { filePath, noteCount: notes.length },
        persist: true
      });
      return { ok: true, filePath };
    } finally {
      try {
        if (!printWindow.isDestroyed()) {
          printWindow.close();
        }
      } catch {
        // ignore
      }
    }
  });

  ipcMain.handle("notes:exportMarkdown", async (_event, projectId) => {
    assertUnlocked();
    const safeProjectId = assertUuid(projectId, "project ID");
    const project = get("SELECT * FROM projects WHERE id = ?", [safeProjectId]);
    if (!project) {
      return { ok: false, error: "Project not found." };
    }
    const notes = all(
      "SELECT * FROM notes WHERE projectId = ? ORDER BY noteDate DESC, createdAt DESC",
      [safeProjectId]
    );
    const markdown = buildNotesMarkdown(project, notes);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Notes as Markdown",
      defaultPath: `${project.matterName.replace(/[^a-z0-9-_]+/gi, "_")}-notes.md`,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }]
    });

    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    fs.writeFileSync(filePath, markdown, "utf8");
    recordAudit({
      action: "notes.export.markdown",
      entityType: "project",
      entityId: safeProjectId,
      projectId: safeProjectId,
      details: { filePath, noteCount: notes.length },
      persist: true
    });
    return { ok: true, filePath };
  });
};

app.whenReady().then(async () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  // Best-effort cleanup of any leftover decrypted temp files from prior runs/crashes.
  tryCleanupTempFiles();
  if (!ENCRYPTION_ENABLED) {
    await initDatabase();
    vaultState.locked = false;
  }

  registerIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    try {
      persistDb();
    } finally {
      tryCleanupTempFiles();
      app.quit();
    }
  }
});

app.on("before-quit", () => {
  try {
    persistDb();
  } finally {
    tryCleanupTempFiles();
    lockVault();
  }
});
