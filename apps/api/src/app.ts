import express from 'express';
import { MulterError } from 'multer';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { createRouter, HttpError } from './routes.js';

type AppDependencies = { store: Store; config: Config };

export function createApp(deps?: AppDependencies): express.Express {
  const application = express();
  application.use(express.json({ limit: '1mb' }));

  application.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  if (deps !== undefined) {
    application.use('/api', createRouter(deps.store, deps.config));
  }

  application.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (
        error instanceof MulterError &&
        (error.code === 'LIMIT_FILE_SIZE' ||
          error.code === 'LIMIT_FILE_COUNT' ||
          error.code === 'LIMIT_FIELD_COUNT')
      ) {
        response.status(413).json({
          code: 'UPLOAD_LIMIT',
          message: '上传图片数量或大小超出限制',
        });
        return;
      }
      if (error instanceof HttpError) {
        response.status(error.status).json({
          code: error.code,
          message: error.message,
        });
        return;
      }
      if (
        error instanceof Error &&
        'status' in error &&
        error.status === 413
      ) {
        response.status(413).json({
          code: 'BODY_TOO_LARGE',
          message: '请求内容过大',
        });
        return;
      }
      response.status(500).json({
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
      });
    },
  );

  return application;
}

export const app = createApp();
