import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchMock,
  pixelmatchMock,
  pngReadMock,
  pngWriteMock,
  sharpMetadataMock,
  sharpMock,
  sharpToBufferMock,
  MockPNG,
} = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const pixelmatchMock = vi.fn();
  const pngReadMock = vi.fn();
  const pngWriteMock = vi.fn();
  const sharpMetadataMock = vi.fn();
  const sharpToBufferMock = vi.fn();

  const sharpMock = vi.fn(() => ({
    metadata: sharpMetadataMock,
    png: () => ({ toBuffer: sharpToBufferMock }),
    resize: () => ({
      png: () => ({ toBuffer: sharpToBufferMock }),
    }),
  }));

  class MockPNG {
    public width: number;
    public height: number;
    public data: Buffer;

    constructor({ width, height }: { width: number; height: number }) {
      this.width = width;
      this.height = height;
      this.data = Buffer.alloc(width * height * 4);
    }

    public static sync = {
      read: pngReadMock,
      write: pngWriteMock,
    };
  }

  return {
    fetchMock,
    pixelmatchMock,
    pngReadMock,
    pngWriteMock,
    sharpMetadataMock,
    sharpMock,
    sharpToBufferMock,
    MockPNG,
  };
});

vi.mock('pixelmatch', () => ({
  default: pixelmatchMock,
}));

vi.mock('pngjs', () => ({
  PNG: MockPNG,
}));

vi.mock('sharp', () => ({
  default: sharpMock,
}));

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
const importModule = () => import('../../../src/server/compareService.ts');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);

  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  sharpMetadataMock.mockResolvedValue({ width: 2, height: 2 });
  sharpToBufferMock.mockResolvedValueOnce(Buffer.from('original-png')).mockResolvedValueOnce(Buffer.from('generated-png'));
  pngReadMock.mockReturnValue({ data: Buffer.alloc(16) });
  pngWriteMock.mockReturnValue(Buffer.from('diff-image'));
  pixelmatchMock.mockReturnValue(2);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compareService', () => {
  it('returns pixel comparison for pixel mode', async () => {
    const { compareScreenshots } = await importModule();
    const result = await compareScreenshots({
      original: base64('original'),
      generated: base64('generated'),
      mode: 'pixel',
    });

    expect(result.vision).toBeUndefined();
    expect(result.pixel).toMatchObject({
      pixelScore: 50,
      mismatchedPixels: 2,
      totalPixels: 4,
    });
    expect(result.primaryScore).toBe(50);
    expect(result.pixel?.diffImage).toBe(Buffer.from('diff-image').toString('base64'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns vision result when OpenAI succeeds', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"score":88,"layout_match":true,"color_match":true,"component_match":true,"text_match":true,"responsive_match":true,"differences":[],"suggestions":[],"verdict":"close","reasoning":"Looks good."}',
            },
          },
        ],
      }),
    });

    const { compareScreenshots } = await importModule();
    const result = await compareScreenshots({
      original: base64('original'),
      generated: base64('generated'),
      mode: 'vision',
      sessionId: 'session-vision-success',
      iteration: 1,
    });

    expect(result.vision?.score).toBe(88);
    expect(result.vision?.verdict).toBe('close');
    expect(result.primaryScore).toBe(88);
    expect(result.pixel).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to pixel mode when vision mode provider fails', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const { compareScreenshots } = await importModule();
    const result = await compareScreenshots({
      original: base64('original'),
      generated: base64('generated'),
      mode: 'vision',
      sessionId: 'session-vision-fallback',
      iteration: 2,
    });

    expect(result.vision).toBeUndefined();
    expect(result.pixel?.pixelScore).toBe(50);
    expect(result.primaryScore).toBe(50);
  });

  it('throws CompareError for invalid input', async () => {
    const { CompareError, compareScreenshots } = await importModule();

    await expect(
      compareScreenshots({
        original: '',
        generated: '',
      }),
    ).rejects.toBeInstanceOf(CompareError);

    await expect(
      compareScreenshots({
        original: '',
        generated: '',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('throws CompareError when pixel comparison fails in both mode', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"score":90}' } }],
      }),
    });
    pngReadMock.mockImplementation(() => {
      throw new Error('bad png');
    });

    const { CompareError, compareScreenshots } = await importModule();

    await expect(
      compareScreenshots({
        original: base64('original'),
        generated: base64('generated'),
        mode: 'both',
        sessionId: 'session-both-failure',
        iteration: 3,
      }),
    ).rejects.toBeInstanceOf(CompareError);

    await expect(
      compareScreenshots({
        original: base64('original'),
        generated: base64('generated'),
        mode: 'both',
        sessionId: 'session-both-failure-2',
        iteration: 4,
      }),
    ).rejects.toMatchObject({
      code: 'COMPARE_FAILED',
      status: 500,
    });
  });

  it('exposes CompareError fields', async () => {
    const { CompareError } = await importModule();
    const err = new CompareError('boom', 418, 'COMPARE_FAILED', { retryable: true });

    expect(err.message).toBe('boom');
    expect(err.status).toBe(418);
    expect(err.code).toBe('COMPARE_FAILED');
    expect(err.details).toEqual({ retryable: true });
  });
});
