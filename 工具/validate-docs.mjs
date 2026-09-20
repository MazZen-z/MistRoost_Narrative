#!/usr/bin/env node
// Offline, dependency-free documentation checks. Does not mutate files or call the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(repo);
const strictWorkspace = process.argv.includes('--workspace');
const staging = process.argv.includes('--staging');
const errors = [];
const warnings = new Set();
const textExtensions = new Set(['.md', '.json', '.yml', '.yaml', '.mjs', '.py', '.csv']);
const ignoredDirs = new Set(['.git', 'node_modules', '__pycache__', '.cache']);
const slash = p => p.split(path.sep).join('/');
const rel = p => slash(path.relative(repo, p));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const decoder = new TextDecoder('utf-8', { fatal: true });
function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) { errors.push(`Symlink not permitted in docs: ${rel(p)}`); continue; }
    if (entry.isDirectory()) result.push(...walk(p));
    else if (entry.isFile()) result.push(p);
  }
  return result;
}
function withoutFences(text) {
  const result = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (match[1][0] === fence) fence = null;
      result.push(''); continue;
    }
    result.push(fence ? '' : line);
  }
  return result.join('\n');
}
function slug(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_\-]/gu, '').replace(/\s/g, '-');
}
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = withoutFences(fs.readFileSync(file, 'utf8'));
  const ids = new Set(); const counts = new Map();
  for (const m of text.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/g)) ids.add(m[1]);
  for (const line of text.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/); if (!m) continue;
    const base = slug(m[1]); const n = counts.get(base) || 0;
    ids.add(base + (n ? '-' + n : '')); counts.set(base, n + 1);
  }
  anchorCache.set(file, ids); return ids;
}
function exactCase(root, absolute) {
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let at = root;
  for (const part of parts) {
    if (!fs.existsSync(at) || !fs.statSync(at).isDirectory()) return true;
    if (!fs.readdirSync(at).includes(part)) return false;
    at = path.join(at, part);
  }
  return true;
}
let manifest = [];
try {
  manifest = JSON.parse(fs.readFileSync(path.join(repo, '项目管理/迁移映射.json'), 'utf8'));
  if (!Array.isArray(manifest)) { manifest = []; throw new Error('Expected an array'); }
}
catch (e) { errors.push('Invalid migration manifest: ' + e.message); }
const resolveManifestPath = dest => dest.startsWith('Docs/') ? path.resolve(repo, dest.slice(5)) : path.resolve(workspace, dest);
const virtualBinaryPaths = new Set(manifest.filter(x => x && x.mode === 'binary-preserved' && typeof x.destination === 'string').map(x => resolveManifestPath(x.destination)));
let files = walk(repo);
const markdown = files.filter(p => p.endsWith('.md'));
if (strictWorkspace) {
  for (const file of ['游戏制作准则.md', 'MistRoost/程序设计准则.md', 'MistRoost/README.md']) {
    const p = path.join(workspace, file);
    if (!fs.existsSync(p)) errors.push('Missing workspace deliverable: ' + file);
    else { files.push(p); markdown.push(p); }
  }
}
let checkedLinks = 0;
for (const file of files) {
  if (fs.statSync(file).size > 20 * 1024 * 1024) errors.push('File exceeds project docs limit (20MiB): ' + rel(file));
  if (!textExtensions.has(path.extname(file)) && !['.gitignore', '.gitattributes'].includes(path.basename(file))) continue;
  let text;
  try { text = decoder.decode(fs.readFileSync(file)); }
  catch { errors.push('Invalid UTF-8: ' + rel(file)); continue; }
  if (text.includes('\r')) errors.push('Expected LF, found CR: ' + rel(file));
  if (!text.endsWith('\n')) errors.push('Missing final newline: ' + rel(file));
  if (/[^\S\n]+$/m.test(text)) errors.push('Trailing whitespace: ' + rel(file));
  if (/^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(text)) errors.push('Possible merge conflict: ' + rel(file));
  if (/@\{[^}]+\}/.test(text) && file.endsWith('.md')) errors.push('Unresolved authoring link token: ' + rel(file));
  if (file.endsWith('.json')) {
    try { JSON.parse(text); } catch (e) { errors.push('Invalid JSON: ' + rel(file) + ': ' + e.message); }
  }
}
for (const file of markdown) {
  const text = withoutFences(fs.readFileSync(file, 'utf8')).replace(/`[^`\n]+`/g, '');
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    let target;
    try { target = decodeURIComponent(m[1].replace(/^<|>$/g, '')); }
    catch { errors.push('Invalid URL encoding: ' + rel(file) + ' -> ' + m[1]); continue; }
    if (/^(?:https?:|mailto:|data:)/i.test(target)) continue;
    if (/^[a-zA-Z]:[/\\]|^file:|^\//.test(target)) { errors.push('Nonportable local absolute link: ' + rel(file) + ' -> ' + target); continue; }
    const hashAt = target.indexOf('#');
    const filePart = (hashAt < 0 ? target : target.slice(0, hashAt)).split('?')[0];
    const fragment = hashAt < 0 ? '' : target.slice(hashAt + 1);
    const resolved = filePart ? path.resolve(path.dirname(file), filePart) : file;
    checkedLinks++;
    if (inside(path.join(workspace, 'MistRoost/Docs'), resolved)) { errors.push('Old code Docs reference: ' + rel(file) + ' -> ' + target); continue; }
    if (!inside(repo, resolved)) {
      const allowed = inside(path.join(workspace, 'MistRoost'), resolved) || resolved === path.join(workspace, '游戏制作准则.md') || inside(path.join(workspace, '美术资产'), resolved);
      if (!allowed || !inside(workspace, resolved)) { errors.push('Link escapes approved workspace boundary: ' + rel(file) + ' -> ' + target); continue; }
      if (!strictWorkspace) { warnings.add('Cross-repository dependency: ' + slash(path.relative(workspace, resolved))); continue; }
    }
    if (!fs.existsSync(resolved)) {
      if (staging && virtualBinaryPaths.has(resolved)) { warnings.add('Staging only: original image checked by manifest, not present locally'); continue; }
      errors.push('Missing link: ' + rel(file) + ' -> ' + target); continue;
    }
    if (!exactCase(inside(repo, resolved) ? repo : workspace, resolved)) errors.push('Case mismatch: ' + rel(file) + ' -> ' + target);
    if (fragment && resolved.endsWith('.md') && !anchors(resolved).has(fragment)) errors.push('Missing anchor: ' + rel(file) + ' -> ' + target);
  }
}
let verifiedImages = 0;
const destinations = new Set();
const sources = new Set();
const migrationModes = new Set(['text-updated', 'consolidated', 'binary-preserved', 'retired-by-owner']);
for (const row of manifest) {
  if (!row || typeof row.source !== 'string' || typeof row.destination !== 'string' || !migrationModes.has(row.mode) || !/^[0-9a-f]{64}$/i.test(row.sha256_before || '') || !Number.isSafeInteger(row.bytes_before) || row.bytes_before < 0) { errors.push('Invalid migration record'); continue; }
  if (!row.source.startsWith('MistRoost/Docs/') || sources.has(row.source)) errors.push('Invalid or duplicate migration source: ' + row.source);
  sources.add(row.source);
  const dest = resolveManifestPath(row.destination);
  const approvedDestination = row.destination.startsWith('Docs/') ? inside(repo, dest) : row.destination === 'MistRoost/程序设计准则.md';
  if (!approvedDestination || !inside(workspace, dest)) { errors.push('Unsafe manifest destination: ' + row.destination); continue; }
  if (!['consolidated', 'retired-by-owner'].includes(row.mode) && destinations.has(dest)) errors.push('Duplicate migration destination: ' + row.destination);
  if (row.mode !== 'retired-by-owner') destinations.add(dest);
  if (row.mode === 'retired-by-owner' && (!row.reason || !row.section)) errors.push('Retirement requires owner rationale and decision section: ' + row.source);
  if (row.mode !== 'binary-preserved' && (inside(repo, dest) || strictWorkspace)) {
    if (!fs.existsSync(dest)) errors.push('Missing migration destination: ' + row.destination);
    else if (row.section && (!dest.endsWith('.md') || !anchors(dest).has(row.section))) errors.push('Missing migration decision/section: ' + row.destination + '#' + row.section);
  }
  if (row.mode === 'binary-preserved') {
    if (staging && !fs.existsSync(dest)) continue;
    if (!fs.existsSync(dest)) { errors.push('Missing original image: ' + row.destination); continue; }
    if (fs.statSync(dest).size !== row.bytes_before || sha(dest) !== row.sha256_before.toLowerCase()) errors.push('Original image changed: ' + row.destination);
    else verifiedImages++;
  }
}
if (manifest.length !== 50) errors.push('Expected 50 original source records, including owner retirements');
for (const retired of ['美术/资产/01-v0.1免费资产下载与接入清单.md', '美术/资产/02-缺失来源与待恢复清单.md']) {
  if (fs.existsSync(path.join(repo, retired))) errors.push('Owner-retired document was restored without revising D-033: ' + retired);
}
if (manifest.filter(x => x && x.mode === 'binary-preserved').length !== 12) errors.push('Expected 12 original PNG records');
if (fs.existsSync(path.join(repo, 'Docs'))) errors.push('Nested Docs/Docs directory remains');
if (strictWorkspace && fs.existsSync(path.join(workspace, 'MistRoost/Docs'))) errors.push('Old MistRoost/Docs directory remains');
const rootGuide = path.join(workspace, '游戏制作准则.md');
const canonical = path.join(repo, '项目管理/00-游戏制作准则.md');
if (fs.existsSync(rootGuide) && fs.existsSync(canonical) && sha(rootGuide) !== sha(canonical)) errors.push('Root game-production guide differs from canonical copy');
const pipelineFiles = markdown.filter(p => rel(p).startsWith('美术/美术制作流程准则/') && !rel(p).includes('/历史归档/'));
for (const file of pipelineFiles) {
  for (const line of withoutFences(fs.readFileSync(file, 'utf8')).split('\n')) {
    if (/(地面是按高度分层的瓦片地图|TileMapPlus\s*\|\s*✅|农田与可建造区\s*=\s*C)/.test(line) && !/(旧|历史|不再|取代|不作为|非现行|禁止)/.test(line)) errors.push('Active legacy 2D pipeline statement: ' + rel(file));
  }
}
const report = {
  mode: staging ? 'staging-manifest-only' : strictWorkspace ? 'complete-workspace' : 'standalone-document-repository',
  files: files.length, markdownFiles: markdown.length, checkedLocalLinks: checkedLinks,
  originalImagesVerified: verifiedImages, migrationRecords: manifest.length,
  retiredOriginalRecords: manifest.filter(x => x && x.mode === 'retired-by-owner').length,
  warnings: [...warnings], errors,
  result: errors.length ? 'FAIL' : 'PASS',
  scope: 'Offline paths, anchors, UTF-8/LF, JSON, mirror, migration and PNG hashes. No UE runtime/build, remote URL or GitHub CI verification.'
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = errors.length ? 1 : 0;
