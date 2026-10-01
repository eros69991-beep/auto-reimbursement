import {
  formatFen,
  groupKey,
  type Category,
  type FormGroup,
  type FormSheet,
  type Snapshot,
} from '@auto-reimbursement/contracts';

export interface LayoutMetrics {
  summaryWidth: number;
  bodyHeight: number;
  rowHeight?: number;
  lineHeight: number;
  groupPadding: number;
  maxSheetFen: number;
  measure: (text: string) => number;
}

export class LayoutError extends Error {
  constructor(
    code:
      | 'LAYOUT_OVERFLOW'
      | 'CATEGORY_TOO_LARGE'
      | 'INVALID_LAYOUT'
      | 'CATEGORY_SPLIT'
      | 'LAYOUT_OUTDATED',
    readonly details: Record<string, number | string> = {},
  ) {
    super(code);
  }
}

/** 摘要栏里相邻两张金额之间隔开的空格（普通空格，复制出来的文字也是「金额 金额」）。 */
export const AMOUNT_GAP = '    ';

export function defaultMetrics(): LayoutMetrics {
  return {
    summaryWidth: (90.8 * 72) / 25.4 - 12,
    bodyHeight: (55.22 * 72) / 25.4,
    rowHeight: ((55.22 / 5) * 72) / 25.4,
    lineHeight: 14,
    groupPadding: 8,
    maxSheetFen: 999999999,
    measure: (text) => text.length * 5,
  };
}

/**
 * 把凭证排成一行一行（FormGroup）：一行是一个「分类 + 月份」，店内没有月份，就是一个分类一行。
 * 公账区的多项凭证（收费通知单）按它的每一项分到各自的行里，同一张凭证因此出现在好几行；
 * 每一行里的凭证、金额按上传顺序排。行按第一次出现的顺序排。
 */
export function groupItems(items: Snapshot[]): FormGroup[] {
  const groups = new Map<string, FormGroup>();
  const add = (category: Category, period: string | undefined, receiptId: string, fen: number): void => {
    const key = groupKey({ category, period });
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        category,
        // 店内的行不写月份，和以前存下来的排版一样
        ...(period === undefined ? {} : { period }),
        receiptIds: [receiptId],
        amountsFen: [fen],
        totalFen: fen,
      });
      return;
    }
    // 同一张凭证在同一行只出现一次（正常数据里同一张凭证的行不会重复，这里防脏数据）
    if (existing.receiptIds.at(-1) === receiptId) {
      existing.amountsFen[existing.amountsFen.length - 1] = existing.amountsFen.at(-1)! + fen;
    } else {
      existing.receiptIds.push(receiptId);
      existing.amountsFen.push(fen);
    }
    existing.totalFen = addFen(existing.totalFen, fen);
  };
  for (const item of [...items].sort((left, right) => left.uploadOrder - right.uploadOrder)) {
    if (item.lines === undefined) {
      add(item.category, item.period, item.receiptId, item.netFen);
    } else {
      for (const line of item.lines) add(line.category, line.period, item.receiptId, line.fen);
    }
  }
  for (const group of groups.values()) {
    formatFen(group.totalFen);
  }
  return [...groups.values()];
}

function rowUnit(metrics: LayoutMetrics): number {
  return metrics.rowHeight ?? metrics.lineHeight + metrics.groupPadding;
}

/** 一张报销单表体能放几行（生产环境是 5，与纸面的 5 行对齐）。 */
export function sheetRowCapacity(metrics: LayoutMetrics): number {
  return Math.floor(metrics.bodyHeight / rowUnit(metrics) + 1e-6);
}

