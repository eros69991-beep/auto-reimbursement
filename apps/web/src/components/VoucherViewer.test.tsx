import { describe, expect, it } from 'vitest';

import { panelFractions } from './VoucherViewer';

describe('panelFractions', () => {
  it('turns pixel positions into shares of the whole image width', () => {
    // 756 宽：左边一张 300，分隔线 6，右边一张 450
    expect(panelFractions([{ left: 0, width: 300 }, { left: 306, width: 450 }], 756)).toEqual([
      { left: 0, width: 300 / 756 },
      { left: 306 / 756, width: 450 / 756 },
    ]);
  });

  it('keeps working when the image was shrunk, because only shares are used', () => {
    const fractions = panelFractions([{ left: 0, width: 300 }, { left: 306, width: 450 }], 756)!;
    // 缩小到 378 宽：同样的比例，换算出来是原来的一半
    expect(fractions[1]!.left * 378).toBeCloseTo(153);
    expect(fractions[1]!.width * 378).toBeCloseTo(225);
  });

  it('handles three screenshots', () => {
    const fractions = panelFractions([{ left: 0, width: 100 }, { left: 106, width: 100 }, { left: 212, width: 100 }], 312);
    expect(fractions).toHaveLength(3);
    expect(fractions![2]).toEqual({ left: 212 / 312, width: 100 / 312 });
  });

  it.each([
    ['no positions recorded (single image or old data)', undefined, 756],
    ['a single position', [{ left: 0, width: 756 }], 756],
    ['an unknown image width', [{ left: 0, width: 300 }, { left: 306, width: 450 }], 0],
    ['positions beyond the image', [{ left: 0, width: 300 }, { left: 306, width: 900 }], 756],
    ['positions that overlap', [{ left: 0, width: 300 }, { left: 200, width: 400 }], 756],
    ['positions out of order', [{ left: 306, width: 450 }, { left: 0, width: 300 }], 756],
    ['an empty position', [{ left: 0, width: 0 }, { left: 306, width: 450 }], 756],
    ['a position that is not a number', [{ left: 0, width: Number.NaN }, { left: 306, width: 450 }], 756],
  ])('gives up on %s, so only the whole image is offered', (_name, panels, width) => {
    expect(panelFractions(panels, width)).toBeNull();
  });

  it('tolerates being one pixel off at the right edge', () => {
    expect(panelFractions([{ left: 0, width: 300 }, { left: 306, width: 451 }], 756)).not.toBeNull();
  });
});
