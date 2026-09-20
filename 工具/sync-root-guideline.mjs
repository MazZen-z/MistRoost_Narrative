#!/usr/bin/env node
// Explicit opt-in write. Back up an existing differing root entry before replacing it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repo, '项目管理/00-游戏制作准则.md');
const root = path.dirname(repo);
const target = path.join(root, '游戏制作准则.md');
const data = fs.readFileSync(source);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
if (fs.existsSync(target) && sha(fs.readFileSync(target)) === sha(data)) {
  console.log('PASS: root guide and canonical document are identical.');
} else if (!process.argv.includes('--write')) {
  console.error('Root guide is missing or differs. Review canonical changes, then run with --write.');
  process.exitCode = 1;
} else {
  if (!fs.existsSync(path.join(root, 'MistRoost'))) throw new Error('Refusing parent-directory write outside a complete MistRoost workspace.');
  if (fs.existsSync(target)) {
    const backup = path.join(root, '.docs-migration-backup', 'guide-sync');
    fs.mkdirSync(backup, { recursive: true });
    fs.copyFileSync(target, path.join(backup, `游戏制作准则-${Date.now()}.md`), fs.constants.COPYFILE_EXCL);
  }
  const temp = target + `.tmp-${process.pid}`;
  fs.writeFileSync(temp, data, { flag: 'wx' });
  fs.renameSync(temp, target);
  console.log('Updated root guide from canonical document; differing prior version was backed up.');
}
