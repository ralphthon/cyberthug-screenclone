import { promises as fs } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';

type CompareMode = 'vision' | 'pixel' | 'both';
type Provider = 'openai' | 'anthropic';

export type VisionVerdict = {
  score: number;
  layout_match: boolean;
  color_match: boolean;
  component_match: boolean;
  text_match: boolean;
  responsive_match: boolean;
  differences: string[];
  suggestions: string[];
  verdict: 'pass' | 'close' | 'fail';
  reasoning: string;
};

export type PixelComparison = {
  pixelScore: number;
  diffImage: string;
  mismatchedPixels: number;
  totalPixels: number;
};

export type CompareRequestInput = {
  original: string;
  generated: string;
  mode?: CompareMode;
  sessionId?: string;
  iteration?: number;
};

export type CompareResult = {
  vision?: VisionVerdict;
  pixel?: PixelComparison;
  primaryScore: number;
};

type CacheEntry = {
  verdict: VisionVerdict;
  expiresAt: number;
};

type CompareParsedInput = {
  original: string;
  generated: string;
  mode: CompareMode;
  sessionId?: string;
  iteration?: number;
};

type NormalizedImages = {
  originalPng: Buffer;
  generatedPng: Buffer;
  width: number;
  height: number;
};

type OpenAiPayload = {
  model: string;
  messages: Array<{
    role: 'system' | 'user';
    content: unknown;
  }>;
  response_format?: { type: 'json_object' };
  max_tokens?: number;
};

type AnthropicPayload = {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: string;
            data: string;
          };
        }
    >;
  }>;
};

export class CompareError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, code: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const validateOpenAiBaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      console.warn(`OPENAI_BASE_URL uses non-HTTPS protocol: ${parsed.protocol}`);
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid OPENAI_BASE_URL: ${url}`);
  }
};
const OPENAI_URL = `${validateOpenAiBaseUrl(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')}/chat/completions`;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_MODEL = process.env.VISION_COMPARE_MODEL ?? process.env.OPENAI_VISION_MODEL ?? 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VISION_MODEL ?? 'claude-3-5-sonnet-latest';
const VISION_TIMEOUT_MS = 60_000;
const VISION_RATE_LIMIT_MS = 5_000;
const VISION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_DIFF_ITEMS = 10;
const MAX_SUGGESTION_ITEMS = 5;
const SESSION_DIR_PREFIX = 'ralphton-';
const TMP_ROOT = '/tmp';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE_SIZE = 500;

const isValidSessionId = (value: string): boolean => UUID_RE.test(value);

const visionCache = new Map<string, CacheEntry>();
const visionLastCallBySession = new Map<string, number>();

const VISION_PROMPT = `You are a senior frontend developer reviewing a website clone attempt.
Image 1 is the ORIGINAL screenshot.
Image 2 is the CLONE screenshot.

Evaluate whether these represent the same web service/product, not pixel-identical output.
Focus on layout structure, visual hierarchy, color palette coherence, component inventory completeness,
text content accuracy, responsive intent, and overall brand feel.

Return strict JSON only with this exact schema:
{
  "score": number,
  "layout_match": boolean,
  "color_match": boolean,
  "component_match": boolean,
  "text_match": boolean,
  "responsive_match": boolean,
  "differences": string[],
  "suggestions": string[],
  "verdict": "pass" | "close" | "fail",
  "reasoning": string
}

Rules:
- score 0-100
- differences max 10 specific issues
- suggestions max 5 actionable code fixes
- reasoning should be 1-2 concise sentences`;

const clampScore = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 100) {
    return 100;
  }

  return Number(value.toFixed(2));
};

const normalizeStringList = (value: unknown, maxLength: number): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, maxLength);
};

const fallbackVerdictFromScore = (score: number): VisionVerdict['verdict'] => {
  if (score >= 90) {
    return 'pass';
  }

  if (score >= 60) {
    return 'close';
  }

  return 'fail';
};

