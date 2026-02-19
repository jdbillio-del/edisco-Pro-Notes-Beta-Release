# Architecture

## Runtime Topology

The desktop app is split across Electron main, preload bridge, and React renderer.

- Electron main (`apps/desktop/electron/main.cjs`)
  - Owns encrypted vault lifecycle, SQL.js database lifecycle, filesystem I/O, and IPC handlers.
  - Performs attachment encryption/decryption and all backup/import/export operations.
- Preload bridge (`apps/desktop/electron/preload.cjs`)
  - Exposes a typed `window.edisconotes` API to renderer.
  - Enforces renderer-to-main communication through explicit IPC calls.
- React renderer (`apps/desktop/src`)
  - UI state, rich notes editor, dashboard visualizations, and client-side interaction flow.

## Data & Security Model

### Vault and Encryption

- Encrypted DB file: `edisconotes.sqlite.enc`
- Optional plaintext migration source: `edisconotes.sqlite`
- Attachment files are encrypted at rest with a file key derived from vault material.
- Unlock requires passphrase and unlocks db/file keys in memory.
- Lock operation clears in-memory vault material and reloads app gate.

### Local Storage Roots

Under Electron `userData` (dev uses `edisconotes-desktop`):
- Database files (`*.sqlite`, `*.sqlite.enc`)
- `attachments/` project file store
- `snapshots/` restore points
- `backup-meta.json` backup metadata

## App Domains

### Projects
- CRUD + archive/restore + pinning
- Home-first navigation; selecting a project opens workspace tabs

### Notes
- Rich editor surface (`contentEditable`) in renderer
- Notes persisted as `contentMarkdown` after rich->markdown conversion
- Template append/replace actions
- Exports: Word, PDF, Markdown

### Timeline & Gantt
- Phase timeline values saved in timeline table
- Gantt rows rendered in renderer from timeline values
- `Project Completion` treated as milestone and rendered as thin red vertical week marker

### To-Do
- Per-project todos with completed and priority state
- Global rollups used by Home dashboard

### Documents
- Add/list/open/preview/reveal/delete
- Files stored in project-scoped encrypted attachment directories

### Data Safety
- Full backup export/restore
- Snapshot create/list/restore
- Project bundle export/import for handoff
- Audit log table for significant actions

## IPC Surface (High-Level)

Main groups exposed through `window.edisconotes`:
- Vault: `vaultStatus`, `vaultUnlock`, `vaultLock`
- Projects: list/get/create/update/archive/restore/pin
- Notes/Todos/Attachments: CRUD + note exports + preview/open helpers
- Timeline: list/upsert
- Dashboard/Search: deadline dashboard + global search
- Safety: backup status/export/restore, snapshot create/list/restore, audit list
- Bundles: project export/import bundle

## Frontend State Patterns

- Autosave model for notes with debounce and save status indicator.
- Home dashboard refreshes on timer and on key data mutations.
- Accessibility quick check computes basic label/contrast/focus checks.
- Theme model is explicit `light | dark` with accent token overrides.

## Build and Packaging

- Toolchain: Vite + React + Electron
- Build scripts in root proxy into `apps/desktop`
- Installer packaging via `electron-builder`
  - macOS targets: `dmg`, `zip`
  - Windows targets: `nsis`, `zip`

