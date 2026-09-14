import {
  formatFen,
  type Category,
  type FormGroup,
  type FormSheet,
  type Snapshot,
} from '@auto-reimbursement/contracts';

export interface LayoutMetrics {
  summaryWidth: number;
  bodyHeight: number;
  lineHeight: number;
  groupPadding: number;
  maxSheetFen: number;
  measure: (text: string) => number;
}

export class LayoutError extends Error {
  constructor(
    code: 'LAYOUT_OVERFLOW' | 'CATEGORY_TOO_LARGE' | 'INVALID_LAYOUT',
    readonly details: Record<string, number | string> = {},
  ) {
    super(code);
  }
}

export function defaultMetrics(): LayoutMetrics {
  return {
    summaryWidth: (98 * 72) / 25.4 - 12,
    bodyHeight: (58 * 72) / 25.4,
    lineHeight: 14,
    groupPadding: 8,
    maxSheetFen: 999999999,
    measure: (text) => text.length * 5,
  };
}

export function groupItems(items: Snapshot[]): FormGroup[] {
  const groups = new Map<Category, FormGroup>();
  for (const item of [...items].sort((left, right) => left.uploadOrder - right.uploadOrder)) {
    const existing = groups.get(item.category);
    if (existing === undefined) {
      groups.set(item.category, {
        category: item.category,
        receiptIds: [item.receiptId],
        amountsFen: [item.netFen],
        totalFen: item.netFen,
      });
      continue;
    }
    existing.receiptIds.push(item.receiptId);
    existing.amountsFen.push(item.netFen);
    existing.totalFen = addFen(existing.totalFen, item.netFen);
  }
  for (const group of groups.values()) {
    formatFen(group.totalFen);
  }
  return [...groups.values()];
}

export function wrapAmounts(amountsFen: number[], metrics: LayoutMetrics): string[] {
  const lines: string[] = [];
  let line = '';
  for (const amount of amountsFen) {
    const token = formatFen(amount);
    if (metrics.measure(token) > metrics.summaryWidth) {
      throw new LayoutError('LAYOUT_OVERFLOW', { requiredWidth: metrics.measure(token) });
    }
    const next = line === '' ? token : `${line}  ${token}`;
    if (metrics.measure(next) <= metrics.summaryWidth) {
      line = next;
    } else {
      lines.push(line);
      line = token;
    }
  }
  return line === '' ? lines : [...lines, line];
}

export function groupHeight(group: FormGroup, metrics: LayoutMetrics): number {
  return (
    Math.max(metrics.lineHeight, wrapAmounts(group.amountsFen, metrics).length * metrics.lineHeight) +
    metrics.groupPadding
  );
}

export function packGroups(groups: FormGroup[], metrics: LayoutMetrics): FormSheet[] {
  for (const group of groups) {
    assertGroupFits(group, metrics);
  }

  const sheets: FormSheet[] = [];
  for (const group of groups) {
    const current = sheets.at(-1);
    if (current !== undefined && sheetFits([...current.groups, group], metrics)) {
      current.groups.push(copyGroup(group));
      continue;
    }
    sheets.push({
      id: sheetId(sheets.length + 1),
      groups: [copyGroup(group)],
      noteId: null,
    });
  }
  return sheets;
}

export function moveGroup(
  sheets: FormSheet[],
  category: Category,
  direction: -1 | 1,
  metrics: LayoutMetrics,
): FormSheet[] {
  if (direction !== -1 && direction !== 1) {
    throw new LayoutError('INVALID_LAYOUT');
  }
  const copied = sheets.map(copySheet);
  const matches: Array<{ sheetIndex: number; groupIndex: number }> = [];
  for (const [sheetIndex, sheet] of copied.entries()) {
    for (const [groupIndex, group] of sheet.groups.entries()) {
      if (group.category === category) {
        matches.push({ sheetIndex, groupIndex });
      }
    }
  }
  if (matches.length !== 1) {
    throw new LayoutError('INVALID_LAYOUT');
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
      requiredHeight: sheetHeight([...destination.groups, group], metrics),
      requiredAmount: sheetAmount([...destination.groups, group]),
    });
  }
  copied[source.sheetIndex]!.groups.splice(source.groupIndex, 1);
  destination.groups.push(group);
  return copied.filter((sheet) => sheet.groups.length > 0);
}

function assertGroupFits(group: FormGroup, metrics: LayoutMetrics): void {
  const requiredHeight = groupHeight(group, metrics);
  const requiredAmount = group.totalFen;
  if (requiredHeight > metrics.bodyHeight || requiredAmount > metrics.maxSheetFen) {
    throw new LayoutError('CATEGORY_TOO_LARGE', {
      category: group.category,
      requiredHeight,
      requiredAmount,
    });
  }
}

export function sheetFits(groups: FormGroup[], metrics: LayoutMetrics): boolean {
  for (const group of groups) {
    assertGroupFits(group, metrics);
  }
  return sheetHeight(groups, metrics) <= metrics.bodyHeight && sheetAmount(groups) <= metrics.maxSheetFen;
}

function sheetHeight(groups: FormGroup[], metrics: LayoutMetrics): number {
  return groups.reduce((height, group) => height + groupHeight(group, metrics), 0);
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
  return {
    category: group.category,
    receiptIds: [...group.receiptIds],
    amountsFen: [...group.amountsFen],
    totalFen: group.totalFen,
  };
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
