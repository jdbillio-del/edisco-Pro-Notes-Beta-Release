# Known Issues

This document tracks known issues and limitations in the eDisco Pro Notes Beta.

## Current Release

### Beta 0.0.1

#### UI/UX
- [ ] Timeline view may not render correctly on very small screens (< 320px width)
- [ ] Drag and drop file upload does not show progress indicator
- [ ] Export to Word formatting may vary slightly between platforms

#### Performance
- [ ] Large document collections (> 10,000 notes) may experience slower load times
- [ ] Search indexing is synchronous and may block UI on initial import

#### Data
- [ ] No automatic backup mechanism - users must manually export
- [ ] Attachment file size limited to 50MB per file

## Fixed in This Release

- ✅ Project creation with special characters in name
- ✅ Date picker timezone handling
- ✅ PDF export page breaks

## Reporting Issues

Please report new issues via GitHub Issues with:
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- System information (OS, app version)
