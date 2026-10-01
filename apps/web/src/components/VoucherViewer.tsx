import { useLayoutEffect, useRef } from 'react';

/** 合并凭证里一张截图在拼图里的位置，用占整张图宽度的比例（0–1）表示。 */
export interface PanelFraction {
  left: number;
  width: number;
}

/**
 * 把合并凭证记下的每张截图位置（像素，从左起）换算成占整张图宽度的比例。
 * 图被缩小过（对账用的缩小版）时像素对不上，但比例不变，所以只存比例。
 * 单张图、老数据没有 panels，或数据对不上整张图的宽度（不可信）时返回 null，这时只能整张看。
 */
export function panelFractions(
  panels: Array<{ left: number; width: number }> | undefined,
  imageWidth: number,
): PanelFraction[] | null {
  if (panels === undefined || panels.length < 2 || !(imageWidth > 0)) return null;
  const fractions: PanelFraction[] = [];
  let edge = 0;
  for (const panel of panels) {
    const valid = Number.isFinite(panel.left) && Number.isFinite(panel.width) &&
      panel.width > 0 && panel.left >= edge && panel.left + panel.width <= imageWidth + 1;
    if (!valid) return null;
    fractions.push({ left: panel.left / imageWidth, width: Math.min(panel.width, imageWidth - panel.left) / imageWidth });
    edge = panel.left + panel.width;
  }
  return fractions;
}

/**
 * 凭证图的滚动查看区：图宽 = 容器宽 × 缩放（看某一张截图时，再放大到让这一张刚好撑满容器宽），
 * 切换截图时把滚动位置对到那一张的左边缘。
 * 图要可以比容器宽（放大、拼图），所以必须覆盖全局的 max-width: 100%。
 */
export function VoucherViewer({
  imageUrl,
  alt,
  zoom,
  panel,
  onError,
}: {
  imageUrl: string;
  alt: string;
  zoom: number;
  /** 当前看的那张截图；null 表示整张图 */
  panel: PanelFraction | null;
  onError: () => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const hadPanelRef = useRef(false);
  const panelLeft = panel?.left ?? null;
  const panelWidth = panel?.width ?? null;

  function align(): void {
    const scroller = scrollRef.current;
    const image = imageRef.current;
    if (scroller === null || image === null) return;
    if (panelLeft !== null) {
      scroller.scrollLeft = Math.round(panelLeft * image.clientWidth);
      hadPanelRef.current = true;
    } else if (hadPanelRef.current) {
      // 从某张截图切回整图：回到最左边；一直是整图时不动用户自己滚的位置
      scroller.scrollLeft = 0;
      hadPanelRef.current = false;
    }
  }

  // 只在换截图、改缩放、换图时对位；不能每次重绘都对，否则会把用户自己滑动的位置弹回去
  useLayoutEffect(align, [panelLeft, panelWidth, zoom, imageUrl]);

  const fit = panelWidth === null ? 100 : 100 / panelWidth;
  return (
    <div className="attachment-image-scroll" ref={scrollRef}>
      <img
        ref={imageRef}
        key={imageUrl}
        src={imageUrl}
        alt={alt}
        style={{ width: `${zoom * fit}%` }}
        onLoad={align}
        onError={onError}
      />
    </div>
  );
}
