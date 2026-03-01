import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accessMock, launchMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  launchMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  promises: { access: accessMock },
}));

vi.mock('puppeteer-core', () => ({
  default: { launch: launchMock },
}));

const importModule = () => import('../../../src/server/renderService.ts');

type RequestHandler = (request: {
  url: () => string;
  continue: () => void;
  abort: (reason: string) => void;
}) => void;

const createBrowserHarness = (connected = true) => {
  let requestHandler: RequestHandler | undefined;

  const page = {
    setViewport: vi.fn().mockResolvedValue(undefined),
    setBypassCSP: vi.fn().mockResolvedValue(undefined),
    setCacheEnabled: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: RequestHandler) => {
      if (event === 'request') {
        requestHandler = handler;
      }
    }),
    setContent: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png-buffer')),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const browser = {
    connected,
    on: vi.fn(),
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    browser,
    page,
    getRequestHandler: () => requestHandler,
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  accessMock.mockResolvedValue(undefined);
});

describe('renderService', () => {
  it('renders screenshot successfully', async () => {
    const harness = createBrowserHarness(true);
    launchMock.mockResolvedValue(harness.browser);

    const { renderHtmlToScreenshot } = await importModule();
    const result = await renderHtmlToScreenshot({
      html: '<html><head></head><body>Hello</body></html>',
      width: 800,
      height: 600,
      waitMs: 0,
    });

    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.screenshot).toBe(Buffer.from('png-buffer').toString('base64'));
    expect(result.renderTimeMs).toBeGreaterThanOrEqual(0);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(harness.page.setContent).toHaveBeenCalledTimes(1);

    const renderedHtml = harness.page.setContent.mock.calls[0]?.[0] as string;
    expect(renderedHtml).toContain('<base href="about:blank/" />');

    const handler = harness.getRequestHandler();
    expect(handler).toBeTypeOf('function');

    const allowed = {
      url: () => 'about:blank',
      continue: vi.fn(),
      abort: vi.fn(),
    };
    handler?.(allowed);
    expect(allowed.continue).toHaveBeenCalledTimes(1);
    expect(allowed.abort).not.toHaveBeenCalled();

    const blocked = {
      url: () => 'https://example.com',
      continue: vi.fn(),
      abort: vi.fn(),
    };
    handler?.(blocked);
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();
  });

  it('throws RenderError for invalid html', async () => {
    const { RenderError, renderHtmlToScreenshot } = await importModule();

    await expect(
      renderHtmlToScreenshot({
        html: '   ',
      }),
    ).rejects.toBeInstanceOf(RenderError);

    await expect(
      renderHtmlToScreenshot({
        html: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('throws RenderError for out-of-range width', async () => {
    const { renderHtmlToScreenshot } = await importModule();

    await expect(
      renderHtmlToScreenshot({
        html: '<html></html>',
        width: 63,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('throws RenderError for html larger than 1MB', async () => {
    const { renderHtmlToScreenshot } = await importModule();
    const hugeHtml = 'a'.repeat(1024 * 1024 + 1);

    await expect(
      renderHtmlToScreenshot({
        html: hugeHtml,
      }),
    ).rejects.toMatchObject({
      code: 'HTML_TOO_LARGE',
      status: 413,
    });
  });

  it('throws RenderError when browser executable is unavailable', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/tmp/missing-browser';
    accessMock.mockRejectedValue(new Error('not executable'));

    const { renderHtmlToScreenshot } = await importModule();

    await expect(
      renderHtmlToScreenshot({
        html: '<html></html>',
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
      status: 503,
    });
  });

  it('wraps unknown render errors as RENDER_FAILED', async () => {
    const harness = createBrowserHarness(true);
    harness.page.setContent.mockRejectedValueOnce(new Error('boom'));
    launchMock.mockResolvedValue(harness.browser);

    const { renderHtmlToScreenshot } = await importModule();

    await expect(
      renderHtmlToScreenshot({
        html: '<html></html>',
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      status: 500,
    });
  });

  it('closeRenderBrowser closes connected browser', async () => {
    const harness = createBrowserHarness(true);
    launchMock.mockResolvedValue(harness.browser);

    const { closeRenderBrowser, renderHtmlToScreenshot } = await importModule();
    await renderHtmlToScreenshot({
      html: '<html></html>',
      waitMs: 0,
    });

    await closeRenderBrowser();
    expect(harness.browser.close).toHaveBeenCalledTimes(1);
  });

  it('closeRenderBrowser is a no-op when no browser was created', async () => {
    const { closeRenderBrowser } = await importModule();
    await expect(closeRenderBrowser()).resolves.toBeUndefined();
  });

  it('exposes RenderError fields', async () => {
    const { RenderError } = await importModule();
    const error = new RenderError('bad', 400, 'INVALID_REQUEST', { field: 'html' });

    expect(error.message).toBe('bad');
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details).toEqual({ field: 'html' });
  });
});
