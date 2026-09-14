import type { Category, Snapshot } from '@auto-reimbursement/contracts';
import { describe, expect, it } from 'vitest';

import {
  groupItems,
  groupHeight,
  moveGroup,
  packGroups,
  wrapAmounts,
  type LayoutMetrics,
} from '../src/render/layout.js';
import { sampleReceipt } from './support.js';

describe('measured reimbursement layout', () => {
  const metrics: LayoutMetrics = {
    summaryWidth: 55,
    bodyHeight: 40,
    lineHeight: 10,
    groupPadding: 10,
    maxSheetFen: 999999999,
    measure: (text) => text.length * 5,
  };

  it('keeps categories intact and amounts in upload order', () => {
    const item = (
      receiptId: string,
      category: Category,
      uploadOrder: number,
      netFen: number,
    ): Snapshot => ({
      receiptId,
      category,
      uploadOrder,
      netFen,
      paidFen: netFen,
      refundFen: 0,
      original: sampleReceipt().original,
      refundImages: [],
    });
    const groups = groupItems([
      item('b', '耗材', 2, 1730),
      item('a', '耗材', 1, 3633),
      item('c', '食材', 3, 100),
    ]);

    expect(groups[0]!.amountsFen).toEqual([3633, 1730]);
    const sheets = packGroups(groups, metrics);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.groups[0]!.totalFen).toBe(5363);
  });

  it('wraps only whole formatted amounts and rejects a token wider than the summary', () => {
    expect(wrapAmounts([100, 200, 300], metrics)).toEqual(['1.00  2.00', '3.00']);
    expect(() => wrapAmounts([100], { ...metrics, summaryWidth: 10 })).toThrow(
      'LAYOUT_OVERFLOW',
    );
  });

  it('rejects a category that cannot fit a sheet before creating a partial layout', () => {
    const groups = groupItems([
      snapshot('too-tall', '耗材', 1, 100),
      snapshot('other', '食材', 2, 100),
    ]);

    expect(() => packGroups(groups, { ...metrics, bodyHeight: 19 })).toThrow(
      'CATEGORY_TOO_LARGE',
    );
    expect(() => packGroups(groups, { ...metrics, maxSheetFen: 99 })).toThrow(
      'CATEGORY_TOO_LARGE',
    );
  });

  it('moves a whole category to the adjacent sheet without reordering its receipts', () => {
    const groups = groupItems([
      snapshot('first', '耗材', 1, 100),
      snapshot('second', '耗材', 2, 200),
      snapshot('third', '食材', 3, 300),
    ]);
    const sheets = packGroups(groups, metrics);

    const moved = moveGroup(sheets, '耗材', 1, metrics);

    expect(moved).toEqual([
      {
        id: 'sheet-001',
        noteId: null,
        groups: [
          {
            category: '食材',
            receiptIds: ['third'],
            amountsFen: [300],
            totalFen: 300,
          },
        ],
      },
      {
        id: 'sheet-002',
        noteId: null,
        groups: [
          {
            category: '耗材',
            receiptIds: ['first', 'second'],
            amountsFen: [100, 200],
            totalFen: 300,
          },
        ],
      },
    ]);
  });

  it('does not permit moves that overflow the adjacent sheet', () => {
    const groups = groupItems([
      snapshot('first', '耗材', 1, 100),
      snapshot('second', '食材', 2, 100),
    ]);
    const sheets = packGroups(groups, { ...metrics, bodyHeight: 20 });

    expect(() => moveGroup(sheets, '耗材', 1, { ...metrics, bodyHeight: 20 })).toThrow(
      'CATEGORY_TOO_LARGE',
    );
  });

  it('calculates group height from measured wrapped lines', () => {
    expect(groupHeight(groupItems([
      snapshot('one', '耗材', 1, 100),
      snapshot('two', '耗材', 2, 200),
      snapshot('three', '耗材', 3, 300),
    ])[0]!, metrics)).toBe(30);
  });
});

function snapshot(
  receiptId: string,
  category: Category,
  uploadOrder: number,
  netFen: number,
): Snapshot {
  return {
    receiptId,
    category,
    uploadOrder,
    netFen,
    paidFen: netFen,
    refundFen: 0,
    original: sampleReceipt().original,
    refundImages: [],
  };
}
