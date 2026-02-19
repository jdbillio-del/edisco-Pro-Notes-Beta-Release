import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [platform, sourceDir, outputDir] = process.argv.slice(2);

if (!platform || !sourceDir || !outputDir) {
  console.error('Usage: node scripts/release/prepare-artifacts.mjs <windows|macos> <sourceDir> <outputDir>');
  process.exit(1);
}

if (platform !== 'windows' && platform !== 'macos') {
  console.error(`Unsupported platform '${platform}'. Expected 'windows' or 'macos'.`);
  process.exit(1);
}

const isAllowedFile = (fileName) => {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);

  if (platform === 'windows') {
    if (ext === '.exe') {
      return true;
    }
    return ext === '.zip' && lower.includes('-win');
  }

  if (ext === '.dmg') {
    return true;
  }
  return ext === '.zip' && lower.includes('-mac');
};

const hashFile = async (filePath) => {
  const hash = createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
};

const entries = await readdir(sourceDir, { withFileTypes: true });
const selectedFiles = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((fileName) => isAllowedFile(fileName));

if (selectedFiles.length === 0) {
  console.error(`No ${platform} release artifacts found in '${sourceDir}'.`);
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const checksumLines = [];
for (const fileName of selectedFiles) {
  const sourcePath = path.join(sourceDir, fileName);
  const targetPath = path.join(outputDir, fileName);
  await copyFile(sourcePath, targetPath);

  const digest = await hashFile(targetPath);
  checksumLines.push(`${digest}  ${fileName}`);
}

const checksumPath = path.join(outputDir, `SHA256SUMS-${platform}.txt`);
await writeFile(checksumPath, `${checksumLines.join('\n')}\n`, 'utf8');

console.log(`Prepared ${selectedFiles.length} artifacts for ${platform} in ${outputDir}`);
