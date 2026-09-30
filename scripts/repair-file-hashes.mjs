#!/usr/bin/env node
/**
 * 一次性修复脚本：修复「去 EXIF 重编码」版本（539c679 起）上传的凭证图片，
 * 其文件索引记录的是上传原始字节的哈希，而磁盘上是重编码后的字节，
 * 导致「生成 PDF」时报「缺少报销凭证图片」。新版本上传不会再产生这种记录。
 *
 * 用法：node scripts/repair-file-hashes.mjs [数据库路径] [--since=YYYY-MM-DD] [--apply]
 *   - 默认读取 data/app.sqlite，图片目录取数据库所在目录；线上在 Railway shell 中传 /app/data/app.sqlite。
 *   - 不带 --apply 时只列出问题，不修改任何数据（先跑一遍看结果）。
 *   - --since 只检查该日期（含）之后上传的凭证，建议填部署 539c679 及之后版本的日期。
 *   - 只修复符合该问题特征的记录：索引哈希等于凭证上的上传指纹、文件存在但内容哈希不同。
 *     其他不一致（可能是文件被改动或损坏）只报告，不自动修改。
 *   - 执行 --apply 前请先备份整个数据目录。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sinceArg = args.find((arg) => arg.startsWith('--since='));
const since = sinceArg === undefined ? null : sinceArg.slice('--since='.length);
if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('--since 需要 YYYY-MM-DD 格式，例如 --since=2026-09-29');
  process.exit(2);
}
const dbPath = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'data/app.sqlite');
const dataDir = dirname(dbPath);
const database = new DatabaseSync(dbPath, { readOnly: !apply });

const receipts = new Map(
  database.prepare('SELECT id, data FROM receipts').all().map((row) => [row.id, JSON.parse(row.data)]),
);

const fixable = [];
const suspicious = [];
for (const row of database.prepare('SELECT id, data FROM files').all()) {
  const entry = JSON.parse(row.data);
  if ((entry.kind !== 'original' && entry.kind !== 'refund') || entry.deletedAt !== null) continue;
  const receipt = receipts.get(entry.ownerId);
  if (receipt === undefined) continue;
  if (since !== null && String(receipt.uploadedAt).slice(0, 10) < since) continue;
  let bytes;
  try {
    bytes = readFileSync(join(dataDir, entry.path));
  } catch {
    suspicious.push({ entry, receipt, reason: '文件缺失' });
    continue;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual === entry.sha256) continue;
  const image = entry.kind === 'original'
    ? receipt.original
    : (receipt.refundImages ?? []).find((item) => item.id === entry.id);
  if (image !== undefined && image.sha256 === entry.sha256 && image.fileSha256 === undefined) {
    fixable.push({ entry, receipt, actual });
  } else {
    suspicious.push({ entry, receipt, reason: '内容哈希不符，且不属于本问题特征（可能是文件被改动或损坏）' });
  }
}

const describe = ({ entry, receipt }) =>
  `${receipt.id} ${receipt.merchant ?? '(无商户)'} 上传于 ${receipt.uploadedAt} ${entry.kind === 'original' ? '原始凭证' : '退款凭证'} ${entry.path}`;

if (fixable.length === 0) {
  console.log('没有发现需要修复的文件索引。');
} else {
  console.log(`发现 ${fixable.length} 个需要修复的文件索引：`);
  for (const item of fixable) console.log(`- ${describe(item)}`);
}
if (suspicious.length > 0) {
  console.log(`\n另有 ${suspicious.length} 个文件需要人工核对（本脚本不会修改）：`);
  for (const item of suspicious) console.log(`- ${describe(item)}：${item.reason}`);
}

if (fixable.length > 0 && !apply) {
  console.log('\n以上为只读检查。确认无误并备份数据目录后，加 --apply 执行修复。');
}
if (fixable.length > 0 && apply) {
  const update = database.prepare('UPDATE files SET data = ? WHERE id = ?');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const { entry, actual } of fixable) {
      update.run(JSON.stringify({ ...entry, sha256: actual }), entry.id);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  console.log(`\n已修复 ${fixable.length} 个文件索引。`);
}
database.close();
