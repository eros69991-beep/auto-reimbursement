import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  formGroupLabel,
  formatFen,
  ledgerOf,
  linesCaption,
  receiptCaption,
  type Batch,
  type FormGroup,
  type Payee,
  type Snapshot,
} from '@auto-reimbursement/contracts';

import { payeeRows } from '../payee';
import { useMediaQuery } from '../useMediaQuery';
import { sayFor, type Say } from '../wording';
import { useAuthedUrl } from './AuthedImage';
import { PdfPreview } from './PdfPreview';
import { panelFractions, VoucherViewer, type PanelFraction } from './VoucherViewer';

interface ChecklistReceipt {
  receiptId: string;
  /** 这一行里这张凭证的金额：店内是整张的实报金额；公账的多项凭证（收费通知单）只是这一项的金额 */
  netFen: number;
  paidFen: number;
  refundFen: number;
  /** 在本分类（本部分）里排第几，从 1 起；顺序与报销单摘要里写的金额一致 */
  position: number;
  /** 合并凭证里每张截图在拼图里的位置；单张图、老数据没有 */
  panels: PanelFraction[] | null;
}

interface ChecklistGroup {
  key: string;
  /** 报销单上写的分类名；被拆到多张上的分类，第 2 部分起带「（续）」 */
  label: string;
  group: Pick<FormGroup, 'category' | 'part' | 'period' | 'totalFen'>;
  receipts: ChecklistReceipt[];
}

interface ChecklistSheet {
  id: string;
  /** 第几张报销单，从 1 起 */
  number: number;
  groups: ChecklistGroup[];
}

/**
 * 右边要看的一张凭证图：一张凭证在一张单据上只出现一次，哪怕它在这张单据上占了好几行
 * （一张收费通知单拆成租金、物业费、电费……几行）。和 PDF 里每张单据后面的附件页一一对应。
 */
interface AttachmentItem extends ChecklistReceipt {
  /** 第几张单据 + 凭证号：同一张凭证排在两张单据上时是两项，各自对应各自单据后的附件页 */
  key: string;
  sheetNumber: number;
  /** 这张凭证在本张单据上的第一行 */
  group: ChecklistGroup;
  /** 这张凭证在本张单据上占的所有行（公账的多项凭证有几行，其余只有一行） */
  rows: Array<{ group: ChecklistGroup; receipt: ChecklistReceipt }>;
  item: Snapshot;
}

function attachmentKey(sheetNumber: number, receiptId: string): string {
  return `${sheetNumber}:${receiptId}`;
}

type Tab = 'voucher' | 'list' | 'form';

// 标签上的字用店内的说法写，公账区由 say 换成回单、付款单
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'voucher', label: '凭证' },
  { id: 'list', label: '清单' },
  { id: 'form', label: '报销单' },
];

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
// 窄屏（手机）：界面一次只显示一块（凭证 / 清单 / 报销单），报销单页按至少这么宽画（见 PdfPreview）
const NARROW_QUERY = '(max-width: 899px)';
const FORM_MIN_WIDTH = 960;
// 凭证图这么久还没下完，就提示网络慢并给「重试」
const SLOW_IMAGE_MS = 15_000;

function useSlowFlag(waiting: boolean, resetKey: string): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_IMAGE_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, resetKey]);
  return slow;
}

function imageFailureText(reason: string, say: Say): string {
  const detail = reason === '' || reason === '加载失败' ? '' : `：${reason.replace(/[。.]$/, '')}`;
  return `${say('凭证图片加载失败')}${detail}。`;
}

/**
 * 回单、收费通知单上的收款方（户名、开户银行、银行账号）：放在凭证图旁边，让人对着图核对。
 * 银行账号有十几位、AI 最容易读错一位，它会原样写进付款单的备注栏。只有公账区的凭证有，店内什么都不显示。
 * compact：全屏里地方紧，缩成小字。
 */
