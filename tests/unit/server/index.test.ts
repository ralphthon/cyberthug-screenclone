import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RouteHandler = (req: any, res: any, next: (error?: unknown) => void) => unknown;

class MockAnalysisError extends Error {
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

class MockRenderError extends Error {
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

class MockCompareError extends Error {
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

class MockGitHubCommitError extends Error {
  public readonly code: 'INVALID_TOKEN' | 'INVALID_REPO' | 'API_FAILURE';
  public readonly status: number;

  constructor(message: string, code: 'INVALID_TOKEN' | 'INVALID_REPO' | 'API_FAILURE', status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class MockRalphProcessManager {
  public readonly on = vi.fn((_event: string, _handler: unknown) => this);
  public readonly start = vi.fn();
  public readonly getStatus = vi.fn();
  public readonly stop = vi.fn();
  public readonly shutdown = vi.fn().mockResolvedValue(undefined);
}

const indexMocks = vi.hoisted(() => {
  const getHandlers = new Map<string, RouteHandler>();
  const postHandlers = new Map<string, RouteHandler>();
  const headHandlers = new Map<string, RouteHandler>();

  const mockServer = {
    close: vi.fn((callback?: () => void) => {
      callback?.();
    }),
  };

  const app = {
    use: vi.fn((..._args: unknown[]) => app),
    get: vi.fn((route: string, handler: RouteHandler) => {
      getHandlers.set(route, handler);
      return app;
    }),
    post: vi.fn((route: string, handler: RouteHandler) => {
      postHandlers.set(route, handler);
      return app;
    }),
    head: vi.fn((route: string, handler: RouteHandler) => {
      headHandlers.set(route, handler);
      return app;
    }),
    listen: vi.fn((_port: number, callback?: () => void) => {
      callback?.();
      return mockServer;
    }),
  };

  const expressFactory = vi.fn(() => app);
  const expressJson = vi.fn((_options?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next());
  const corsFactory = vi.fn((_options?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next());

  class MockMulterError extends Error {
    public readonly code: string;

    constructor(code: string, message = 'multer error') {
      super(message);
      this.code = code;
    }
  }

  const multerDiskStorage = vi.fn((options: unknown) => options);
  const multerArray = vi.fn((_field: string, _maxFiles: number) => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  );
  const multerFactory = vi.fn(() => ({
    array: multerArray,
  }));

  (
    multerFactory as unknown as {
      diskStorage: typeof multerDiskStorage;
      MulterError: typeof MockMulterError;
    }
  ).diskStorage = multerDiskStorage;
  (
    multerFactory as unknown as {
      diskStorage: typeof multerDiskStorage;
      MulterError: typeof MockMulterError;
    }
  ).MulterError = MockMulterError;

  const analyzeSessionScreenshots = vi.fn();
  const renderHtmlToScreenshot = vi.fn();
  const closeRenderBrowser = vi.fn().mockResolvedValue(undefined);
  const compareScreenshots = vi.fn();

  const initializeGitHubCommitSession = vi.fn();
  const commitImprovementSnapshot = vi.fn();
  const commitFinalSnapshot = vi.fn();
  const buildSnapshotFiles = vi.fn();

  const fsAccess = vi.fn().mockResolvedValue(undefined);
  const fsReaddir = vi.fn().mockResolvedValue([]);
  const fsStat = vi.fn().mockResolvedValue({ isDirectory: () => false, mtimeMs: Date.now() });
  const fsRm = vi.fn().mockResolvedValue(undefined);
  const fsReadFile = vi.fn();
  const fsMkdir = vi.fn();

  const createConnection = vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    socket.setTimeout = vi.fn();
    socket.destroy = vi.fn();
    process.nextTick(() => {
      socket.emit('connect');
    });
    return socket;
  });

  const uuidv4 = vi.fn(() => 'test-session-id');

  class MockZip {
    public readonly folder = vi.fn(() => this);
    public readonly file = vi.fn(() => this);
    public readonly generateAsync = vi.fn().mockResolvedValue(Buffer.from('zip-data'));
  }

  return {
    getHandlers,
    postHandlers,
    headHandlers,
    expressFactory,
    expressJson,
    corsFactory,
    multerFactory,
    multerDiskStorage,
    MockMulterError,
    analyzeSessionScreenshots,
    renderHtmlToScreenshot,
    closeRenderBrowser,
    compareScreenshots,
    initializeGitHubCommitSession,
    commitImprovementSnapshot,
    commitFinalSnapshot,
    buildSnapshotFiles,
    fsAccess,
    fsReaddir,
    fsStat,
    fsRm,
    fsReadFile,
    fsMkdir,
    createConnection,
    uuidv4,
    MockZip,
  };
});

vi.mock('express', () => {
  const expressModule = indexMocks.expressFactory as unknown as {
    (): unknown;
    json: typeof indexMocks.expressJson;
  };
  expressModule.json = indexMocks.expressJson;

  return {
    default: expressModule,
  };
});

vi.mock('cors', () => ({
  default: indexMocks.corsFactory,
}));

vi.mock('multer', () => ({
  default: indexMocks.multerFactory,
}));

vi.mock('node:net', () => ({
  createConnection: indexMocks.createConnection,
}));

vi.mock('uuid', () => ({
  v4: indexMocks.uuidv4,
}));

vi.mock('jszip', () => ({
  default: indexMocks.MockZip,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: indexMocks.fsAccess,
      readdir: indexMocks.fsReaddir,
      stat: indexMocks.fsStat,
      rm: indexMocks.fsRm,
      readFile: indexMocks.fsReadFile,
      mkdir: indexMocks.fsMkdir,
    },
  };
});

vi.mock('../../../src/server/compareService.ts', () => ({
  compareScreenshots: indexMocks.compareScreenshots,
  CompareError: MockCompareError,
}));

vi.mock('../../../src/server/renderService.ts', () => ({
  renderHtmlToScreenshot: indexMocks.renderHtmlToScreenshot,
  closeRenderBrowser: indexMocks.closeRenderBrowser,
  RenderError: MockRenderError,
}));

vi.mock('../../../src/server/visionAnalyzer.ts', () => ({
  analyzeSessionScreenshots: indexMocks.analyzeSessionScreenshots,
  AnalysisError: MockAnalysisError,
}));

vi.mock('../../../src/server/ralphProcessManager.ts', () => ({
  RalphProcessManager: MockRalphProcessManager,
}));

vi.mock('../../../src/server/githubCommitService.ts', () => ({
  buildSnapshotFiles: indexMocks.buildSnapshotFiles,
  commitFinalSnapshot: indexMocks.commitFinalSnapshot,
  commitImprovementSnapshot: indexMocks.commitImprovementSnapshot,
  initializeGitHubCommitSession: indexMocks.initializeGitHubCommitSession,
  GitHubCommitError: MockGitHubCommitError,
}));

const importModule = () => import('../../../src/server/index.ts');

const getRouteHandler = (map: Map<string, RouteHandler>, route: string): RouteHandler => {
  const handler = map.get(route);
  expect(handler).toBeTypeOf('function');
  return handler as RouteHandler;
};

const createMockResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((payload: unknown) => {
      response.body = payload;
      return response;
    }),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };

