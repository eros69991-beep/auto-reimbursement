import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { uploadReceipts } from '../src/receipts.js';
import { businessDate, businessMonth } from '../src/time.js';

// P-23：业务日期/月份必须按 Asia/Shanghai 计算。
// Railway 默认 TZ=UTC，月初北京时间 0–8 点的记录若用服务器时区会被错归上月。
describe('business time zone (P-23)', () => {
  it('treats UTC 16:30 on Sep 30 as October in Shanghai (00:30 next day)', () => {
    const now = new Date('2026-09-30T16:30:00.000Z');
    expect(businessMonth(now)).toBe('2026-10');
    expect(businessDate(now)).toBe('2026-10-01');
  });

  it('keeps UTC 15:59:59 on Sep 30 inside September (23:59:59 in Shanghai)', () => {
    const now = new Date('2026-09-30T15:59:59.000Z');
    expect(businessMonth(now)).toBe('2026-09');
    expect(businessDate(now)).toBe('2026-09-30');
  });

  it('is independent of the server local time zone', () => {
    // 用 UTC 零点验证：服务器无论在哪个时区，上海口径都应是当天 08:00
    const now = new Date('2026-09-04T00:00:00.000Z');
    expect(businessDate(now)).toBe('2026-09-04');
    expect(businessMonth(now)).toBe('2026-09');
  });

  describe('upload month attribution', () => {
    let store: Store;
    let temp: string;
    let config: Config;

    beforeEach(async () => {
      store = openStore(':memory:');
      temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-time-'));
      config = loadConfig({ DATA_DIR: temp }, temp);
    });

    afterEach(async () => {
      store.close();
      await rm(temp, { recursive: true, force: true });
    });

    it('attributes a receipt uploaded at Beijing 00:30 on Oct 1 to 2026-10', async () => {
      const png = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 16, g: 32, b: 48 },
        },
      })
        .png()
        .toBuffer();

      const result = await uploadReceipts(
        store,
        config,
        [{ name: 'receipt.png', mime: 'image/png', bytes: png }],
        new Date('2026-09-30T16:30:00.000Z'),
      );

      expect(result.rejected).toHaveLength(0);
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]?.month).toBe('2026-10');
    });
  });
});
