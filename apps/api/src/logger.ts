import { pino } from 'pino';

// 结构化日志（P-17）：JSON 行输出到 stdout，由 Railway/平台收集；
// Authorization 头脱敏；测试环境默认静默（可用 LOG_LEVEL 覆盖）。
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.authorization', 'res.headers["set-cookie"]'],
    remove: true,
  },
});