function PayeeNote({ payee, compact = false }: { payee: Payee | undefined; compact?: boolean }): React.JSX.Element | null {
  const rows = payeeRows(payee);
  if (rows.length === 0) return null;
  return (
    <div className={compact ? 'attachment-payee attachment-payee-compact' : 'attachment-payee'} role="group" aria-label="收款方信息">
      {!compact && <p className="attachment-payee-title">收款方（会写进付款单的备注栏，请对着图核对）</p>}
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function StepControls({ index, total, onSelect, say }: { index: number; total: number; onSelect: (index: number) => void; say: Say }): React.JSX.Element {
  return (
    <>
      <button type="button" disabled={index <= 0} onClick={() => onSelect(index - 1)}>
        上一张
      </button>
      <span className="attachment-position" aria-label={`${say('全部凭证中的第')} ${index + 1} 张，共 ${total} 张`}>
        {index + 1} / {total}
      </span>
      <button type="button" disabled={index < 0 || index >= total - 1} onClick={() => onSelect(index + 1)}>
        下一张
      </button>
    </>
  );
}

/** compact：全屏底栏地方紧，「恢复适宽」只写「适宽」（读屏仍念完整名字） */
function ZoomControls({ zoom, onZoom, compact = false }: { zoom: number; onZoom: (next: number) => void; compact?: boolean }): React.JSX.Element {
  return (
    <>
      <button type="button" disabled={zoom >= ZOOM_MAX} onClick={() => onZoom(Math.min(ZOOM_MAX, zoom * ZOOM_STEP))}>
        放大
      </button>
      <button type="button" disabled={zoom <= ZOOM_MIN} onClick={() => onZoom(Math.max(ZOOM_MIN, zoom / ZOOM_STEP))}>
        缩小
      </button>
      <button type="button" aria-label="恢复适宽" disabled={zoom === 1} onClick={() => onZoom(1)}>
        {compact ? '适宽' : '恢复适宽'}
      </button>
    </>
  );
}

/** 合并出来的凭证：同一单被截成几张时，逐张截图看（拼成一张后整张缩得太小，字看不清）。 */
function PanelControls({ count, active, onPick }: { count: number; active: number | 'all'; onPick: (frame: number | 'all') => void }): React.JSX.Element {
  return (
    <div className="attachment-panels" role="group" aria-label="合并的截图">
      {Array.from({ length: count }, (_, index) => (
        <button key={index} type="button" aria-pressed={active === index} onClick={() => onPick(index)}>
          截图 {index + 1}
        </button>
      ))}
      <button type="button" aria-pressed={active === 'all'} onClick={() => onPick('all')}>
        整图
      </button>
    </div>
  );
}

/**
 * 同屏对账工作区。
 * 宽屏：左边「对账清单」——按报销单、分类列出每张凭证的实报金额（顺序同报销单摘要，大字可点），
 * 下面是报销单原样的 PDF 预览；右边：当前凭证图。点一个金额，右边切到那张凭证，清单同步高亮。
 * 窄屏（手机）：一次只显示一块——「凭证」（默认）、「清单」、「报销单」三个标签整屏切换，
 * 凭证图占满剩下的高度，还能「全屏查看」；在清单里点一个金额会直接切到凭证。
 * 合并出来的凭证可以逐张截图看（截图 1 / 截图 2 / 整图）。
 * 关联基于 receiptId（不依赖数组下标）。
 */
export function ReconcileWorkspace({ batch, previewUrl }: { batch: Batch; previewUrl: string }): React.JSX.Element {
  // 公账批次：单据叫付款单、凭证叫回单，一张收费通知单在清单里占好几行
  const ledger = ledgerOf(batch);
  const say = sayFor(ledger);
  const sheets = useMemo<ChecklistSheet[]>(() => {
    const itemById = new Map(batch.items.map((item) => [item.receiptId, item]));
    return batch.sheets.map((sheet, sheetIndex) => ({
      id: sheet.id,
      number: sheetIndex + 1,
      // 顺序就用报销单上的分组顺序和组内顺序（与摘要里的金额、PDF 附件页一致），不再另排
      groups: sheet.groups.map((group, groupIndex) => ({
        key: `${sheet.id}:${groupIndex}`,
        label: formGroupLabel(group),
        group,
        receipts: group.receiptIds
          .flatMap((receiptId, slot) => {
            const item = itemById.get(receiptId);
            return item === undefined ? [] : [{ item, slot }];
          })
          .map(({ item, slot }, index) => ({
            receiptId: item.receiptId,
            // 多项凭证在每一行里只占这一项的金额（单据上这一行写的就是它）；别的凭证是整张的实报金额
            netFen: item.lines === undefined ? item.netFen : (group.amountsFen[slot] ?? item.netFen),
            paidFen: item.paidFen,
            refundFen: item.refundFen,
            position: index + 1,
            panels: panelFractions(item.original.panels, item.original.width),
          })),
      })),
    }));
  }, [batch]);

  const attachments = useMemo<AttachmentItem[]>(() => {
    const itemById = new Map(batch.items.map((item) => [item.receiptId, item]));
    return sheets.flatMap((sheet) => {
      // 一张凭证在这张单据上占的行，按它第一次出现的顺序排
      const rowsByReceipt = new Map<string, AttachmentItem['rows']>();
      for (const group of sheet.groups) {
        for (const receipt of group.receipts) {
          const rows = rowsByReceipt.get(receipt.receiptId) ?? [];
          rows.push({ group, receipt });
          rowsByReceipt.set(receipt.receiptId, rows);
        }
      }
      return [...rowsByReceipt].map(([receiptId, rows]) => ({
        ...rows[0]!.receipt,
        key: attachmentKey(sheet.number, receiptId),
        sheetNumber: sheet.number,
        group: rows[0]!.group,
        rows,
        item: itemById.get(receiptId)!,
      }));
    });
  }, [sheets, batch]);

  const narrow = useMediaQuery(NARROW_QUERY);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('voucher');
  // 窄屏上报销单预览等第一次点开「报销单」标签才开始加载（先把带宽留给凭证图），点开过就一直挂着，来回切换不重新加载
  const [formOpened, setFormOpened] = useState(false);
  const [zoom, setZoom] = useState(1);
  // 合并凭证当前看哪一张截图（从 0 起），或整图
  const [frame, setFrame] = useState<number | 'all'>(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [failedReceiptId, setFailedReceiptId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  const pdfRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const current = attachments.find((item) => item.key === selectedKey) ?? attachments[0] ?? null;
  const currentIndex = current === null ? -1 : attachments.indexOf(current);
  const imageFailed = current !== null && failedReceiptId === current.receiptId;
  // 传相对路径：fetchBlobUrl 内部会拼 API 地址（传完整 URL 曾被拼两次导致 404）。
  // size=view：大图（几 MB 的拼图、没压缩过的 PNG）给缩小版，手机和慢网下少等一会儿；小图原样。
  const { url: imageUrl, failed: fetchFailed, error: fetchError } = useAuthedUrl(
    current === null || imageFailed
      ? null
      : `/api/receipts/${encodeURIComponent(current.receiptId)}/original-image?size=view&r=${retryCount}`,
  );
  const imageSlow = useSlowFlag(current !== null && !imageFailed && !fetchFailed && imageUrl === null, `${current?.receiptId}:${retryCount}`);

  const frames = current?.panels ?? null;
  const frameIndex = frames === null || frame === 'all' ? null : Math.min(frame, frames.length - 1);
  const panel = frames === null || frameIndex === null ? null : frames[frameIndex]!;

  // 报销单原样跟随滚动到当前凭证所属的那张报销单（多页报销单里夹着备注续页，不能按页码推算）；
  // 窄屏上从别的标签切到「报销单」时也定位一次。
  const sheetIndexRef = useRef(0);
  useEffect(() => {
    sheetIndexRef.current = current === null ? 0 : current.sheetNumber - 1;
  });
  useEffect(() => {
    if (current === null) return;
    const canvas = pdfRef.current?.querySelector(`canvas[data-sheet-index="${current.sheetNumber - 1}"]`);
    (canvas as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, tab]);

  // 用上一张 / 下一张切换时，清单里对应的金额也滚进可见范围（清单自己在区内滚动）。
  useEffect(() => {
    if (current === null) return;
    const chips = listRef.current?.querySelectorAll<HTMLElement>('[data-receipt-id]') ?? [];
    for (const chip of chips) {
      if (chip.dataset.receiptId === current.receiptId && chip.dataset.sheetNumber === String(current.sheetNumber)) {
        chip.scrollIntoView?.({ block: 'nearest' });
        break;
      }
    }
  }, [current, tab]);

  function closeFullscreen(): void {
    setFullscreen(false);
    setZoom(1);
    openerRef.current?.focus();
  }

  // 全屏时锁住背后页面的滚动，按 Esc 关闭
  useEffect(() => {
    if (!fullscreen) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFullscreen(false);
        setZoom(1);
        openerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen]);

  function select(key: string): void {
    setSelectedKey(key);
    setFailedReceiptId(null);
    // 换一张凭证，合并凭证从第一张截图看起
    setFrame(0);
  }

  function openTab(next: Tab): void {
    setTab(next);
    if (next === 'form') setFormOpened(true);
  }

  function retry(): void {
    setFailedReceiptId(null);
    setRetryCount((value) => value + 1);
  }

  const caption = current === null
    ? ''
    : current.item.lines === undefined
      ? receiptCaption({
        sheetNumber: current.sheetNumber,
        group: current.group.group,
        position: current.position,
        count: current.group.receipts.length,
        netFen: current.netFen,
        ledger,
      })
      // 一张通知单占了好几行：说明里写它的合计，再列出每一项（分类、月份、金额），和 PDF 附件页页眉一致
      : linesCaption(
        current.sheetNumber,
        current.item,
        current.rows.map((row) => ({ group: row.group.group, position: row.receipt.position, count: row.group.receipts.length, fen: row.receipt.netFen })),
        ledger,
      );

  // 图片区：失败 / 加载中 / 图片本身。内联和全屏共用，同一时刻只有一处在画
  function imageArea(): React.JSX.Element {
    if (current === null) return <></>;
    if (imageFailed || fetchFailed) {
      return (
        <div className="attachment-image-scroll">
          <p role="alert" className="attachment-message">
            {imageFailureText(imageFailed ? '' : fetchError, say)}{' '}
            <button type="button" onClick={retry}>重试</button>
          </p>
        </div>
      );
    }
    if (imageUrl === null) {
      return (
        <div className="attachment-image-scroll">
          {imageSlow ? (
            <p role="status" className="attachment-message">
              {say('网络很慢，凭证图片还在加载……')}{' '}
              <button type="button" onClick={retry}>重试</button>
            </p>
          ) : (
            <p aria-hidden="true" className="attachment-message">图片加载中…</p>
          )}
        </div>
      );
    }
    return (
      <VoucherViewer
        imageUrl={imageUrl}
        alt={`${say('凭证')} ${currentIndex + 1}：${current.rows.length > 1 ? current.rows.map((row) => row.group.label).join('、') : current.group.label} ${formatFen(current.item.netFen)}`}
        zoom={zoom}
        panel={panel}
        onError={() => setFailedReceiptId(current.receiptId)}
      />
    );
  }

  const stepControls = current === null
    ? null
    : <StepControls index={currentIndex} total={attachments.length} onSelect={(index) => select(attachments[index]!.key)} say={say} />;
  const panelControls = frames === null
    ? null
    : <PanelControls count={frames.length} active={frameIndex ?? 'all'} onPick={setFrame} />;

  return (
    <div className="reconcile" data-tab={current === null ? 'all' : tab}>
      {current !== null && (
        <div className="reconcile-tabs" role="group" aria-label="对账视图">
          {TABS.map((item) => (
            <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => openTab(item.id)}>
              {say(item.label)}
            </button>
          ))}
        </div>
      )}
      <div className="reconcile-form">
        {current !== null && (
          <section className="reconcile-list" aria-label="对账清单" ref={listRef}>
            {sheets.map((sheet) => (
              <div key={sheet.id} className="reconcile-sheet">
                <h3 className="reconcile-sheet-title">{say(`第 ${sheet.number} 张报销单`)}</h3>
                {sheet.groups.map((group) => (
                  <div key={group.key} className="reconcile-group">
                    <p className="reconcile-group-head">
                      <strong>{group.label}</strong>
                      <span>{group.receipts.length} 张 · 合计 {formatFen(group.group.totalFen)}</span>
                    </p>
                    <ul className="reconcile-amounts" aria-label={`${group.label}${say('的凭证金额')}`}>
                      {group.receipts.map((receipt) => (
                        <li key={receipt.receiptId}>
                          <button
                            type="button"
                            className="reconcile-amount"
                            data-receipt-id={receipt.receiptId}
                            data-sheet-number={sheet.number}
                            aria-current={receipt.receiptId === current.receiptId && sheet.number === current.sheetNumber}
                            aria-label={`${formatFen(receipt.netFen)}（${group.label} 第 ${receipt.position}/${group.receipts.length} 张）`}
                            onClick={() => {
                              select(attachmentKey(sheet.number, receipt.receiptId));
                              // 窄屏上点了金额就是要看这张凭证：直接切过去
                              setTab('voucher');
                            }}
                          >
                            {formatFen(receipt.netFen)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
        <section className="reconcile-pdf" aria-label={say('报销单原样')} ref={pdfRef}>
          {(!narrow || formOpened) && (
            <PdfPreview
              url={previewUrl}
              ledger={ledger}
              minWidth={narrow ? FORM_MIN_WIDTH : 0}
              onSheetDrawn={(sheetIndex, canvas) => {
                // 预览比选中凭证晚到时，画好当前凭证所属的那张就跳过去
                if (sheetIndex === sheetIndexRef.current) canvas.scrollIntoView?.({ block: 'nearest' });
              }}
            />
          )}
        </section>
      </div>
      <section className="reconcile-side" aria-label={say('凭证附件')}>
        {current === null ? (
          <p>{say('本批次没有关联凭证。')}</p>
        ) : (
          <div className="attachment-viewer">
            <p className="attachment-title">{caption}</p>
            <PayeeNote payee={current.item.payee} />
            {current.refundFen > 0 && (
              <p className="attachment-note">
                原实付 {formatFen(current.paidFen)} / 退款 {formatFen(current.refundFen)} / 实报 {formatFen(current.netFen)}
              </p>
            )}
            <div className="attachment-toolbar">
              {stepControls}
              <button type="button" className="attachment-fullscreen" ref={openerRef} onClick={() => setFullscreen(true)}>
                全屏查看
              </button>
              <span className="attachment-zoom">
                <ZoomControls zoom={zoom} onZoom={setZoom} />
              </span>
            </div>
            {panelControls}
            {fullscreen ? <div className="attachment-image-scroll" aria-hidden="true" /> : imageArea()}
          </div>
        )}
      </section>
      {fullscreen && current !== null && createPortal(
        <div className="voucher-fullscreen" role="dialog" aria-modal="true" aria-label={say('凭证大图')}>
          <div className="voucher-fullscreen-top">
            <button type="button" autoFocus onClick={closeFullscreen}>关闭全屏</button>
            <p className="voucher-fullscreen-caption">{caption}</p>
          </div>
          <PayeeNote payee={current.item.payee} compact />
          {imageArea()}
          <div className="voucher-fullscreen-bottom">
            <div className="voucher-fullscreen-row">
              {stepControls}
              <ZoomControls zoom={zoom} onZoom={setZoom} compact />
            </div>
            {panelControls}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
