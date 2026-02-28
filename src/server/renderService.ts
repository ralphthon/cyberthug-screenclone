import { constants as fsConstants, promises as fs } from 'node:fs';
import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';

export type RenderRequestInput = {
  html: string;
  width?: number;
  height?: number;
  waitMs?: number;
};

export type RenderResult = {
  screenshot: string;
  width: number;
  height: number;
  renderTimeMs: number;
};

type RenderErrorCode = 'INVALID_REQUEST' | 'HTML_TOO_LARGE' | 'RENDER_TIMEOUT' | 'RENDER_FAILED' | 'BROWSER_UNAVAILABLE';

export class RenderError extends Error {
  public readonly status: number;
  public readonly code: RenderErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, code: RenderErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_VIEWPORT_WIDTH = 1536;
const DEFAULT_VIEWPORT_HEIGHT = 1024;
const DEFAULT_WAIT_MS = 1000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_RENDER_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 25_000;
const CHROMIUM_CANDIDATE_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
];

let browserPromise: Promise<Browser> | null = null;
let browserInstance: Browser | null = null;

const parseOptionalInteger = (
  value: unknown,
  field: 'width' | 'height' | 'waitMs',
  defaults: number,
  min: number,
  max: number,
): number => {
  if (value === undefined || value === null || value === '') {
    return defaults;
  }

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RenderError(`${field} must be an integer between ${min} and ${max}`, 400, 'INVALID_REQUEST');
  }

  return parsed;
};

const validateInput = (input: RenderRequestInput): Required<RenderRequestInput> => {
  const html = typeof input.html === 'string' ? input.html : '';
  if (!html.trim()) {
    throw new RenderError('html is required', 400, 'INVALID_REQUEST');
  }

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > MAX_HTML_BYTES) {
    throw new RenderError('html payload exceeds 1MB', 413, 'HTML_TOO_LARGE');
  }

  return {
    html,
    width: parseOptionalInteger(input.width, 'width', DEFAULT_VIEWPORT_WIDTH, 64, 4096),
    height: parseOptionalInteger(input.height, 'height', DEFAULT_VIEWPORT_HEIGHT, 64, 4096),
    waitMs: parseOptionalInteger(input.waitMs, 'waitMs', DEFAULT_WAIT_MS, 0, MAX_WAIT_MS),
  };
};

const injectBaseTag = (html: string): string => {
  const hasBaseTag = /<base\b/i.test(html);
  if (hasBaseTag) {
    return html;
  }

  const baseTag = '<base href="about:blank/" />';

  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`;
  }

  const htmlMatch = html.match(/<html\b[^>]*>/i);
  if (htmlMatch?.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}<head>${baseTag}</head>${html.slice(insertAt)}`;
  }

  return `<head>${baseTag}</head>${html}`;
};

const isAllowedRequest = (request: HTTPRequest): boolean => {
  const url = request.url();

  if (url === 'about:blank') {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:';
  } catch {
    return false;
  }
};

const resolveExecutablePath = async (): Promise<string> => {
  const explicitPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (explicitPath) {
    try {
      await fs.access(explicitPath, fsConstants.X_OK);
      return explicitPath;
    } catch {
      throw new RenderError(
        `PUPPETEER_EXECUTABLE_PATH is not executable: ${explicitPath}`,
        503,
        'BROWSER_UNAVAILABLE',
      );
    }
  }

  for (const candidate of CHROMIUM_CANDIDATE_PATHS) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next known chromium path.
    }
  }

  throw new RenderError(
    'No Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH to a valid browser binary.',
    503,
    'BROWSER_UNAVAILABLE',
  );
};

const getBrowser = async (): Promise<Browser> => {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await resolveExecutablePath();
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        timeout: 10_000,
        // Keep web security defaults and block network at page level.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      browserInstance = browser;
      browser.on('disconnected', () => {
        browserInstance = null;
        browserPromise = null;
      });

      return browser;
    })().catch((error: unknown) => {
      browserPromise = null;
      if (error instanceof RenderError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Failed to launch Chromium browser';
      throw new RenderError(message, 503, 'BROWSER_UNAVAILABLE');
    });
  }

  return browserPromise;
};

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new RenderError('Render timed out after 30 seconds', 504, 'RENDER_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const renderOnce = async (input: Required<RenderRequestInput>): Promise<RenderResult> => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const renderStartedAt = Date.now();

  try {
    await page.setViewport({ width: input.width, height: input.height, deviceScaleFactor: 1 });
    await page.setBypassCSP(false);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (isAllowedRequest(request)) {
        void request.continue();
        return;
      }

      void request.abort('blockedbyclient');
    });

    await page.setContent(injectBaseTag(input.html), {
      waitUntil: 'domcontentloaded',
      timeout: MAX_RENDER_TIMEOUT_MS,
    });

    if (input.waitMs > 0) {
      await sleep(input.waitMs);
    }

    const screenshotBuffer = (await page.screenshot({
      type: 'png',
      fullPage: true,
      captureBeyondViewport: true,
    })) as Buffer;

    return {
      screenshot: screenshotBuffer.toString('base64'),
      width: input.width,
      height: input.height,
      renderTimeMs: Date.now() - renderStartedAt,
    };
  } catch (error) {
    if (error instanceof RenderError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Failed to render HTML';
    throw new RenderError(message, 500, 'RENDER_FAILED');
  } finally {
    try {
      await page.close();
    } catch {
      // Ignore page close races.
    }
  }
};

export const renderHtmlToScreenshot = async (input: RenderRequestInput): Promise<RenderResult> => {
  const validatedInput = validateInput(input);
  return withTimeout(renderOnce(validatedInput), MAX_RENDER_TIMEOUT_MS);
};

export const closeRenderBrowser = async (): Promise<void> => {
  const current = browserInstance;
  browserInstance = null;
  browserPromise = null;

  if (current && current.connected) {
    await current.close();
  }
};