const coerceVisionVerdict = (value: unknown): VisionVerdict => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const scoreRaw = typeof record.score === 'number' ? record.score : Number(record.score ?? 0);
  const score = clampScore(scoreRaw);

  const verdictRaw = typeof record.verdict === 'string' ? record.verdict.trim().toLowerCase() : '';
  const verdict: VisionVerdict['verdict'] =
    verdictRaw === 'pass' || verdictRaw === 'close' || verdictRaw === 'fail'
      ? verdictRaw
      : fallbackVerdictFromScore(score);

  const reasoning =
    typeof record.reasoning === 'string' && record.reasoning.trim().length > 0
      ? record.reasoning.trim()
      : 'Visual comparison completed.';

  return {
    score,
    layout_match: Boolean(record.layout_match),
    color_match: Boolean(record.color_match),
    component_match: Boolean(record.component_match),
    text_match: Boolean(record.text_match),
    responsive_match: Boolean(record.responsive_match),
    differences: normalizeStringList(record.differences, MAX_DIFF_ITEMS),
    suggestions: normalizeStringList(record.suggestions, MAX_SUGGESTION_ITEMS),
    verdict,
    reasoning,
  };
};

const parseJsonFromModelText = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CompareError('Vision provider returned an empty response', 500, 'PROVIDER_FAILURE');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new CompareError('Vision provider response did not contain valid JSON', 500, 'PROVIDER_FAILURE');
  }
};

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  return await Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new CompareError('Vision comparison timed out after 60 seconds', 504, 'COMPARE_TIMEOUT'));
      }, timeoutMs);
      timeout.unref();
    }),
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
};

const parseCompareMode = (value: unknown): CompareMode => {
  if (value === undefined || value === null || value === '') {
    return 'both';
  }

  if (value === 'vision' || value === 'pixel' || value === 'both') {
    return value;
  }

  throw new CompareError("mode must be 'vision', 'pixel', or 'both'", 400, 'INVALID_REQUEST');
};

const parseIteration = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CompareError('iteration must be a non-negative integer', 400, 'INVALID_REQUEST');
  }

  return parsed;
};

const parseInput = (input: CompareRequestInput): CompareParsedInput => {
  const original = typeof input.original === 'string' ? input.original.trim() : '';
  const generated = typeof input.generated === 'string' ? input.generated.trim() : '';

  if (!original || !generated) {
    throw new CompareError('original and generated base64 images are required', 400, 'INVALID_REQUEST');
  }

  const sessionIdRaw = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const sessionId = sessionIdRaw.length > 0 ? sessionIdRaw : undefined;

  return {
    original,
    generated,
    mode: parseCompareMode(input.mode),
    sessionId,
    iteration: parseIteration(input.iteration),
  };
};

const stripDataUrlPrefix = (value: string): { mimeType: string | null; base64: string } => {
  const dataUrlMatch = value.match(/^data:([^;]+);base64,(.+)$/s);
  if (!dataUrlMatch) {
    return { mimeType: null, base64: value };
  }

  return {
    mimeType: dataUrlMatch[1]?.trim() ?? null,
    base64: dataUrlMatch[2] ?? '',
  };
};

const decodeBase64Image = async (raw: string): Promise<Buffer> => {
  const { base64 } = stripDataUrlPrefix(raw);
  const sanitized = base64.replace(/\s/g, '');

  if (!sanitized || !/^[A-Za-z0-9+/=]+$/.test(sanitized)) {
    throw new CompareError('Invalid base64 image payload', 400, 'INVALID_IMAGE_BASE64');
  }

  const decoded = Buffer.from(sanitized, 'base64');
  if (decoded.length === 0) {
    throw new CompareError('Invalid base64 image payload', 400, 'INVALID_IMAGE_BASE64');
  }

  try {
    await sharp(decoded).metadata();
  } catch {
    throw new CompareError('Invalid or corrupt image payload', 400, 'INVALID_IMAGE_BASE64');
  }

  return decoded;
};

const normalizeImages = async (originalRaw: string, generatedRaw: string): Promise<NormalizedImages> => {
  const originalBuffer = await decodeBase64Image(originalRaw);
  const generatedBuffer = await decodeBase64Image(generatedRaw);

  const originalMetadata = await sharp(originalBuffer).metadata();
  if (!originalMetadata.width || !originalMetadata.height) {
    throw new CompareError('Unable to determine dimensions for original image', 400, 'INVALID_IMAGE_BASE64');
  }

  const width = originalMetadata.width;
  const height = originalMetadata.height;

  const [originalPng, generatedPng] = await Promise.all([
    sharp(originalBuffer).png().toBuffer(),
    sharp(generatedBuffer)
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer(),
  ]);

  return {
    originalPng,
    generatedPng,
    width,
    height,
  };
};

