import { promises as fs } from 'node:fs';
import path from 'node:path';

type LayoutSummary = {
  type: string;
  direction: string;
  sections: string[];
};

type ColorPalette = {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  accent: string;
};

type ComponentSummary = {
  type: string;
  position: string;
  props: string[];
};

export type AnalysisResult = {
  layout: LayoutSummary;
  colorPalette: ColorPalette;
  components: ComponentSummary[];
  textContent: string[];
  fonts: string[];
  responsiveHints: string[];
};

export class AnalysisError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(message: string, status: number, code: string, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

type AnalyzeRequestInput = {
  sessionId: string;
  imageIndex?: number;
};

type AnalyzeFile = {
  name: string;
  path: string;
  mimeType: string;
};

type VisionPayload = {
  model: string;
  messages: Array<{
    role: 'user' | 'system';
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
      | {
          type: 'text';
          text: string;
        }
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

type Provider = 'openai' | 'anthropic';

type CacheEntry = {
  expiresAt: number;
  value: AnalysisResult;
};

const SESSION_DIR_PREFIX = 'ralphton-';
const TMP_ROOT = '/tmp';
const MAX_IMAGES = 5;
const ANALYZE_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const OPENAI_URL = process.env.OPENAI_BASE_URL
  ? `${process.env.OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`
  : 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')}/v1/messages`
  : 'https://api.anthropic.com/v1/messages';
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL ?? 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VISION_MODEL ?? 'claude-3-5-sonnet-latest';

const analysisCache = new Map<string, CacheEntry>();

const ANALYSIS_PROMPT = `You are a senior frontend engineer analyzing website screenshots.
Return strict JSON only with this exact shape:
{
  "layout": { "type": string, "direction": string, "sections": string[] },
  "colorPalette": {
    "primary": string,
    "secondary": string,
    "background": string,
    "text": string,
    "accent": string
  },
  "components": [
    { "type": string, "position": string, "props": string[] }
  ],
  "textContent": string[],
  "fonts": string[],
  "responsiveHints": string[]
}

Rules:
- Infer likely DOM structure and key sections.
- Color values should be hex where possible.
- components should include major UI primitives (nav, hero, card, footer, sidebar, form, button, etc).
- Keep outputs concise and deterministic.`;

const normalizeTextList = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : fallback;
};

const normalizeComponents = (value: unknown): ComponentSummary[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const record = item as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type.trim() : '';
      const position = typeof record.position === 'string' ? record.position.trim() : '';
      const props = normalizeTextList(record.props, []);

      if (!type) {
        return null;
      }

      return {
        type,
        position: position || 'unspecified',
        props,
      } satisfies ComponentSummary;
    })
    .filter((item): item is ComponentSummary => item !== null);
};

const fallbackResult = (): AnalysisResult => ({
  layout: {
    type: 'unknown',
    direction: 'unknown',
    sections: ['main'],
  },
  colorPalette: {
    primary: '#6366f1',
    secondary: '#8b5cf6',
    background: '#1e1b2e',
    text: '#f3f4f6',
    accent: '#22d3ee',
  },
  components: [],
  textContent: [],
  fonts: [],
  responsiveHints: [],
});

const coerceAnalysisResult = (value: unknown): AnalysisResult => {
  if (!value || typeof value !== 'object') {
    return fallbackResult();
  }

  const record = value as Record<string, unknown>;
  const result = fallbackResult();

  if (record.layout && typeof record.layout === 'object') {
    const layout = record.layout as Record<string, unknown>;
    if (typeof layout.type === 'string' && layout.type.trim()) {
      result.layout.type = layout.type.trim();
    }
    if (typeof layout.direction === 'string' && layout.direction.trim()) {
      result.layout.direction = layout.direction.trim();
    }
    result.layout.sections = normalizeTextList(layout.sections, result.layout.sections);
  }

  if (record.colorPalette && typeof record.colorPalette === 'object') {
    const palette = record.colorPalette as Record<string, unknown>;
    for (const key of Object.keys(result.colorPalette) as Array<keyof ColorPalette>) {
      const valueForKey = palette[key];
      if (typeof valueForKey === 'string' && valueForKey.trim()) {
        result.colorPalette[key] = valueForKey.trim();
      }
    }
  }

  result.components = normalizeComponents(record.components);
  result.textContent = normalizeTextList(record.textContent, []);
  result.fonts = normalizeTextList(record.fonts, []);
  result.responsiveHints = normalizeTextList(record.responsiveHints, []);

  return result;
};

const detectMimeTypeFromPath = (filePath: string): string | null => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.bmp') {
    return 'image/bmp';
  }

  return null;
};

