import { createHash, timingSafeEqual } from 'node:crypto';

import type express from 'express';

import type { Config } from './config.js';

export function hashAccessCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Bearer 访问码鉴权。未配置 ACCESS_CODE_SHA256 时放行（本机开发模式）；
 * 配置后所有 /api 请求必须携带 `Authorization: Bearer <访问码>`。
 * /health 在 /api 之外，不受影响。
 */
export function requireAccess(config: Config): express.RequestHandler {
  const expected = config.accessCodeSha256;
  return (request, response, next) => {
    if (expected === null) {
      next();
      return;
    }
    const header = request.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const candidate = match === null ? null : hashAccessCode(match[1]);
    if (
      candidate !== null &&
      candidate.length === expected.length &&
      timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'))
    ) {
      next();
      return;
    }
    response.status(401).json({
      code: 'UNAUTHORIZED',
      message: '需要访问码',
    });
  };
}