const comparePixels = (images: NormalizedImages): PixelComparison => {
  const originalPng = PNG.sync.read(images.originalPng);
  const generatedPng = PNG.sync.read(images.generatedPng);
  const diffImage = new PNG({ width: images.width, height: images.height });

  const mismatchedPixels = pixelmatch(
    originalPng.data,
    generatedPng.data,
    diffImage.data,
    images.width,
    images.height,
    {
      threshold: 0.1,
    },
  );

  const totalPixels = images.width * images.height;
  const pixelScore = clampScore(((totalPixels - mismatchedPixels) / totalPixels) * 100);

  return {
    pixelScore,
    diffImage: PNG.sync.write(diffImage).toString('base64'),
    mismatchedPixels,
    totalPixels,
  };
};

const resolveProviderOrder = (): Provider[] => {
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);

  if (hasOpenAi && hasAnthropic) {
    return ['openai', 'anthropic'];
  }

  if (hasOpenAi) {
    return ['openai'];
  }

  if (hasAnthropic) {
    return ['anthropic'];
  }

  throw new CompareError(
    'No vision provider API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
    500,
    'PROVIDER_UNAVAILABLE',
  );
};

const callOpenAiVision = async (originalPng: Buffer, generatedPng: Buffer): Promise<VisionVerdict> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new CompareError('OPENAI_API_KEY is not configured', 500, 'PROVIDER_UNAVAILABLE');
  }

  const payload: OpenAiPayload = {
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: VISION_PROMPT,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Evaluate clone similarity and return the required JSON.' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${originalPng.toString('base64')}` },
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${generatedPng.toString('base64')}` },
          },
        ],
      },
    ],
  };

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await response.text().catch(() => {});
    throw new CompareError(`OpenAI vision request failed with status ${response.status}`, 500, 'PROVIDER_FAILURE', {
      provider: 'openai',
      retryable: true,
    });
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const rawContent = data.choices?.[0]?.message?.content;
  const contentText = Array.isArray(rawContent)
    ? rawContent
        .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
        .join('\n')
        .trim()
    : typeof rawContent === 'string'
      ? rawContent
      : '';

  return coerceVisionVerdict(parseJsonFromModelText(contentText));
};

const callAnthropicVision = async (originalPng: Buffer, generatedPng: Buffer): Promise<VisionVerdict> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new CompareError('ANTHROPIC_API_KEY is not configured', 500, 'PROVIDER_UNAVAILABLE');
  }

  const payload: AnthropicPayload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1800,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${VISION_PROMPT}\n\nEvaluate clone similarity and return JSON only.` },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: originalPng.toString('base64'),
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: generatedPng.toString('base64'),
            },
          },
        ],
      },
    ],
  };

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await response.text().catch(() => {});
    throw new CompareError(
      `Anthropic vision request failed with status ${response.status}`,
      500,
      'PROVIDER_FAILURE',
      { provider: 'anthropic', retryable: true },
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const contentText = data.content
    ?.filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string)
    .join('\n')
    .trim();

  return coerceVisionVerdict(parseJsonFromModelText(contentText ?? ''));
};

const cleanupVisionCache = (): void => {
  const now = Date.now();
  for (const [key, entry] of visionCache.entries()) {
    if (entry.expiresAt <= now) {
      visionCache.delete(key);
    }
  }
  for (const [sessionId, timestamp] of visionLastCallBySession.entries()) {
    if (now - timestamp > VISION_CACHE_TTL_MS) {
      visionLastCallBySession.delete(sessionId);
    }
  }
};

const buildCacheKey = (sessionId: string | undefined, iteration: number | undefined): string | null => {
  if (!sessionId || iteration === undefined) {
    return null;
  }

  return `${sessionId}:${iteration}`;
};

const enforceVisionRateLimit = (sessionId: string | undefined): void => {
  if (!sessionId) {
    return;
  }

  const now = Date.now();
  const previous = visionLastCallBySession.get(sessionId);
  if (previous && now - previous < VISION_RATE_LIMIT_MS) {
    const retryAfterMs = VISION_RATE_LIMIT_MS - (now - previous);
    throw new CompareError('Vision API rate limited for this session', 429, 'VISION_RATE_LIMITED', {
      retryAfterMs,
    });
  }

  visionLastCallBySession.set(sessionId, now);
};

