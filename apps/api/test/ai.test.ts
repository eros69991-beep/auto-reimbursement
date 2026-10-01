import { CATEGORIES, type Analysis } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createAnalyzer, getApiStatus } from '../src/ai/openai-compatible.js';
import { CATEGORY_HINTS, RECEIPT_PROMPT } from '../src/ai/prompt.js';
import { AiError } from '../src/ai/types.js';
import { validateAnalysis } from '../src/ai/validate.js';
import type { Config } from '../src/config.js';
import { openStore } from '../src/db.js';

const valid: Analysis = {
  amount: '36.33',
  category: '耗材',
  merchant: '店铺',
  date: null,
  confidence: { amount: 0.98, category: 0.94 },
  ambiguous: false,
  keywords: ['包装'],
  evidence: '实付款 36.33',
};

const configured: Config = {
  dataDir: 'data',
  dbPath: 'data/app.sqlite',
  host: '127.0.0.1',
  port: 3000,
  corsOrigins: [],
  ai: {
    baseUrl: 'https://user:password@vision.example/v1/',
    model: 'vision-model-secret-name',
    apiKey: 'top-secret-api-key',
  },
  concurrency: 4,
  accessCodeSha256: null,
  commitSha: null,
};

const unconfigured: Config = { ...configured, ai: null };

type CapturedRequest = {
  input: string | URL | Request;
  init: RequestInit | undefined;
};

function successfulResponse(analysis: unknown = valid): Response {
  return Response.json({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1_788_364_800,
    model: 'provider-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(analysis),
          refusal: null,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function captureFetch(response: Response): {
  fetcher: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ input, init });
    return response;
  }) as typeof fetch;
  return { fetcher, requests };
}

function expectAiError(
  error: unknown,
  code: AiError['code'],
  retryable: boolean,
): void {
  expect(error).toBeInstanceOf(AiError);
  expect(error).toMatchObject({ code, retryable, message: code });
  const message = String(error);
  expect(message).not.toContain('top-secret-api-key');
  expect(message).not.toContain('password');
  expect(message).not.toContain('vision.example');
  expect(message).not.toContain('sensitive upstream body');
}

