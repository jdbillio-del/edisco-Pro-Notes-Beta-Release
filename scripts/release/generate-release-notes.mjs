import { writeFile } from 'node:fs/promises';

const [tag, outputPath] = process.argv.slice(2);

if (!tag || !outputPath) {
  console.error('Usage: node scripts/release/generate-release-notes.mjs <tag> <outputPath>');
  process.exit(1);
}

const releaseDate = new Date().toISOString().slice(0, 10);

const notes = `# ${tag}\n\n` +
`Release date: ${releaseDate}\n\n` +
`## Artifacts\n` +
`- Windows installer: \`.exe\`\n` +
`- Windows archive: \`.zip\`\n` +
`- macOS installer: \`.dmg\`\n` +
`- macOS archive: \`.zip\`\n` +
`- Checksums: \`SHA256SUMS.txt\`\n\n` +
`## Install Verification Instructions\n` +
`1. Download the OS-specific installer/archive and \`SHA256SUMS.txt\`.\n` +
`2. Verify file integrity before install:\n` +
`   - Windows (PowerShell): \`Get-FileHash .\\<artifact> -Algorithm SHA256\`\n` +
`   - macOS (Terminal): \`shasum -a 256 <artifact>\`\n` +
`3. Perform manual smoke install on Windows and macOS:\n` +
`   - Install the artifact.\n` +
`   - Launch app and confirm main window renders.\n` +
`   - Open an existing note and create/save a new note.\n` +
`4. Publish only after both smoke installs pass by running the workflow manually with:\n` +
`   - \`action=promote-draft\`\n` +
`   - \`tag=${tag}\`\n\n` +
`## Smoke Install Sign-off\n` +
`- [ ] Windows smoke install passed\n` +
`- [ ] macOS smoke install passed\n`;

await writeFile(outputPath, notes, 'utf8');
console.log(`Wrote release notes to ${outputPath}`);