const appendVisualVerdict = async (
  sessionId: string | undefined,
  iteration: number | undefined,
  verdict: VisionVerdict,
): Promise<void> => {
  if (!sessionId || iteration === undefined) {
    return;
  }

  if (!isValidSessionId(sessionId)) {
    return;
  }

  const progressPath = path.join(
    TMP_ROOT,
    `${SESSION_DIR_PREFIX}${sessionId}`,
    'workspace',
    'ralph-runtime',
    'progress.txt',
  );

  const differences =
    verdict.differences.length > 0 ? verdict.differences.map((item) => `- ${item}`).join('\n') : '- None reported';
  const suggestions =
    verdict.suggestions.length > 0 ? verdict.suggestions.map((item) => `- ${item}`).join('\n') : '- None reported';

  const entry = [
    '',
    `## Visual Verdict — Iteration ${iteration}`,
    `Score: ${verdict.score}/100 (${verdict.verdict})`,
    '### Differences',
    differences,
    '### Suggestions',
    suggestions,
    '---',
    '',
  ].join('\n');

  try {
    await fs.appendFile(progressPath, entry, 'utf-8');
  } catch {
    // Progress injection should not fail the compare request.
  }
};

const compareVision = async (
  images: NormalizedImages,
  sessionId: string | undefined,
  iteration: number | undefined,
): Promise<VisionVerdict> => {
  cleanupVisionCache();

  const cacheKey = buildCacheKey(sessionId, iteration);
  if (cacheKey) {
    const cached = visionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.verdict;
    }
  }

  enforceVisionRateLimit(sessionId);
  const providers = resolveProviderOrder();
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      const verdict = await withTimeout(
        provider === 'openai'
          ? callOpenAiVision(images.originalPng, images.generatedPng)
          : callAnthropicVision(images.originalPng, images.generatedPng),
        VISION_TIMEOUT_MS,
      );

      if (cacheKey) {
        if (visionCache.size >= MAX_CACHE_SIZE) {
          const oldestKey = visionCache.keys().next().value;
          if (oldestKey !== undefined) {
            visionCache.delete(oldestKey);
          }
        }
        visionCache.set(cacheKey, {
          verdict,
          expiresAt: Date.now() + VISION_CACHE_TTL_MS,
        });
      }

      await appendVisualVerdict(sessionId, iteration, verdict);
      return verdict;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown provider error';
      failures.push(`${provider}: ${message}`);
    }
  }

  throw new CompareError(
    `Vision comparison failed after provider fallback. Details: ${failures.join(' | ')}`,
    500,
    'COMPARE_FAILED',
    { retryable: true },
  );
};

export const compareScreenshots = async (input: CompareRequestInput): Promise<CompareResult> => {
  const parsed = parseInput(input);
  const normalized = await normalizeImages(parsed.original, parsed.generated);
  const pixelPromise = Promise.resolve().then(() => comparePixels(normalized));

  if (parsed.mode === 'pixel') {
    const pixelResult = await pixelPromise;
    return {
      pixel: pixelResult,
      primaryScore: pixelResult.pixelScore,
    };
  }

  if (parsed.mode === 'vision') {
    try {
      const visionResult = await compareVision(normalized, parsed.sessionId, parsed.iteration);
      return {
        vision: visionResult,
        primaryScore: visionResult.score,
      };
    } catch {
      const pixelResult = await pixelPromise;
      return {
        pixel: pixelResult,
        primaryScore: pixelResult.pixelScore,
      };
    }
  }

  const [visionOutcome, pixelOutcome] = await Promise.allSettled([
    compareVision(normalized, parsed.sessionId, parsed.iteration),
    pixelPromise,
  ]);

  if (pixelOutcome.status !== 'fulfilled') {
    throw new CompareError('Pixel comparison failed', 500, 'COMPARE_FAILED');
  }

  const pixelResult = pixelOutcome.value;
  if (visionOutcome.status === 'fulfilled') {
    return {
      vision: visionOutcome.value,
      pixel: pixelResult,
      primaryScore: visionOutcome.value.score,
    };
  }

  // Vision provider unavailable or errored; degrade gracefully to pixel-only comparison.
  return {
    pixel: pixelResult,
    primaryScore: pixelResult.pixelScore,
  };
};
