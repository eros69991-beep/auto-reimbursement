#!/usr/bin/env node
/**
 * 一次性排查脚本（P-03）：找出存量数据中「退款大于实付」的凭证。
 * 这类脏数据曾导致报销池白屏；新版本已阻止产生，本脚本用于体检旧数据。
 *
 * 用法：node scripts/audit-refunds.mjs [数据库路径]
 *   默认读取 data/app.sqlite；线上请在 Railway shell 中执行并传入 /app/data/app.sqlite。
 * 只读操作，不修改任何数据。
 */
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] ?? 'data/app.sqlite';
const database = new DatabaseSync(dbPath, { readOnly: true });

const rows = database.prepare('SELECT id, data FROM receipts').all();
const dirty = [];
for (const row of rows) {
  const receipt = JSON.parse(row.data);
  if (
    typeof receipt.paidFen === 'number' &&
    typeof receipt.refundFen === 'number' &&
    receipt.refundFen > receipt.paidFen
  ) {
    dirty.push(receipt);
  }
}

if (dirty.length === 0) {
  console.log('没有发现「退款大于实付」的凭证，数据健康。');
} else {
  console.log(`发现 ${dirty.length} 张「退款大于实付」的凭证：`);
  for (const receipt of dirty) {
    console.log(
      `- ${receipt.id} ${receipt.merchant ?? '(无商户)'} 实付 ${(receipt.paidFen / 100).toFixed(2)} 退款 ${(receipt.refundFen / 100).toFixed(2)} 状态 ${receipt.status}`,
    );
  }
  console.log('请在界面中把这些凭证的退款调整到不超过实付金额。');
}
database.close();
