import type { Analysis, ApiStatus } from '@auto-reimbursement/contracts';

import type { Config } from '../config.js';
import { RECEIPT_PROMPT } from './prompt.js';
import { AiError, type AiImage, type ReceiptAnalyzer } from './types.js';
import { validateAnalysis } from './validate.js';

function contentFromResponse(input: unknown): string {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('choices' in input) ||
    !Array.isArray(input.choices) ||
    typeof input.choices[0] !== 'object' ||
    input.choices[0] === null ||
    !('message' in input.choices[0]) ||
    typeof input.choices[0].message !== 'object' ||
    input.choices[0].message === null ||
    !('content' in input.choices[0].message) ||
    typeof input.choices[0].message.content !== 'string'
  ) {
    throw new AiError('INVALID_RESPONSE', true);
  }
  return input.choices[0].message.content;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

async function analyze(
  config: Config,
  fetcher: typeof fetch,
  image: AiImage,
): Promise<Analysis> {
  if (config.ai === null) {
    throw new AiError('NOT_CONFIGURED', false);
  }

  let response: Response;
  try {
    response = await fetcher(
      `${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(45_000),
        headers: {
          Authorization: `Bearer ${config.ai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.ai.model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: RECEIPT_PROMPT },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
                  },
                },
              ],
            },
          ],
        }),
      },
    );
  } catch (error) {
    if (isTimeout(error)) {
      throw new AiError('TIMEOUT', true);
    }
    throw new AiError('UPSTREAM', true);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AiError('AUTH', false);
  }
  if (response.status === 429) {
    throw new AiError('RATE_LIMIT', true);
  }
  if (response.status >= 500) {
    throw new AiError('UPSTREAM', true);
  }
  if (!response.ok) {
    throw new AiError('UPSTREAM', false);
  }

  let upstream: unknown;
  try {
    upstream = await response.json();
  } catch {
    throw new AiError('INVALID_RESPONSE', true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contentFromResponse(upstream));
  } catch (error) {
    if (error instanceof AiError) {
      throw error;
    }
    throw new AiError('INVALID_RESPONSE', true);
  }
  return validateAnalysis(parsed);
}

export function createAnalyzer(
  config: Config,
  fetcher: typeof fetch = fetch,
): ReceiptAnalyzer {
  return {
    analyzeReceipt: (image) => analyze(config, fetcher, image),
  };
}

export function getApiStatus(config: Config): ApiStatus {
  return config.ai === null
    ? { configured: false, provider: null }
    : { configured: true, provider: 'openai-compatible' };
}
