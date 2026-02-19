# Desktop Release Workflow (Windows + macOS)

This project now ships signed desktop installers for Windows and macOS from one tag-based GitHub Actions workflow.

## How It Works
- Trigger on semantic version tags like `v1.0.0`.
- One matrix build runs on:
  - `windows-latest`
  - `macos-latest`
- Each matrix leg runs:
  1. `npm ci`
  2. `npm run lint`
  3. `npm run test`
  4. `npm run smoke`
  5. platform packaging (`dist:win` or `dist:mac`)
- Release assets are assembled into a **draft release** first.
- Draft is promoted only after manual smoke installs on both OSes.

## Workflow File
- `.github/workflows/windows-release.yml`

## Required Secrets
### Windows signing (Authenticode)
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

### macOS signing + notarization (Developer ID + Apple notarization)
- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## Release Assets Uploaded
- Windows: `*.exe`, `*.zip`
- macOS: `*.dmg`, `*.zip`
- Checksums:
  - `SHA256SUMS-windows.txt`
  - `SHA256SUMS-macos.txt`
  - `SHA256SUMS.txt` (combined)
- `RELEASE_NOTES.md`

## Create Draft Release (Tag-Based)
From repo root:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This starts the matrix workflow and creates/updates a **draft** release for that tag.

## Promote Draft Release After Manual Verification
Run workflow manually in GitHub Actions:
- `action=promote-draft`
- `tag=v1.0.0`

The workflow publishes the existing draft release (`draft=false`).

## Manual Smoke Install Checklist
1. Download installer + checksum file from the draft release.
2. Verify SHA256 hash matches `SHA256SUMS.txt`.
3. Install and launch on Windows.
4. Install and launch on macOS.
5. Confirm core note flow (open existing note, create/save new note).
6. Promote draft only after both OS checks pass.
