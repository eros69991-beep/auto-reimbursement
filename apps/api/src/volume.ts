import { existsSync } from 'node:fs';
import { join } from 'node:path';

// P-09：卷自检。REQUIRE_VOLUME=1 时，DATA_DIR 下必须存在运营人员事先在卷上写入的
// .volume-id 标记文件；不存在说明卷没挂上（目录是容器临时盘上的新建目录），
// 应拒绝启动，避免数据静默写到临时盘、重新部署后全部丢失。
export const VOLUME_MARKER = '.volume-id';

export function volumeMarkerMissing(dataDir: string): boolean {
  return !existsSync(join(dataDir, VOLUME_MARKER));
}
