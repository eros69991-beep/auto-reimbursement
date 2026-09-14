import express from 'express';
import { MulterError } from 'multer';

import { LOCAL_CORS_ORIGINS, type Config } from './config.js';
import type { Store } from './db.js';
import type { RecognitionQueue } from './queue.js';
import { createRouter, HttpError } from './routes.js';

type AppDependencies = {
  store: Store;
  config: Config;
  queue?: RecognitionQueue;
};

export function createApp(deps?: AppDependencies): express.Express {
  const application = express();
  const allowedOrigins = deps?.config.corsOrigins ?? [...LOCAL_CORS_ORIGINS];
  application.use((request, response, next) => {
    const origin = request.get('origin');
    const allowed = origin !== undefined && allowedOrigins.includes(origin);
    if (origin !== undefined) {
      response.vary('Origin');
    }
    if (allowed) {
      response.set('Access-Control-Allow-Origin', origin);
    }

    if (request.method === 'OPTIONS') {
      if (!allowed) {
        rejectCrossOrigin(response);
        return;
      }
      response.set(
        'Access-Control-Allow-Methods',
        'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      response.set(
        'Access-Control-Allow-Headers',
        request.get('access-control-request-headers') ?? 'content-type',
      );
      response.status(204).end();
      return;
    }

    if (!isMutation(request.method) || origin === undefined || allowed) {
      next();
      return;
    }
    rejectCrossOrigin(response);
  });
  application.use(express.json({ limit: '1mb' }));

  application.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  if (deps !== undefined) {
    application.use('/api', createRouter(deps.store, deps.config, deps.queue));
  }

  application.use(
    (
      error: unknown,
      request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (
        error instanceof MulterError &&
        error.code === 'LIMIT_UNEXPECTED_FILE' &&
        request.method === 'POST' &&
        request.path === '/api/settings/signature'
      ) {
        response.status(400).json({
          code: 'INVALID_SIGNATURE_IMAGE',
          message: '签名图片参数无效',
        });
        return;
      }
      if (
        error instanceof MulterError &&
        error.code === 'LIMIT_UNEXPECTED_FILE' &&
        request.method === 'POST' &&
        /^\/api\/receipts\/[^/]+\/refund-images$/.test(request.path)
      ) {
        response.status(400).json({
          code: 'INVALID_REFUND_IMAGE',
          message: '退款凭证图片参数无效',
        });
        return;
      }
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
      if (
        error instanceof SyntaxError &&
        'status' in error &&
        error.status === 400
      ) {
        if (request.method === 'PUT' && request.path === '/api/settings') {
          response.status(400).json({
            code: 'INVALID_SETTINGS',
            message: '请求参数无效',
          });
          return;
        }
        if (
          (request.method === 'POST' && request.path === '/api/notes') ||
          (request.method === 'PUT' && /^\/api\/notes\/[^/]+$/.test(request.path))
        ) {
          response.status(400).json({
            code: 'INVALID_NOTE',
            message: '请求参数无效',
          });
          return;
        }
        if (
          request.method === 'PATCH' &&
          /^\/api\/receipts\/[^/]+$/.test(request.path)
        ) {
          response.status(400).json({
            code: 'INVALID_RECEIPT_PATCH',
            message: '请求参数无效',
          });
          return;
        }
        if (
          request.method === 'PUT' &&
          /^\/api\/receipts\/[^/]+\/refund$/.test(request.path)
        ) {
          response.status(400).json({
            code: 'INVALID_REFUND',
            message: '请求参数无效',
          });
          return;
        }
        if (request.method === 'POST' && request.path === '/api/batches') {
          response.status(400).json({
            code: 'INVALID_BATCH_REQUEST',
            message: '请求参数无效',
          });
          return;
        }
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

function isMutation(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function rejectCrossOrigin(response: express.Response): void {
  response.status(403).json({
    code: 'CROSS_ORIGIN_MUTATION',
    message: '拒绝非本机来源的修改请求',
  });
}
