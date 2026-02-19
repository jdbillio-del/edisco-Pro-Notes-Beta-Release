# eDisco Pro Notes

Local-first desktop workspace for eDiscovery matters, with encrypted vault storage, timeline planning, task rollups, and document-safe backups.

## What It Does

eDisco Pro Notes is an Electron + React app for managing eDiscovery projects end-to-end without requiring cloud infrastructure.

Current workflow areas:
- Home dashboard with cross-project timeline risk queue and to-do rollups.
- Project workspaces with Notes, Timelines, To-Do, and Documents.
- Encrypted vault lock/unlock flow with explicit passphrase gate.
- Backup, restore points, project bundle import/export, and audit activity log.

## Current Feature Set

### Secure Vault
- AES-256-GCM encrypted database and encrypted attachments at rest.
- Passphrase unlock gate on startup.
- Explicit `Lock Vault` action from inside the app.
- Lost-passphrase reset flow (destructive reset).

### Home Dashboard
- Deadline dashboard for upcoming and overdue timeline items.
- To-do rollups across projects.
- Manual `Refresh` control.
- Rollup click-through to the target project's `To-Do` tab.

### Notes
- Rich text editor (default UI) with formatting tools:
  - Header, Bold, Italic, Highlight, Quote, Bullet, Sub-bullet, Date Stamp.
- Tool active-state indicators in toolbar.
- Template panel with append/replace actions.
- New notes start blank by default.
- Note exports: Word (`.docx`), PDF (`.pdf`), Markdown (`.md`).

### Timelines
- Per-phase timeline inputs and Gantt visualization.
- `Project Completion` is shown as a thin red vertical week marker in the chart.

### Data Safety
- Conflict-safe local backup snapshots and restore points.
- Full backup export/restore.
- Project bundle export/import for machine handoff.
- Audit log for edits, exports, attachments, and backup/bundle actions.

### UX
- Home-first navigation model.
- Theme controls: `Light` and `Dark` (no `System` mode).
- Accent color customization.
- Accessibility quick-check panel (labels/contrast/focus quick pass).

## Repo Layout

- `apps/desktop/src`: React renderer app.
- `apps/desktop/electron`: Electron main/preload and vault/database runtime.
- `docs/ARCHITECTURE.md`: runtime and storage architecture.
- `docs/windows-release.md`: Windows release packaging workflow.
- `prd/PRD-eDisco-Pro-Notes.md`: product requirements notes.

## Local Development

Requirements:
- Node.js 18+
- npm

From repo root:

```bash
npm install
npm run dev
```

Root scripts proxy into `apps/desktop` workspace.

## Build

From repo root:

```bash
npm run build
npm run dist:mac
npm run dist:win
```

Build outputs are written under `dist/`.

## Data Location (Dev)

In development, the app pins `userData` to a dedicated folder to avoid Electron default collisions:
- macOS: `~/Library/Application Support/edisconotes-desktop`

This is where encrypted DB files, attachments, and backup metadata are stored.

## Security Notes

- Data is stored locally; no automatic cloud sync.
- Encryption is passphrase-derived and authenticated.
- Resetting vault data removes local data if passphrase recovery is not possible.

## Licensing (Beta)

- This project is distributed under a custom beta, source-available license.
- Beta use is free for up to five (5) users per organization.
- More than five users at one organization requires prior written consent.
- Source code may be inspected for internal security review only.
- Building or helping build a competing/similar product from this codebase is prohibited.

See:
- `LICENSE-BETA.md`
- `EULA.md`