// 摘要栏：每张实报金额按上传顺序排列、空格隔开，一行放不下就接着写下一行（逐个往后放的贪心折行）。
// 从第 start 张金额开始，在最多 freeRows 行、金额合计不超过 freeFen 的限制内尽量多放，
// 返回放了几张和这几张的合计。折行的判断只此一处：每行放几个（lineCounts）、
// 分页时一张报销单放多少（packGroups）、绘制时每行写什么（summaryLines）都出自它，
// 所以排版和绘制不会对不上；贪心折行对前缀也是稳定的，拆开后各部分的折行与整体一致。
function takeAmounts(
  amountsFen: number[],
  start: number,
  freeRows: number,
  freeFen: number,
  metrics: LayoutMetrics,
): { count: number; fen: number } {
  let rows = 0;
  let line = '';
  let inLine = 0;
  let count = 0;
  let fen = 0;
  for (let index = start; index < amountsFen.length; index += 1) {
    const value = amountsFen[index]!;
    const amount = formatFen(value);
    const candidate = inLine === 0 ? amount : `${line}${AMOUNT_GAP}${amount}`;
    const startsRow = inLine === 0 || metrics.measure(candidate) > metrics.summaryWidth;
    if (rows + (startsRow ? 1 : 0) > freeRows || fen + value > freeFen) break;
    if (startsRow) {
      rows += 1;
      line = amount;
      inLine = 1;
    } else {
      line = candidate;
      inLine += 1;
    }
    count += 1;
    fen += value;
  }
  return { count, fen };
}

// 每一行放了几个金额。
function lineCounts(amountsFen: number[], metrics: LayoutMetrics): number[] {
  const counts: number[] = [];
  let start = 0;
  while (start < amountsFen.length) {
    const { count } = takeAmounts(amountsFen, start, 1, Number.POSITIVE_INFINITY, metrics);
    if (count === 0) break;
    counts.push(count);
    start += count;
  }
  return counts;
}

/** 摘要栏每一行要写的文字，例如 `490.00    19.88    231.60`。 */
export function summaryLines(amountsFen: number[], metrics: LayoutMetrics): string[] {
  const lines: string[] = [];
  let index = 0;
  for (const count of lineCounts(amountsFen, metrics)) {
    lines.push(amountsFen.slice(index, index + count).map(formatFen).join(AMOUNT_GAP));
    index += count;
  }
  return lines;
}

/** 一个分类在报销单上占几行：摘要栏每行一排金额，至少占一行。 */
export function groupRows(group: FormGroup, metrics: LayoutMetrics): number {
  return Math.max(1, lineCounts(group.amountsFen, metrics).length);
}

export function groupHeight(group: FormGroup, metrics: LayoutMetrics): number {
  return groupRows(group, metrics) * rowUnit(metrics);
}

export interface GroupPlacement {
  group: FormGroup;
  /** 从表体第几行开始（0 起） */
  startRow: number;
  rowCount: number;
  /** 摘要栏每一行的文字，共 rowCount 行（空分类为空数组） */
  lines: string[];
}

/**
 * 算出一张报销单上每个分类从第几行开始、占几行、摘要每行写什么。
 * 放不下（旧版式生成的草稿在新版式下可能出现）抛 LAYOUT_OUTDATED。
 */
export function placeGroups(groups: FormGroup[], metrics: LayoutMetrics): GroupPlacement[] {
  let startRow = 0;
  const placements = groups.map((group) => {
    const lines = summaryLines(group.amountsFen, metrics);
    const rowCount = Math.max(1, lines.length);
    const placement: GroupPlacement = { group, startRow, rowCount, lines };
    startRow += rowCount;
    return placement;
  });
  const capacity = sheetRowCapacity(metrics);
  if (startRow > capacity) {
    throw new LayoutError('LAYOUT_OUTDATED', { rows: startRow, capacity });
  }
  return placements;
}

/**
 * 分类占多行时，它内部的横线在「报销项目」「金额」两栏不画（像合并单元格）。
 * 返回这些横线的序号：第 k 条横线在表体第 k-1 行与第 k 行之间。
 */
export function mergedRowBoundaries(placements: GroupPlacement[]): Set<number> {
  const merged = new Set<number>();
  for (const { startRow, rowCount } of placements) {
    for (let offset = 1; offset < rowCount; offset += 1) merged.add(startRow + offset);
  }
  return merged;
}

/**
 * 把分类依次排到报销单上。
 * - 本页剩余的行放得下，整个分类放本页；
 * - 放不下但一张报销单装得下，整个分类换到下一张；
 * - 一张都装不下（超过表体行数），从本页剩余的行开始排，排满接下一张，
 *   每一部分各有小计，第 2 部分起带 part 序号（报销单上写「分类（续）」）。
 * keepTogether：在好几行里都出现的凭证（公账区的收费通知单拆成了几项）的 id。它的各行是连着的一块，
 * 本页剩下的地方放不下这一整块、但一张新单放得下时，整块换到新的一张，免得一张通知单被拆在两张单上。
 * 不给（店内）就和以前完全一样。
 */
