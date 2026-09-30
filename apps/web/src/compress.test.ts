import { describe, expect, it } from 'vitest';

import { compressionScale } from './compress';

describe('client-side compression scale', () => {
  it('keeps long receipts readable by limiting total pixels instead of the long edge', () => {
    // 1080×5000 的长小票：按长边 2000px 会缩成 432px 宽；按面积缩放后仍有约 885px 宽
    const scale = compressionScale(1080, 5000);
    expect(Math.round(1080 * scale)).toBeGreaterThanOrEqual(880);
    expect(Math.round(5000 * scale)).toBeLessThanOrEqual(4096);
  });

  it('shrinks a 12MP phone photo to about 4MP and never enlarges small images', () => {
    const scale = compressionScale(3024, 4032);
    expect(3024 * scale * 4032 * scale).toBeLessThanOrEqual(4_000_001);
    expect(compressionScale(800, 600)).toBe(1);
  });
});