describe('provider-neutral analysis validation', () => {
  it('accepts the exact category enum and rejects invented categories', () => {
    const exactCategories = [
      '食材',
      '百慕达食材',
      '日常用品',
      '耗材',
      '能耗费',
      '人工费用',
      '肉类',
      '租金及管理费',
      '酒水',
      '员工餐',
    ];

    expect(CATEGORIES).toEqual(exactCategories);
    for (const category of exactCategories) {
      expect(validateAnalysis({ ...valid, category }).category).toBe(category);
    }
    expect(() => validateAnalysis({ ...valid, category: '办公费' })).toThrow(
      'INVALID_RESPONSE',
    );
  });

  it('validates money with the shared exact-fen parser', () => {
    for (const amount of ['0', '0.1', '36.33', '9999999999.99']) {
      expect(validateAnalysis({ ...valid, amount }).amount).toBe(amount);
    }
    for (const amount of [
      '',
      '-1',
      '+1',
      '1.',
      '.1',
      '01e2',
      '36.333',
      '10000000000.00',
    ]) {
      expect(() => validateAnalysis({ ...valid, amount })).toThrow(
        'INVALID_RESPONSE',
      );
    }
  });

  it('accepts real ISO calendar dates including leap days', () => {
    for (const date of ['2024-02-29', '2026-09-03', null]) {
      expect(validateAnalysis({ ...valid, date }).date).toBe(date);
    }
    for (const date of [
      '2023-02-29',
      '2026-02-30',
      '2026-13-01',
      '2026-9-03',
      '2026-09-03T00:00:00Z',
    ]) {
      expect(() => validateAnalysis({ ...valid, date })).toThrow(
        'INVALID_RESPONSE',
      );
    }
  });

  it('requires finite confidence values in the inclusive zero-to-one range', () => {
    for (const confidence of [
      { amount: 0, category: 1 },
      { amount: 1, category: 0 },
    ]) {
      expect(validateAnalysis({ ...valid, confidence }).confidence).toEqual(
        confidence,
      );
    }
    for (const confidence of [
      { amount: -0.01, category: 0.5 },
      { amount: 0.5, category: 1.01 },
      { amount: Number.NaN, category: 0.5 },
      { amount: Number.POSITIVE_INFINITY, category: 0.5 },
    ]) {
      expect(() => validateAnalysis({ ...valid, confidence })).toThrow(
        'INVALID_RESPONSE',
      );
    }
  });

  it('requires ambiguous payment results to leave amount null', () => {
    expect(
      validateAnalysis({ ...valid, amount: null, ambiguous: true }).amount,
    ).toBeNull();
    expect(
      validateAnalysis({ ...valid, amount: null, ambiguous: false }).amount,
    ).toBeNull();
    expect(() => validateAnalysis({ ...valid, ambiguous: true })).toThrow(
      'INVALID_RESPONSE',
    );
  });

  it('enforces field and array limits without coercion', () => {
    expect(
      validateAnalysis({
        ...valid,
        merchant: 'm'.repeat(200),
        keywords: Array.from({ length: 20 }, () => 'k'.repeat(100)),
        evidence: 'e'.repeat(2000),
      }),
    ).toBeTruthy();
    for (const invalid of [
      { merchant: 'm'.repeat(201) },
      { keywords: Array.from({ length: 21 }, () => 'k') },
      { keywords: ['k'.repeat(101)] },
      { evidence: 'e'.repeat(2001) },
      { evidence: 123 },
    ]) {
      expect(() => validateAnalysis({ ...valid, ...invalid })).toThrow(
        'INVALID_RESPONSE',
      );
    }
  });

  it('accepts the optional incomplete flag and order number, and keeps them out when absent', () => {
    expect(validateAnalysis(valid)).toEqual(valid);
    expect('incomplete' in validateAnalysis(valid)).toBe(false);
    expect('orderNo' in validateAnalysis(valid)).toBe(false);

    const partial = validateAnalysis({
      ...valid,
      amount: null,
      incomplete: true,
      orderNo: 'WH20260903001',
    });
    expect(partial).toMatchObject({ amount: null, incomplete: true, orderNo: 'WH20260903001' });
    expect(validateAnalysis({ ...valid, incomplete: false }).incomplete).toBe(false);
    // 模型对不适用的项给 null：当作没给，不写进结果
    const nulls = validateAnalysis({ ...valid, incomplete: null, orderNo: null });
    expect(nulls).toEqual(valid);
    expect('incomplete' in nulls).toBe(false);
    expect('orderNo' in nulls).toBe(false);
    // 标了不完整却给了金额：不当作失败，决策层会把它留给人确认
    expect(validateAnalysis({ ...valid, incomplete: true }).amount).toBe('36.33');
  });

  it('ignores unusable incomplete flags and order numbers instead of failing the recognition', () => {
    // 这两项只是辅助判断：类型不对、空的或太长就当没给，识别结果的其余部分照常通过
    for (const unusable of [
      { incomplete: 'yes' },
      { incomplete: 1 },
      { incomplete: {} },
      { orderNo: '' },
      { orderNo: '   ' },
      { orderNo: 'n'.repeat(101) },
      { orderNo: 1.5 },
      { orderNo: 0 },
      { orderNo: 2 ** 60 },
      { orderNo: ['A1'] },
      { orderNo: false },
    ]) {
      const result = validateAnalysis({ ...valid, ...unusable });
      expect(result).toEqual(valid);
      expect('incomplete' in result).toBe(false);
      expect('orderNo' in result).toBe(false);
    }
    // 订单号全是数字时模型可能给成数字：转成文字收下；前后的空白去掉
    expect(validateAnalysis({ ...valid, orderNo: 20260903001 }).orderNo).toBe('20260903001');
    expect(validateAnalysis({ ...valid, orderNo: '  WH001 ' }).orderNo).toBe('WH001');
    expect(validateAnalysis({ ...valid, orderNo: 'n'.repeat(100) }).orderNo).toHaveLength(100);
    // 识别本身的字段仍然严格，多余的键也仍然不行
    expect(() => validateAnalysis({ ...valid, incomplete: 'yes', ambiguous: 'no' })).toThrow('INVALID_RESPONSE');
    expect(() => validateAnalysis({ ...valid, orderNo: 'A1', unknown: 1 })).toThrow('INVALID_RESPONSE');
  });

  it('requires strict objects at the root and confidence levels', () => {
    for (const input of [
      null,
      [],
      'not an object',
      { ...valid, extra: true },
      { ...valid, confidence: { ...valid.confidence, extra: true } },
    ]) {
      expect(() => validateAnalysis(input)).toThrow('INVALID_RESPONSE');
    }
  });
});