export function packGroups(
  groups: FormGroup[],
  metrics: LayoutMetrics,
  keepTogether: ReadonlySet<string> = new Set(),
): FormSheet[] {
  for (const group of groups) {
    assertAmountsFit(group, metrics);
  }

  const sheets: FormSheet[] = [];
  const openSheet = (): FormSheet => {
    const sheet: FormSheet = { id: sheetId(sheets.length + 1), groups: [], noteId: null };
    sheets.push(sheet);
    return sheet;
  };

  for (const chunk of chunkGroups(groups, keepTogether)) {
    if (chunk.length > 1) {
      const current = sheets.at(-1);
      const fitsHere = current !== undefined && sheetFits([...current.groups, ...chunk], metrics);
      if (!fitsHere && sheetFits(chunk, metrics)) openSheet();
    }
    for (const group of chunk) {
      const current = sheets.at(-1);
      if (current !== undefined && sheetFits([...current.groups, group], metrics)) {
        current.groups.push(copyGroup(group));
      } else if (sheetFits([group], metrics)) {
        openSheet().groups.push(copyGroup(group));
      } else {
        splitAcrossSheets(group, sheets, openSheet, metrics);
      }
    }
  }
  return sheets;
}

// 连着的几行如果有同一张（keepTogether 里的）凭证，就算一块；没有的各自一块。
function chunkGroups(groups: FormGroup[], keepTogether: ReadonlySet<string>): FormGroup[][] {
  if (keepTogether.size === 0) return groups.map((group) => [group]);
  const chunks: FormGroup[][] = [];
  let ids = new Set<string>();
  for (const group of groups) {
    const chunk = group.receiptIds.some((id) => ids.has(id)) ? chunks.at(-1) : undefined;
    if (chunk === undefined) {
      chunks.push([group]);
      ids = new Set();
    } else {
      chunk.push(group);
    }
    for (const id of group.receiptIds) {
      if (keepTogether.has(id)) ids.add(id);
    }
  }
  return chunks;
}

function splitAcrossSheets(
  group: FormGroup,
  sheets: FormSheet[],
  openSheet: () => FormSheet,
  metrics: LayoutMetrics,
): void {
  const capacity = sheetRowCapacity(metrics);
  let start = 0;
  let part = 1;
  while (start < group.amountsFen.length) {
    const sheet = sheets.at(-1);
    // 还没有报销单时当作「已满」，下面会新开一张
    const usedRows = sheet === undefined ? capacity : sheetRows(sheet.groups, metrics);
    const usedFen = sheet === undefined ? metrics.maxSheetFen : sheetAmount(sheet.groups);
    const { count, fen } = takeAmounts(
      group.amountsFen,
      start,
      capacity - usedRows,
      metrics.maxSheetFen - usedFen,
      metrics,
    );

    if (count === 0 || sheet === undefined) {
      if (sheet !== undefined && sheet.groups.length === 0) {
        // 连空白的一张也放不下一张金额
        throw new LayoutError('CATEGORY_TOO_LARGE', { category: group.category, requiredAmount: group.totalFen });
      }
      openSheet();
      continue;
    }
    sheet.groups.push({
      category: group.category,
      ...(group.period === undefined ? {} : { period: group.period }),
      receiptIds: group.receiptIds.slice(start, start + count),
      amountsFen: group.amountsFen.slice(start, start + count),
      totalFen: fen,
      part,
    });
    start += count;
    part += 1;
  }
}

