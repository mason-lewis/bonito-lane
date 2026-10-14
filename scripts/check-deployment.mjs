#!/usr/bin/env node
// Self-contained checks for the separately prepared, runtime-only deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MANIFEST = 'deployment-files.json';
const GUARD = 'scripts/check-deployment.mjs';
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const SOURCE_EXCLUSIONS = new Set(['.git', 'node_modules', 'dist']);
const TEXT_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.json',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.svg', '.xml', '.glsl', '.wgsl',
]);
const PUBLIC_EXTENSIONS = new Set([
  '.glb', '.json', '.hdr', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif',
  '.ico', '.svg', '.ktx2', '.bin', '.wasm', '.woff', '.woff2', '.mp3', '.wav',
  '.ogg', '.webm', '.mp4',
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}\b/,
];
const PRIVATE_PATH_PATTERNS = [
  /\/(?:Users|home)\/[^\s"'`<>\\/]+\//,
  /\/(?:private\/var|var\/folders|private\/tmp)\//,
  /\b[A-Za-z]:[\\/]+Users[\\/]+/i,
  /file:\/{2,}/i,
];
const REFERENCE_PATH_PATTERNS = [
  /(?:^|[\s"'`=:(/\\])(?:references|vehicle-references|artifacts|reports)[/\\]/i,
  /(?:^|[\s"'`=:(/\\])data[/\\]geographic(?:[/\\]|\b)/i,
  /(?:^|[\s"'`=:(/\\])(?:assets|tools)[/\\]blender(?:[/\\]|\b)/i,
  /(?:^|[\s"'`<>])(?:[A-Za-z0-9_@%+~.:-]*[/\\])*[A-Za-z0-9_@%+~.-]+\.(?:blend\d*|pdf|dwg|dxf)(?:[?#][A-Za-z0-9_@%+~.=&/-]*)?(?=[\s"'`<>]|$)/i,
];

function forbiddenPath(relativePath) {
  const parts = relativePath.toLowerCase().split('/');
  return parts.some(part => /^(?:\.env(?:\..*)?|references|vehicle-references|artifacts|reports|geographic|drawings|builder-drawings|\.aws|\.ssh|\.codex|\.agents)$/.test(part))
    || /(?:^|\/)(?:assets|tools)\/blender(?:\/|$)/i.test(relativePath)
    || /\.(?:blend\d*|pdf|dwg|dxf|psd|pem|key|p12|pfx|map)$/i.test(relativePath)
    || (/\.html$/i.test(relativePath) && relativePath !== 'index.html');
}

function normalizedPath(value) {
  return typeof value === 'string' && value.length > 0
    && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value)
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

async function readManifest(root, issues) {
  let parsed;
  try {
    const stat = await fs.lstat(path.join(root, MANIFEST));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      issues.push(`${MANIFEST}: invalid manifest file`);
      return [];
    }
    parsed = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  } catch {
    issues.push(`${MANIFEST}: missing or invalid JSON manifest`);
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every(normalizedPath)) {
    issues.push(`${MANIFEST}: expected an array of safe relative file paths`);
    return [];
  }
  const sorted = [...new Set(parsed)].sort();
  if (JSON.stringify(parsed) !== JSON.stringify(sorted)) {
    issues.push(`${MANIFEST}: file paths must be sorted and unique`);
  }
  for (const required of [MANIFEST, GUARD]) {
    if (!parsed.includes(required)) issues.push(`${MANIFEST}: missing required entry ${required}`);
  }
  for (const relativePath of sorted) {
    if (SOURCE_EXCLUSIONS.has(relativePath.split('/')[0]) || forbiddenPath(relativePath)) {
      issues.push(`${relativePath}: forbidden deployment path`);
    }
    if (relativePath.startsWith('public/') && !PUBLIC_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      issues.push(`${relativePath}: unsupported public asset type`);
    }
  }
  return sorted;
}

async function collectFiles(directory, issues, excluded = new Set(), prefix = '') {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    issues.push(`${prefix || '.'}: directory cannot be read`);
    return files;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      issues.push(`${relativePath}: symbolic links are forbidden`);
    } else if (!prefix && excluded.has(entry.name)) {
      // Installed dependencies, Git internals and build output are checked separately.
    } else if (entry.isDirectory()) {
      files.push(...await collectFiles(path.join(directory, entry.name), issues, excluded, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      issues.push(`${relativePath}: unsupported filesystem entry`);
    }
  }
  return files.sort();
}

function scanText(text, relativePath, issues) {
  // Findings identify categories and files only, so secrets never reach logs.
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    issues.push(`${relativePath}: possible secret or private key`);
  }
  if (PRIVATE_PATH_PATTERNS.some(pattern => pattern.test(text))) {
    issues.push(`${relativePath}: private local filesystem path`);
  }
  // Deployment policy and documentation can name excluded paths. They still receive
  // the secret and private-path checks above; manifest filenames have no exemption.
  if (![GUARD, '.gitignore', 'README.md'].includes(relativePath)
      && REFERENCE_PATH_PATTERNS.some(pattern => pattern.test(text))) {
    issues.push(`${relativePath}: source drawing or reference path`);
  }
}

function scanGlb(buffer, relativePath, issues) {
  try {
    if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67
        || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
      throw new Error('header');
    }
    let offset = 12;
    let document;
    let jsonCount = 0;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) throw new Error('chunk header');
      const length = buffer.readUInt32LE(offset);
      const type = buffer.readUInt32LE(offset + 4);
      if (length % 4 !== 0 || offset + 8 + length > buffer.length) throw new Error('chunk length');
      if (offset === 12 && type !== 0x4e4f534a) throw new Error('first chunk');
      if (type === 0x4e4f534a) {
        jsonCount += 1;
        const json = buffer.subarray(offset + 8, offset + 8 + length).toString('utf8').replace(/\0+$/, '').trimEnd();
        scanText(json, relativePath, issues);
        document = JSON.parse(json);
      }
      offset += 8 + length;
    }
    if (jsonCount !== 1 || !document || typeof document !== 'object') throw new Error('JSON');
    for (const section of ['buffers', 'images']) {
      if (document[section] !== undefined && !Array.isArray(document[section])) throw new Error('resources');
      for (const resource of document[section] ?? []) {
        if (!resource || typeof resource !== 'object') throw new Error('resource');
        if (resource.uri !== undefined && (typeof resource.uri !== 'string' || !resource.uri.startsWith('data:'))) {
          issues.push(`${relativePath}: external GLB ${section === 'images' ? 'image' : 'buffer'} URI`);
        }
        if (section === 'images' && resource.uri === undefined && !Number.isInteger(resource.bufferView)) {
          issues.push(`${relativePath}: GLB image is not embedded`);
        }
      }
    }
  } catch {
    issues.push(`${relativePath}: malformed GLB container or JSON`);
  }
}

async function inspectFile(root, relativePath, issues) {
  try {
    const filename = path.join(root, relativePath);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push(`${relativePath}: expected a regular file`);
      return 0;
    }
    if (stat.size > MAX_FILE_BYTES) {
      issues.push(`${relativePath}: exceeds the 95 MiB file limit`);
      return stat.size;
    }
    const extension = path.extname(relativePath).toLowerCase();
    if (extension === '.glb') {
      scanGlb(await fs.readFile(filename), relativePath, issues);
    } else if (TEXT_EXTENSIONS.has(extension) || !extension || path.basename(relativePath).startsWith('.')) {
      scanText(await fs.readFile(filename, 'utf8'), relativePath, issues);
    }
    return stat.size;
  } catch {
    issues.push(`${relativePath}: file cannot be read`);
    return 0;
  }
}

async function inspectTrackedFiles(root, approved, issues) {
  try {
    await fs.lstat(path.join(root, '.git'));
  } catch (error) {
    if (error.code !== 'ENOENT') issues.push('.git: repository metadata cannot be inspected');
    return;
  }
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const relativePath of stdout.split('\0').filter(Boolean)) {
      if (!approved.has(relativePath)) {
        issues.push(`${relativePath}: tracked Git file is absent from deployment manifest`);
      }
    }
  } catch {
    issues.push('.git: tracked files could not be verified');
  }
}

export async function checkDeployment({ root = process.cwd(), mode = 'source' } = {}) {
  if (mode !== 'source' && mode !== 'dist') throw new Error('Mode must be source or dist.');
  root = path.resolve(root);
  const issues = [];
  const manifest = await readManifest(root, issues);
  const directory = mode === 'dist' ? path.join(root, 'dist') : root;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push(`${mode === 'dist' ? 'dist' : '.'}: expected a regular directory`);
      return { mode, files: 0, bytes: 0, issues: [...new Set(issues)] };
    }
  } catch {
    issues.push(`${mode === 'dist' ? 'dist' : '.'}: directory is missing`);
    return { mode, files: 0, bytes: 0, issues: [...new Set(issues)] };
  }
  const files = await collectFiles(directory, issues, mode === 'source' ? SOURCE_EXCLUSIONS : new Set());
  const present = new Set(files);
  let expected;
  if (mode === 'source') {
    expected = new Set(manifest);
    await inspectTrackedFiles(root, expected, issues);
    for (const relativePath of files) {
      if (!expected.has(relativePath)) issues.push(`${relativePath}: file is absent from deployment manifest`);
      if (forbiddenPath(relativePath)) issues.push(`${relativePath}: forbidden deployment path`);
    }
  } else {
    expected = new Set(['index.html', ...manifest.filter(name => name.startsWith('public/')).map(name => name.slice(7))]);
    for (const relativePath of files) {
      const generatedAsset = /^assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|wasm)$/.test(relativePath);
      if (!expected.has(relativePath) && !generatedAsset) issues.push(`${relativePath}: unexpected compiled output`);
      if (forbiddenPath(relativePath)) issues.push(`${relativePath}: forbidden deployment path`);
    }
  }
  for (const relativePath of expected) {
    if (!present.has(relativePath)) issues.push(`${relativePath}: required ${mode} file is missing`);
  }
  let bytes = 0;
  for (const relativePath of files) bytes += await inspectFile(directory, relativePath, issues);
  return { mode, files: files.length, bytes, issues: [...new Set(issues)] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--source', '--dist'].includes(args[0]))) {
    console.error('Usage: node scripts/check-deployment.mjs [--source|--dist]');
    process.exitCode = 2;
    return;
  }
  const result = await checkDeployment({ mode: args[0] === '--dist' ? 'dist' : 'source' });
  const summary = `${result.mode}: ${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (result.issues.length) {
    console.error(`Deployment check FAILED (${summary}; ${result.issues.length} findings).`);
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Deployment check passed (${summary}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