  return response;
};

describe('server API routes', () => {
  beforeAll(async () => {
    await importModule();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    indexMocks.analyzeSessionScreenshots.mockResolvedValue({
      layout: { type: 'grid', direction: 'vertical', sections: ['hero'] },
      colorPalette: {
        primary: '#111111',
        secondary: '#222222',
        background: '#ffffff',
        text: '#000000',
        accent: '#ff0000',
      },
      components: [],
      textContent: [],
      fonts: [],
      responsiveHints: [],
    });
    indexMocks.renderHtmlToScreenshot.mockResolvedValue({
      screenshot: Buffer.from('image').toString('base64'),
      width: 1280,
      height: 720,
      renderTimeMs: 25,
    });
    indexMocks.compareScreenshots.mockResolvedValue({
      primaryScore: 89,
      pixel: {
        pixelScore: 89,
        diffImage: Buffer.from('diff').toString('base64'),
        mismatchedPixels: 10,
        totalPixels: 100,
      },
    });
    indexMocks.fsAccess.mockResolvedValue(undefined);
    indexMocks.fsReaddir.mockResolvedValue([]);
    indexMocks.fsStat.mockResolvedValue({ isDirectory: () => false, mtimeMs: Date.now() });
    indexMocks.fsRm.mockResolvedValue(undefined);
  });

  it('GET /api/health returns 200 status payload', () => {
    const handler = getRouteHandler(indexMocks.getHandlers, '/api/health');
    const response = createMockResponse();
    const next = vi.fn();

    handler({}, response, next);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version: '1.0.0' });
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /api/analyze with valid sessionId returns analysis payload', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/analyze');
    const response = createMockResponse();
    const next = vi.fn();

    await handler(
      {
        body: {
          sessionId: '  session-123  ',
          imageIndex: '1',
        },
      },
      response,
      next,
    );

    expect(indexMocks.analyzeSessionScreenshots).toHaveBeenCalledWith({
      sessionId: 'session-123',
      imageIndex: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      layout: { type: 'grid' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /api/analyze with missing sessionId forwards a 400 error', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/analyze');
    const response = createMockResponse();
    const next = vi.fn();

    await handler({ body: {} }, response, next);

    expect(indexMocks.analyzeSessionScreenshots).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const [error] = next.mock.calls[0] as [Record<string, unknown>];
    expect(error).toMatchObject({
      message: 'sessionId is required',
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('POST /api/render with valid html returns render result', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/render');
    const response = createMockResponse();
    const next = vi.fn();

    await handler(
      {
        body: {
          html: '<main>Hello</main>',
          width: '800',
          height: 600,
          waitMs: '10',
        },
      },
      response,
      next,
    );

    expect(indexMocks.renderHtmlToScreenshot).toHaveBeenCalledWith({
      html: '<main>Hello</main>',
      width: 800,
      height: 600,
      waitMs: 10,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ width: 1280, height: 720 });
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /api/render with missing html forwards a 400 error', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/render');
    const response = createMockResponse();
    const next = vi.fn();

    await handler({ body: { html: '   ' } }, response, next);

    expect(indexMocks.renderHtmlToScreenshot).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const [error] = next.mock.calls[0] as [Record<string, unknown>];
    expect(error).toMatchObject({
      message: 'html is required',
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('POST /api/compare with valid inputs returns comparison result', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/compare');
    const response = createMockResponse();
    const next = vi.fn();

    await handler(
      {
        body: {
          original: Buffer.from('original').toString('base64'),
          generated: Buffer.from('generated').toString('base64'),
          mode: 'both',
          sessionId: '  session-compare  ',
          iteration: '3',
        },
      },
      response,
      next,
    );

    expect(indexMocks.compareScreenshots).toHaveBeenCalledWith({
      original: Buffer.from('original').toString('base64'),
      generated: Buffer.from('generated').toString('base64'),
      mode: 'both',
      sessionId: 'session-compare',
      iteration: 3,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ primaryScore: 89 });
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /api/compare with missing inputs forwards a 400 error', async () => {
    const handler = getRouteHandler(indexMocks.postHandlers, '/api/compare');
    const response = createMockResponse();
    const next = vi.fn();
    indexMocks.compareScreenshots.mockRejectedValueOnce(
      new MockCompareError('original and generated are required', 400, 'INVALID_REQUEST'),
    );

    await handler({ body: {} }, response, next);

    expect(indexMocks.compareScreenshots).toHaveBeenCalledWith({
      original: '',
      generated: '',
      mode: undefined,
      sessionId: undefined,
      iteration: undefined,
    });
    expect(next).toHaveBeenCalledTimes(1);
    const [error] = next.mock.calls[0] as [Record<string, unknown>];
    expect(error).toMatchObject({
      message: 'original and generated are required',
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });
});