/** 把一行（分类 + 月份；店内没有月份）挪到前一张或后一张报销单。 */
export function moveGroup(
  sheets: FormSheet[],
  category: Category,
  direction: -1 | 1,
  metrics: LayoutMetrics,
  period?: string,
): FormSheet[] {
  if (direction !== -1 && direction !== 1) {
    throw new LayoutError('INVALID_LAYOUT');
  }
  assertSheetsFit(sheets, metrics);
  const copied = sheets.map(copySheet);
  const matches: Array<{ sheetIndex: number; groupIndex: number }> = [];
  for (const [sheetIndex, sheet] of copied.entries()) {
    for (const [groupIndex, group] of sheet.groups.entries()) {
      if (group.category === category && group.period === period) {
        matches.push({ sheetIndex, groupIndex });
      }
    }
  }
  if (matches.length === 0) {
    throw new LayoutError('INVALID_LAYOUT');
  }
  // 凭证多到分在几张报销单上的分类，各部分的先后顺序和小计是固定的，不能单独挪
  if (matches.length > 1) {
    throw new LayoutError('CATEGORY_SPLIT', { category });
  }
  const source = matches[0]!;
  if (direction === -1 && source.sheetIndex === 0) {
    throw new LayoutError('INVALID_LAYOUT');
  }

  const group = copied[source.sheetIndex]!.groups[source.groupIndex]!;
  let destination: FormSheet;
  if (direction === 1 && source.sheetIndex === copied.length - 1) {
    destination = { id: nextSheetId(copied), groups: [], noteId: null };
    copied.push(destination);
  } else {
    destination = copied[source.sheetIndex + direction]!;
  }

  if (!sheetFits([...destination.groups, group], metrics)) {
    throw new LayoutError('CATEGORY_TOO_LARGE', {
      category,
      requiredRows: sheetRows([...destination.groups, group], metrics),
      requiredAmount: sheetAmount([...destination.groups, group]),
    });
  }
  copied[source.sheetIndex]!.groups.splice(source.groupIndex, 1);
  destination.groups.push(group);
  return copied.filter((sheet) => sheet.groups.length > 0);
}

// 一个分类再大也能拆开排，只有单张金额本身就超过一张报销单能写的上限时才真的放不下。
function assertAmountsFit(group: FormGroup, metrics: LayoutMetrics): void {
  const largest = group.amountsFen.reduce((largestSoFar, fen) => Math.max(largestSoFar, fen), 0);
  if (sheetRowCapacity(metrics) < 1 || largest > metrics.maxSheetFen) {
    throw new LayoutError('CATEGORY_TOO_LARGE', {
      category: group.category,
      requiredAmount: largest,
    });
  }
}

/** 已存的排版在当前版式下有报销单放不下（旧版式生成的草稿）时抛 LAYOUT_OUTDATED。 */
export function assertSheetsFit(sheets: FormSheet[], metrics: LayoutMetrics): void {
  const capacity = sheetRowCapacity(metrics);
  for (const sheet of sheets) {
    const rows = sheetRows(sheet.groups, metrics);
    if (rows > capacity) {
      throw new LayoutError('LAYOUT_OUTDATED', { sheetId: sheet.id, rows, capacity });
    }
  }
}

export function sheetFits(groups: FormGroup[], metrics: LayoutMetrics): boolean {
  return sheetRows(groups, metrics) <= sheetRowCapacity(metrics) && sheetAmount(groups) <= metrics.maxSheetFen;
}

export function sheetRows(groups: FormGroup[], metrics: LayoutMetrics): number {
  return groups.reduce((rows, group) => rows + groupRows(group, metrics), 0);
}

function sheetAmount(groups: FormGroup[]): number {
  return groups.reduce((amount, group) => addFen(amount, group.totalFen), 0);
}

function addFen(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new Error('INVALID_AMOUNT');
  }
  formatFen(result);
  return result;
}

function copyGroup(group: FormGroup): FormGroup {
  const copy: FormGroup = {
    category: group.category,
    receiptIds: [...group.receiptIds],
    amountsFen: [...group.amountsFen],
    totalFen: group.totalFen,
  };
  if (group.period !== undefined) copy.period = group.period;
  if (group.part !== undefined) copy.part = group.part;
  return copy;
}

function copySheet(sheet: FormSheet): FormSheet {
  return { id: sheet.id, noteId: sheet.noteId, groups: sheet.groups.map(copyGroup) };
}

function sheetId(number: number): string {
  return `sheet-${String(number).padStart(3, '0')}`;
}

function nextSheetId(sheets: FormSheet[]): string {
  const largest = sheets.reduce((largestId, sheet) => {
    const match = /^sheet-(\d+)$/.exec(sheet.id);
    return match === null ? largestId : Math.max(largestId, Number(match[1]));
  }, 0);
  return sheetId(largest + 1);
}
