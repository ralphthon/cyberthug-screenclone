import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const visionMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: visionMocks.readdir,
      readFile: visionMocks.readFile,
    },
  };
});

const importVisionAnalyzer = async () => import('../../../src/server/visionAnalyzer.ts');

describe('visionAnalyzer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    visionMocks.readdir.mockResolvedValue(['screen-02.png', 'notes.txt', 'screen-01.jpg']);
    visionMocks.readFile.mockResolvedValue(Buffer.from('image-bytes'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs AnalysisError with metadata', async () => {
    const { AnalysisError } = await importVisionAnalyzer();

    const error = new AnalysisError('boom', 503, 'E_TEST', true);

    expect(error.message).toBe('boom');
    expect(error.status).toBe(503);
    expect(error.code).toBe('E_TEST');
    expect(error.retryable).toBe(true);
  });

  it('analyzes screenshots via OpenAI and normalizes the model payload', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                layout: { type: 'hero', direction: 'column', sections: ['header', 'main'] },
                colorPalette: {
                  primary: '#111111',
                  secondary: '#222222',
                  background: '#333333',
                  text: '#444444',
                  accent: '#555555',
                },
                components: [{ type: 'nav', position: 'top', props: ['sticky'] }],
                textContent: ['Welcome'],
                fonts: ['Space Grotesk'],
                responsiveHints: ['stack on mobile'],
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { analyzeSessionScreenshots } = await importVisionAnalyzer();
    const result = await analyzeSessionScreenshots({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(visionMocks.readdir).toHaveBeenCalledWith('/tmp/ralphton-a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(visionMocks.readFile).toHaveBeenCalledTimes(2);
    expect(result.layout.type).toBe('hero');
    expect(result.colorPalette.primary).toBe('#111111');
    expect(result.components).toEqual([{ type: 'nav', position: 'top', props: ['sticky'] }]);
    expect(result.textContent).toEqual(['Welcome']);
  });

  it('uses cached analysis for repeated request inputs', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"layout":{"type":"grid","direction":"row","sections":["main"]}}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { analyzeSessionScreenshots } = await importVisionAnalyzer();

    const first = await analyzeSessionScreenshots({ sessionId: 'b1ffcd00-ad1c-4ef9-bc7e-7cc0ce491b22' });
    const second = await analyzeSessionScreenshots({ sessionId: 'b1ffcd00-ad1c-4ef9-bc7e-7cc0ce491b22' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('falls back to Anthropic when OpenAI fails and both keys are configured', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: '{"layout":{"type":"single","direction":"column","sections":["main"]}}',
            },
          ],
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const { analyzeSessionScreenshots } = await importVisionAnalyzer();
    const result = await analyzeSessionScreenshots({ sessionId: 'c2aabb11-be2d-4ef0-ad8f-8dd1df592c33' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.layout.type).toBe('single');
  });

  it('throws AnalysisError for invalid input and unavailable providers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { AnalysisError, analyzeSessionScreenshots } = await importVisionAnalyzer();

    await expect(analyzeSessionScreenshots({ sessionId: '' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });

    await expect(analyzeSessionScreenshots({ sessionId: 'd3bbcc22-cf3e-4fa1-be90-9ee2ef6a3d44', imageIndex: -1 })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });

    await expect(analyzeSessionScreenshots({ sessionId: 'd3bbcc22-cf3e-4fa1-be90-9ee2ef6a3d44', imageIndex: 100 })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });

    await expect(analyzeSessionScreenshots({ sessionId: 'd3bbcc22-cf3e-4fa1-be90-9ee2ef6a3d44' })).rejects.toBeInstanceOf(AnalysisError);
    await expect(analyzeSessionScreenshots({ sessionId: 'd3bbcc22-cf3e-4fa1-be90-9ee2ef6a3d44' })).rejects.toMatchObject({
      status: 500,
      code: 'PROVIDER_UNAVAILABLE',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when session directory is missing', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    visionMocks.readdir.mockRejectedValue(new Error('missing'));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { analyzeSessionScreenshots } = await importVisionAnalyzer();

    await expect(analyzeSessionScreenshots({ sessionId: 'e4ccdd33-d04f-4fb2-af01-aff3f07b4e55' })).rejects.toMatchObject({
      status: 404,
      code: 'SESSION_NOT_FOUND',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
