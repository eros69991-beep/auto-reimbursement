#!/usr/bin/env node
/**
 * 一次性排查脚本（P-10）：找出存量数据中「pending 但没有任何待处理原因」的凭证。
 * 旧版「先改后确认」两步请求在确认失败时会留下这种记录，导致凭证在
 * 报销池和待处理页都不可见（且当月无法归档）。新版本已改为原子确认，
 * 待处理页也会把这类记录显示为「修改待确认」，本脚本用于体检旧数据。
 *
 * 用法：node scripts/audit-pending.mjs [数据库路径]
 *   默认读取 data/app.sqlite；线上请在 Railway shell 中执行并传入 /app/data/app.sqlite。
 * 只读操作，不修改任何数据。
 */
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] ?? 'data/app.sqlite';
const database = new DatabaseSync(dbPath, { readOnly: true });

const rows = database.prepare('SELECT id, data FROM receipts').all();
const orphans = [];
for (const row of rows) {
  const receipt = JSON.parse(row.data);
  if (
    receipt.status === 'pending' &&
    Array.isArray(receipt.pendingReasons) &&
    receipt.pendingReasons.length === 0 &&
    receipt.deletedAt === null &&
    receipt.archivedAt === null
  ) {
    orphans.push(receipt);
  }
}

if (orphans.length === 0) {
  console.log('没有发现「pending 且无原因」的凭证，数据健康。');
} else {
  console.log(`发现 ${orphans.length} 张「pending 且无原因」的凭证（旧版两步确认遗留）：`);
  for (const receipt of orphans) {
    console.log(`- ${receipt.id} ${receipt.merchant ?? '(无商户)'} 分类 ${receipt.category ?? '(无)'}`);
  }
  console.log('这些凭证现在会显示在待处理页（标记为「修改待确认」），打开后点「确认可报销」即可回到报销池。');
}
database.close();