const sessionDirFor = (sessionId: string): string => path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`);

const validateInput = (input: AnalyzeRequestInput): { sessionId: string; imageIndex?: number } => {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) {
    throw new AnalysisError('sessionId is required', 400, 'INVALID_REQUEST');
  }

  let imageIndex: number | undefined;
  if (input.imageIndex !== undefined) {
    if (!Number.isInteger(input.imageIndex) || input.imageIndex < 0) {
      throw new AnalysisError('imageIndex must be a non-negative integer', 400, 'INVALID_REQUEST');
    }

    imageIndex = input.imageIndex;
  }

  return { sessionId, imageIndex };
};

const readSessionImages = async (sessionId: string): Promise<AnalyzeFile[]> => {
  const directory = sessionDirFor(sessionId);

  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    throw new AnalysisError(`Session '${sessionId}' not found`, 404, 'SESSION_NOT_FOUND');
  }

  const sorted = entries
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  if (sorted.length === 0) {
    throw new AnalysisError(`No screenshots found for session '${sessionId}'`, 404, 'SESSION_NOT_FOUND');
  }

  const files = sorted.slice(0, MAX_IMAGES).map((entry) => {
    const imagePath = path.join(directory, entry);
    const mimeType = detectMimeTypeFromPath(imagePath);
    if (!mimeType) {
      return null;
    }

    return {
      name: entry,
      path: imagePath,
      mimeType,
    } satisfies AnalyzeFile;
  });

  const valid = files.filter((file): file is AnalyzeFile => file !== null);
  if (valid.length === 0) {
    throw new AnalysisError(`No supported screenshots found for session '${sessionId}'`, 404, 'SESSION_NOT_FOUND');
  }

  return valid;
};

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new AnalysisError('Vision analysis timed out after 60 seconds', 504, 'ANALYSIS_TIMEOUT', true));
        });
      }),
    ]);

    return result;
  } finally {
    clearTimeout(timeout);
  }
};

const parseJsonFromModelText = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Empty model response');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error('Model response did not contain valid JSON');
  }
};

const callOpenAi = async (images: AnalyzeFile[]): Promise<AnalysisResult> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AnalysisError('OPENAI_API_KEY is not configured', 500, 'PROVIDER_UNAVAILABLE');
  }

  const imageContents = await Promise.all(
    images.map(async (image) => {
      const fileBuffer = await fs.readFile(image.path);
      return {
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${fileBuffer.toString('base64')}`,
        },
      };
    }),
  );

  const payload: VisionPayload = {
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: ANALYSIS_PROMPT,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze the screenshot set and return the required JSON schema.' },
          ...imageContents,
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
    throw new AnalysisError(`OpenAI vision request failed with status ${response.status}`, 500, 'PROVIDER_FAILURE', true);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const rawContent = data.choices?.[0]?.message?.content;
  const contentText = Array.isArray(rawContent)
    ? rawContent
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim()
    : typeof rawContent === 'string'
      ? rawContent
      : '';

  const parsed = parseJsonFromModelText(contentText);
  return coerceAnalysisResult(parsed);
};

const callAnthropic = async (images: AnalyzeFile[]): Promise<AnalysisResult> => {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new AnalysisError('ANTHROPIC_API_KEY is not configured', 500, 'PROVIDER_UNAVAILABLE');
  }

  const imageContents = await Promise.all(
    images.map(async (image) => {
      const fileBuffer = await fs.readFile(image.path);
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mimeType,
          data: fileBuffer.toString('base64'),
        },
      };
    }),
  );

  const payload: AnthropicPayload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1800,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${ANALYSIS_PROMPT}\n\nAnalyze the screenshot set and return JSON only.` },
          ...imageContents,
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
    throw new AnalysisError(
      `Anthropic vision request failed with status ${response.status}`,
      500,
      'PROVIDER_FAILURE',
      true,
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

  const parsed = parseJsonFromModelText(contentText ?? '');
  return coerceAnalysisResult(parsed);
};

const cacheKeyFor = (sessionId: string, imageIndex: number | undefined): string =>
  imageIndex === undefined ? `${sessionId}:all` : `${sessionId}:${imageIndex}`;

const cleanupCache = (): void => {
  const now = Date.now();
  for (const [key, entry] of analysisCache.entries()) {
    if (entry.expiresAt <= now) {
      analysisCache.delete(key);
    }
  }
};

const resolveProviderOrder = (): Provider[] => {
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);

  if (hasOpenAi && hasAnthropic) {
    return ['openai', 'anthropic'];
  }

  if (hasOpenAi) {
    return ['openai'];
  }

  if (hasAnthropic) {
    return ['anthropic'];
  }

  throw new AnalysisError(
    'No vision provider API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
    500,
    'PROVIDER_UNAVAILABLE',
  );
};

const analyzeViaProviders = async (images: AnalyzeFile[]): Promise<AnalysisResult> => {
  const providers = resolveProviderOrder();
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      if (provider === 'openai') {
        return await callOpenAi(images);
      }

      return await callAnthropic(images);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown provider failure';
      failures.push(`${provider}: ${message}`);
    }
  }

  throw new AnalysisError(
    `Vision analysis failed after provider fallback. Retry with a valid provider key. Details: ${failures.join(' | ')}`,
    500,
    'ANALYSIS_FAILED',
    true,
  );
};

export const analyzeSessionScreenshots = async (input: AnalyzeRequestInput): Promise<AnalysisResult> => {
  cleanupCache();

  const { sessionId, imageIndex } = validateInput(input);
  const cacheKey = cacheKeyFor(sessionId, imageIndex);
  const existing = analysisCache.get(cacheKey);

  if (existing && existing.expiresAt > Date.now()) {
    return existing.value;
  }

  const images = await readSessionImages(sessionId);
  const selectedImages =
    imageIndex === undefined
      ? images
      : imageIndex < images.length
        ? [images[imageIndex]]
        : (() => {
            throw new AnalysisError(
              `imageIndex ${imageIndex} is out of range for session '${sessionId}'`,
              400,
              'INVALID_REQUEST',
            );
          })();

  const result = await withTimeout(analyzeViaProviders(selectedImages), ANALYZE_TIMEOUT_MS);

  analysisCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return result;
};
