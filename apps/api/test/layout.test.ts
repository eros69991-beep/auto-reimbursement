import { formGroupLabel, type Category, type FormGroup, type FormSheet, type Snapshot } from '@auto-reimbursement/contracts';
import { describe, expect, it } from 'vitest';

import {
  AMOUNT_GAP,
  groupHeight,
  groupItems,
  groupRows,
  mergedRowBoundaries,
  moveGroup,
  packGroups,
  placeGroups,
  sheetRowCapacity,
  summaryLines,
  type LayoutMetrics,
} from '../src/render/layout.js';
import { sampleReceipt } from './support.js';

// 测试用的量尺：每个字符宽 5，摘要栏宽 130（放得下 3 个 5 位金额），一行高 20，表体 5 行。
// 1000–9999 分（10.00–99.99，5 个字符）时每行正好放 3 个金额。
const metrics: LayoutMetrics = {
  summaryWidth: 130,
  bodyHeight: 100,
  lineHeight: 10,
  groupPadding: 10,
  maxSheetFen: 999999999,
  measure: (text) => text.length * 5,
};

describe('measured reimbursement layout', () => {
  it('keeps categories intact and amounts in upload order', () => {
    const groups = groupItems([
      snapshot('b', '耗材', 2, 1730),
      snapshot('a', '耗材', 1, 3633),
      snapshot('c', '食材', 3, 100),
    ]);

    expect(groups[0]!.amountsFen).toEqual([3633, 1730]);
    expect(groups[0]!.receiptIds).toEqual(['a', 'b']);
    const sheets = packGroups(groups, metrics);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.groups[0]!.totalFen).toBe(5363);
    expect(sheets[0]!.groups[0]!.part).toBeUndefined();
  });

  describe('summary rows', () => {
    it('writes every receipt amount in upload order on one row while it fits', () => {
      expect(summaryLines([49000, 1988, 23160], metrics)).toEqual([
        ['490.00', '19.88', '231.60'].join(AMOUNT_GAP),
      ]);
      expect(summaryLines([], metrics)).toEqual([]);
    });

    it('continues on the next row when a row is full and never reorders amounts', () => {
      const lines = summaryLines([1000, 1100, 1200, 1300, 1400, 1500, 1600], metrics);
      expect(lines).toEqual([
        ['10.00', '11.00', '12.00'].join(AMOUNT_GAP),
        ['13.00', '14.00', '15.00'].join(AMOUNT_GAP),
        '16.00',
      ]);
      for (const line of lines) expect(metrics.measure(line)).toBeLessThanOrEqual(metrics.summaryWidth);
    });

    it('still writes one amount per row when a single amount is wider than the column', () => {
      expect(summaryLines([123456, 654321], { ...metrics, summaryWidth: 20 })).toEqual(['1234.56', '6543.21']);
    });

    it('gives a category as many rows as its amount rows need, at least one', () => {
      const group = (amounts: number[]): FormGroup => groupItems(
        amounts.map((fen, index) => snapshot(`r${index}`, '耗材', index + 1, fen)),
      )[0]!;
      expect(groupRows(group([1000]), metrics)).toBe(1);
      expect(groupRows(group([1000, 1100, 1200]), metrics)).toBe(1);
      expect(groupRows(group([1000, 1100, 1200, 1300]), metrics)).toBe(2);
      expect(groupHeight(group(Array.from({ length: 7 }, () => 1000)), metrics)).toBe(3 * 20);
      expect(groupRows({ category: '耗材', receiptIds: [], amountsFen: [], totalFen: 0 }, metrics)).toBe(1);
    });
  });

  describe('packing', () => {
    it('puts categories that fit the remaining rows on the same sheet', () => {
      const sheets = packGroups(groupItems([
        ...many('肉类', 4, 1),
        ...many('酒水', 1, 10),
        ...many('耗材', 7, 20),
      ]), metrics);
      // 肉类 2 行 + 酒水 1 行 + 耗材 3 行 = 6 行 > 5 → 耗材整个换到下一张
      expect(sheetLayout(sheets)).toEqual([['肉类:2', '酒水:1'], ['耗材:3']]);
    });

    it('moves a category to the next sheet whole when it fits a sheet by itself', () => {
      const sheets = packGroups(groupItems([
        ...many('肉类', 6, 1),
        ...many('食材', 12, 10),
      ]), metrics);
      // 肉类 2 行，食材 4 行：本页只剩 3 行放不下，但一张装得下，所以整个换页而不是拆开
      expect(sheetLayout(sheets)).toEqual([['肉类:2'], ['食材:4']]);
      expect(sheets.flatMap((sheet) => sheet.groups).every((group) => group.part === undefined)).toBe(true);
    });

    it('splits a category of more than five rows across sheets with a subtotal per part', () => {
      const items = many('食材', 21, 1);
      const sheets = packGroups(groupItems(items), metrics);

      expect(sheetLayout(sheets)).toEqual([['食材:5'], ['食材:2']]);
      const [first, second] = sheets.map((sheet) => sheet.groups[0]!);
      expect([first!.part, second!.part]).toEqual([1, 2]);
      expect(first!.amountsFen).toHaveLength(15);
      expect(second!.amountsFen).toHaveLength(6);
      expect(first!.totalFen + second!.totalFen).toBe(items.reduce((sum, item) => sum + item.netFen, 0));
      expect(first!.totalFen).toBe(first!.amountsFen.reduce((sum, fen) => sum + fen, 0));
      expect(second!.totalFen).toBe(second!.amountsFen.reduce((sum, fen) => sum + fen, 0));
      // 各部分合起来还是原来的顺序
      expect([...first!.receiptIds, ...second!.receiptIds]).toEqual(items.map((item) => item.receiptId));
      expect([...first!.amountsFen, ...second!.amountsFen]).toEqual(items.map((item) => item.netFen));
      expect([formGroupLabel(first!), formGroupLabel(second!)]).toEqual(['食材', '食材（续）']);
    });

    it('starts a split category in the free rows of the current sheet to avoid wasting them', () => {
      const sheets = packGroups(groupItems([
        ...many('肉类', 1, 1),
        ...many('食材', 21, 10),
      ]), metrics);

      // 肉类 1 行 + 食材第一部分 4 行；食材第二部分 3 行
      expect(sheetLayout(sheets)).toEqual([['肉类:1', '食材:4'], ['食材:3']]);
      expect(sheets[0]!.groups[1]!.part).toBe(1);
      expect(sheets[1]!.groups[0]!.part).toBe(2);
      expect(sheets[0]!.groups[1]!.amountsFen).toHaveLength(12);
      expect(sheets[1]!.groups[0]!.amountsFen).toHaveLength(9);
    });

    it('starts on a fresh sheet when the current one is already full', () => {
      const sheets = packGroups(groupItems([
        ...many('肉类', 15, 1),
        ...many('食材', 18, 20),
      ]), metrics);
      expect(sheetLayout(sheets)).toEqual([['肉类:5'], ['食材:5'], ['食材:1']]);
    });

    it('never puts two parts of a category on one sheet and keeps every sheet within its rows', () => {
      const categories: Category[] = ['食材', '肉类', '酒水', '耗材', '员工餐'];
      let seed = 12345;
      const next = (limit: number): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % limit;
      };
      for (let round = 0; round < 40; round += 1) {
        const items: Snapshot[] = [];
        for (const category of categories) {
          for (let index = next(45); index > 0; index -= 1) {
            items.push(snapshot(`${round}-${items.length}`, category, items.length + 1, 1 + next(120000)));
          }
        }
        if (items.length === 0) continue;
        const groups = groupItems(items);
        const sheets = packGroups(groups, metrics);

        for (const sheet of sheets) {
          expect(sheet.groups.length).toBeGreaterThan(0);
          expect(placeGroups(sheet.groups, metrics).reduce((rows, placement) => rows + placement.rowCount, 0))
            .toBeLessThanOrEqual(sheetRowCapacity(metrics));
          expect(new Set(sheet.groups.map((group) => group.category)).size).toBe(sheet.groups.length);
        }
        for (const original of groups) {
          const parts = sheets.flatMap((sheet) => sheet.groups).filter((group) => group.category === original.category);
          expect([...parts.flatMap((part) => part.receiptIds)]).toEqual(original.receiptIds);
          expect([...parts.flatMap((part) => part.amountsFen)]).toEqual(original.amountsFen);
          expect(parts.reduce((sum, part) => sum + part.totalFen, 0)).toBe(original.totalFen);
          expect(parts.map((part) => part.part)).toEqual(
            parts.length === 1 ? [undefined] : parts.map((_, index) => index + 1),
          );
          for (const part of parts) {
            expect(part.totalFen).toBe(part.amountsFen.reduce((sum, fen) => sum + fen, 0));
          }
        }
      }
    });

    it('also splits by amount when a sheet cannot carry the total', () => {
      const sheets = packGroups(groupItems(many('食材', 3, 1)), { ...metrics, maxSheetFen: 2500 });
      expect(sheets.map((sheet) => sheet.groups.map((group) => [group.part, group.amountsFen.length, group.totalFen]))).toEqual([
        [[1, 2, 2001]],
        [[2, 1, 1002]],
      ]);
    });

    it('rejects an amount that no sheet can carry before creating a partial layout', () => {
      const groups = groupItems([
        snapshot('too-big', '耗材', 1, 100),
        snapshot('other', '食材', 2, 100),
      ]);

      expect(() => packGroups(groups, { ...metrics, bodyHeight: 19 })).toThrow('CATEGORY_TOO_LARGE');
      expect(() => packGroups(groups, { ...metrics, maxSheetFen: 99 })).toThrow('CATEGORY_TOO_LARGE');
    });
  });

  describe('placement on a sheet', () => {
    it('lays categories out row by row and reports the lines to write', () => {
      const sheets = packGroups(groupItems([
        snapshot('a', '肉类', 1, 7800),
        ...many('食材', 4, 10),
      ]), metrics);
      const placements = placeGroups(sheets[0]!.groups, metrics);

      expect(placements.map(({ group, startRow, rowCount }) => [group.category, startRow, rowCount])).toEqual([
        ['肉类', 0, 1],
        ['食材', 1, 2],
      ]);
      expect(placements[0]!.lines).toEqual(['78.00']);
      expect(placements[1]!.lines).toHaveLength(2);
    });

    it('does not draw lines inside a multi-row category in the merged columns', () => {
      const sheets = packGroups(groupItems([
        snapshot('a', '肉类', 1, 7800),
        ...many('食材', 7, 10),
        snapshot('b', '酒水', 99000, 5600),
      ]), metrics);
      const placements = placeGroups(sheets[0]!.groups, metrics);
      // 肉类第 0 行；食材第 1–3 行（内部的横线是第 2、3 条）；酒水第 4 行
      expect([...mergedRowBoundaries(placements)].sort()).toEqual([2, 3]);
      expect(mergedRowBoundaries(placeGroups([], metrics)).size).toBe(0);
    });

    it('reports a layout that no longer fits as outdated', () => {
      const tooMany: FormGroup[] = [
        ...Array.from({ length: 3 }, (_, index) => ({
          category: (['食材', '肉类', '酒水'] as const)[index]!,
          receiptIds: Array.from({ length: 7 }, (_, receipt) => `${index}-${receipt}`),
          amountsFen: Array.from({ length: 7 }, () => 1000),
          totalFen: 7000,
        })),
      ];
      expect(() => placeGroups(tooMany, metrics)).toThrow('LAYOUT_OUTDATED');
    });
  });

  describe('moving categories between sheets', () => {
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
          groups: [{ category: '食材', receiptIds: ['third'], amountsFen: [300], totalFen: 300 }],
        },
        {
          id: 'sheet-002',
          noteId: null,
          groups: [{ category: '耗材', receiptIds: ['first', 'second'], amountsFen: [100, 200], totalFen: 300 }],
        },
      ]);
    });

    it('does not permit moves that overflow the adjacent sheet', () => {
      const groups = groupItems([
        snapshot('first', '耗材', 1, 100),
        snapshot('second', '食材', 2, 100),
      ]);
      const oneRow = { ...metrics, bodyHeight: 20 };
      const sheets = packGroups(groups, oneRow);

      expect(() => moveGroup(sheets, '耗材', 1, oneRow)).toThrow('CATEGORY_TOO_LARGE');
    });

    it('counts rows, not categories, when checking whether the destination has room', () => {
      const sheets = packGroups(groupItems([
        ...many('食材', 12, 1), // 4 行
        ...many('肉类', 6, 100), // 2 行：放不下本页，单独一张
        snapshot('c', '耗材', 999000, 100), // 1 行：和肉类同一张
      ]), metrics);
      expect(sheetLayout(sheets)).toEqual([['食材:4'], ['肉类:2', '耗材:1']]);

      // 耗材上移到第一张正好补满 5 行
      expect(sheetLayout(moveGroup(sheets, '耗材', -1, metrics))).toEqual([['食材:4', '耗材:1'], ['肉类:2']]);
      // 肉类上移则超出 5 行
      expect(() => moveGroup(sheets, '肉类', -1, metrics)).toThrow('CATEGORY_TOO_LARGE');
    });

    it('refuses to move a category that was split across sheets', () => {
      const sheets = packGroups(groupItems([...many('食材', 21, 1), snapshot('x', '酒水', 99000, 5600)]), metrics);
      expect(sheetLayout(sheets)).toEqual([['食材:5'], ['食材:2', '酒水:1']]);

      expect(() => moveGroup(sheets, '食材', 1, metrics)).toThrow('CATEGORY_SPLIT');
      expect(() => moveGroup(sheets, '食材', -1, metrics)).toThrow('CATEGORY_SPLIT');
      // 其他分类照常可以挪：往后挪会新开一张，往前挪第一张已经满了
      expect(sheetLayout(moveGroup(sheets, '酒水', 1, metrics))).toEqual([['食材:5'], ['食材:2'], ['酒水:1']]);
      expect(() => moveGroup(sheets, '酒水', -1, metrics)).toThrow('CATEGORY_TOO_LARGE');
    });

    it('rejects moves that go nowhere and unknown categories', () => {
      const sheets = packGroups(groupItems([snapshot('a', '耗材', 1, 100)]), metrics);
      expect(() => moveGroup(sheets, '耗材', -1, metrics)).toThrow('INVALID_LAYOUT');
      expect(() => moveGroup(sheets, '酒水', 1, metrics)).toThrow('INVALID_LAYOUT');
      expect(() => moveGroup(sheets, '耗材', 0 as 1, metrics)).toThrow('INVALID_LAYOUT');
    });

    it('reports a stored layout that no longer fits as outdated instead of moving anything', () => {
      // 旧版式里每个分类只占一行：一个分类有 21 张金额，在新版式里要 7 行，一张放不下
      const outdated: FormSheet[] = [{
        id: 'sheet-001',
        noteId: null,
        groups: [{
          category: '食材',
          receiptIds: Array.from({ length: 21 }, (_, index) => `r${index}`),
          amountsFen: Array.from({ length: 21 }, () => 1000),
          totalFen: 21000,
        }],
      }];
      expect(() => moveGroup(outdated, '食材', 1, metrics)).toThrow('LAYOUT_OUTDATED');
    });
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

// count 张同类凭证，金额 10.00 起每张加 0.01（5 个字符，每行 3 个）；
// base 区分上传顺序，让不同分类的凭证按调用顺序排列。
function many(category: Category, count: number, base: number): Snapshot[] {
  return Array.from({ length: count }, (_, index) =>
    snapshot(`${category}-${index}`, category, base * 1000 + index, 1000 + index),
  );
}

// 每张报销单上「分类:占几行」，用来一眼看排版。
function sheetLayout(sheets: FormSheet[]): string[][] {
  return sheets.map((sheet) =>
    sheet.groups.map((group) => `${group.category}:${groupRows(group, metrics)}`),
  );
}