describe('OpenAI-compatible receipt analyzer', () => {
  it('sends the provider-neutral prompt and image to the joined endpoint', async () => {
    const { fetcher, requests } = captureFetch(successfulResponse());

    const result = await createAnalyzer(configured, fetcher).analyzeReceipt({
      bytes: Buffer.from([0, 1, 2, 253, 254, 255]),
      mime: 'image/png',
    });

    expect(result).toEqual(valid);
    expect(requests).toHaveLength(1);
    expect(String(requests[0].input)).toBe(
      'https://user:password@vision.example/v1/chat/completions',
    );
    expect(requests[0].init?.method).toBe('POST');
    expect(requests[0].init?.headers).toEqual({
      Authorization: 'Bearer top-secret-api-key',
      'Content-Type': 'application/json',
    });
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: 'vision-model-secret-name',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_PROMPT },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAEC/f7/' },
            },
          ],
        },
      ],
    });
  });

  it('gives the provider exact payment rules and output vocabulary', () => {
    for (const term of [
      ...CATEGORIES,
      '实付',
      '实付款',
      '实际支付',
      '已支付',
      '支付金额',
      '本次支付',
      '合计支付',
      '原价',
      '优惠',
      '立减',
      '余额',
      '应付',
      '单独运费',
      '退款金额',
      'amount',
      'category',
      'merchant',
      'date',
      'confidence',
      'ambiguous',
      'keywords',
      'evidence',
    ]) {
      expect(RECEIPT_PROMPT).toContain(term);
    }
    expect(RECEIPT_PROMPT).toContain('amount=null');
    expect(RECEIPT_PROMPT).toContain('ambiguous=true');
  });

  it('tells the provider about stitched screenshots, incomplete orders and order numbers', () => {
    // 试点反馈 3：同一单的几张截图拼成一张后重新识别
    for (const term of ['incomplete', 'orderNo', '拼在一起', '灰色竖线', '同一单整体识别', '不要把各段里出现的小计']) {
      expect(RECEIPT_PROMPT).toContain(term);
    }
    expect(RECEIPT_PROMPT).toContain(
      '输出键必须且只能是：amount, category, merchant, date, confidence, ambiguous, keywords, evidence, incomplete, orderNo。',
    );
  });

  it('explains every category so 百慕达食材 is not confused with 食材', () => {
    for (const category of CATEGORIES) {
      expect(CATEGORY_HINTS[category].length).toBeGreaterThan(0);
      expect(RECEIPT_PROMPT).toContain(`- ${category}：${CATEGORY_HINTS[category]}`);
    }
    expect(CATEGORY_HINTS.百慕达食材).toContain('武汉仓');
    expect(CATEGORY_HINTS.百慕达食材).toContain('酒水');
    // AI 必须把仓库/小程序名写进商户和关键词，固定规则和学习规则才有得匹配
    expect(RECEIPT_PROMPT).toContain('merchant 填图中显示的店铺名、小程序名或仓库名');
    expect(RECEIPT_PROMPT).toContain('keywords 必须包含');
  });

  it('rejects unknown response content forms as retryable invalid responses', async () => {
    for (const content of [null, [], [{ type: 'text', text: '{}' }], 7]) {
      const { fetcher } = captureFetch(
        Response.json({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1_788_364_800,
          model: 'provider-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content, refusal: null },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );

      await expect(
        createAnalyzer(configured, fetcher).analyzeReceipt({
          bytes: Buffer.from('image'),
          mime: 'image/jpeg',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAiError(error, 'INVALID_RESPONSE', true);
        return true;
      });
    }
  });

  it('maps terminal configuration and authentication failures', async () => {
    await expect(
      createAnalyzer(unconfigured).analyzeReceipt({
        bytes: Buffer.from('image'),
        mime: 'image/webp',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectAiError(error, 'NOT_CONFIGURED', false);
      return true;
    });

    for (const status of [401, 403]) {
      const { fetcher } = captureFetch(
        new Response('sensitive upstream body', { status }),
      );
      await expect(
        createAnalyzer(configured, fetcher).analyzeReceipt({
          bytes: Buffer.from('image'),
          mime: 'image/jpeg',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAiError(error, 'AUTH', false);
        return true;
      });
    }
  });

  it('maps rate limiting, server errors, and other HTTP failures', async () => {
    for (const [status, code, retryable] of [
      [429, 'RATE_LIMIT', true],
      [500, 'UPSTREAM', true],
      [503, 'UPSTREAM', true],
      [400, 'UPSTREAM', false],
    ] as const) {
      const { fetcher } = captureFetch(
        new Response('sensitive upstream body', { status }),
      );
      await expect(
        createAnalyzer(configured, fetcher).analyzeReceipt({
          bytes: Buffer.from('image'),
          mime: 'image/jpeg',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAiError(error, code, retryable);
        return true;
      });
    }
  });

  it('maps timeouts and network failures without leaking causes', async () => {
    for (const [thrown, code] of [
      [new DOMException('top-secret-api-key', 'TimeoutError'), 'TIMEOUT'],
      [new DOMException('top-secret-api-key', 'AbortError'), 'TIMEOUT'],
      [new TypeError('fetch failed for sensitive upstream body'), 'UPSTREAM'],
    ] as const) {
      const fetcher = (async () => {
        throw thrown;
      }) as typeof fetch;
      await expect(
        createAnalyzer(configured, fetcher).analyzeReceipt({
          bytes: Buffer.from('image'),
          mime: 'image/jpeg',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAiError(error, code, true);
        return true;
      });
    }
  });

  it('maps Error-shaped fetch timeouts without requiring DOMException', async () => {
    const timeout = new Error('top-secret-api-key');
    timeout.name = 'TimeoutError';
    const fetcher = (async () => {
      throw timeout;
    }) as typeof fetch;

    await expect(
      createAnalyzer(configured, fetcher).analyzeReceipt({
        bytes: Buffer.from('image'),
        mime: 'image/jpeg',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectAiError(error, 'TIMEOUT', true);
      return true;
    });
  });

  it('maps a timeout while decoding the response body as TIMEOUT', async () => {
    const timeout = new Error('sensitive upstream body');
    timeout.name = 'TimeoutError';
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(timeout);
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const { fetcher } = captureFetch(response);

    await expect(
      createAnalyzer(configured, fetcher).analyzeReceipt({
        bytes: Buffer.from('image'),
        mime: 'image/jpeg',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectAiError(error, 'TIMEOUT', true);
      return true;
    });
  });

  it('maps malformed upstream JSON, malformed content JSON, and invalid analyses', async () => {
    const malformedBody = new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const malformedContent = successfulResponse('{');
    const fencedContent = successfulResponse('```json\n{}\n```');
    const invalidAnalysis = successfulResponse({ ...valid, category: '办公费' });

    for (const response of [
      malformedBody,
      malformedContent,
      fencedContent,
      invalidAnalysis,
    ]) {
      const { fetcher } = captureFetch(response);
      await expect(
        createAnalyzer(configured, fetcher).analyzeReceipt({
          bytes: Buffer.from('image'),
          mime: 'image/jpeg',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAiError(error, 'INVALID_RESPONSE', true);
        return true;
      });
    }
  });
});

describe('safe AI status', () => {
  it('returns only configured state and a provider label', async () => {
    expect(getApiStatus(unconfigured)).toEqual({
      configured: false,
      provider: null,
    });
    expect(getApiStatus(configured)).toEqual({
      configured: true,
      provider: 'openai-compatible',
    });

    const store = openStore(':memory:');
    try {
      const response = await request(createApp({ store, config: configured }))
        .get('/api/ai/status')
        .set('Authorization', 'Bearer browser-secret');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        configured: true,
        provider: 'openai-compatible',
      });
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('top-secret-api-key');
      expect(serialized).not.toContain('vision-model-secret-name');
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('vision.example');
      expect(response.headers.authorization).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
