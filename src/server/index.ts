import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import JSZip from 'jszip';
import multer, { type FileFilterCallback } from 'multer';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { CompareError, compareScreenshots } from './compareService.js';
import {
  buildSnapshotFiles,
  commitFinalSnapshot,
  commitImprovementSnapshot,
  initializeGitHubCommitSession,
  type GitHubCommitSession,
  GitHubCommitError,
  type ScoreHistoryEntry,
} from './githubCommitService.js';
import {
  RalphProcessManager,
  type RalphSessionState,
  type RalphSessionStatus,
} from './ralphProcessManager.js';
import { RenderError, closeRenderBrowser, renderHtmlToScreenshot } from './renderService.js';
import { AnalysisError, analyzeSessionScreenshots, type AnalysisResult } from './visionAnalyzer.js';

type ApiErrorCode =
  | 'NO_FILES'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'UPLOAD_FAILED'
  | 'INVALID_REQUEST'
  | 'SESSION_NOT_FOUND'
  | 'IMAGE_NOT_FOUND'
  | 'ANALYSIS_FAILED'
  | 'ANALYSIS_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_FAILURE'
  | 'INVALID_IMAGE_BASE64'
  | 'COMPARE_FAILED'
  | 'COMPARE_TIMEOUT'
  | 'VISION_RATE_LIMITED'
  | 'HTML_TOO_LARGE'
  | 'RENDER_TIMEOUT'
  | 'RENDER_FAILED'
  | 'BROWSER_UNAVAILABLE'
  | 'LOOP_NOT_FOUND'
  | 'LOOP_ALREADY_RUNNING'
  | 'LOOP_NOT_RUNNING'
  | 'LOOP_STILL_RUNNING'
  | 'LOOP_NOT_COMPLETED'
  | 'DOWNLOAD_FAILED'
  | 'GITHUB_AUTH_FAILED'
  | 'GITHUB_INVALID_REPO_URL'
  | 'GITHUB_REPOSITORY_NOT_FOUND'
  | 'GITHUB_API_ERROR'
  | 'LOOP_START_FAILED'
  | 'INTERNAL_ERROR';

class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code: ApiErrorCode, status: number, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    uploadSessionId?: string;
    uploadSessionDir?: string;
  }
}

const app = express();
const port = Number(process.env.PORT ?? 3001);
const ralphProcessManager = new RalphProcessManager();

const UPLOAD_FIELD_NAME = 'screenshots';
const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const SESSION_DIR_PREFIX = 'ralphton-';
const TMP_ROOT = '/tmp';
const STALE_DIR_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SSE_KEEPALIVE_MS = 15_000;
const MAX_LOOP_EVENT_HISTORY = 200;
const RALPH_RUNNER_PATH = path.resolve(process.cwd(), 'scripts', 'ralph', 'ralph.sh');
const OPENWAIFU_DEFAULT_WS_URL = 'ws://localhost:12393/ws';
const OPENWAIFU_PROBE_TIMEOUT_MS = 1_500;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CompareMode = 'vision' | 'pixel' | 'both';
const ALLOWED_COMPARE_MODES = new Set<CompareMode>(['vision', 'pixel', 'both']);

type LoopStartConfig = {
  projectName: string;
  maxIterations: number;
  targetScore: number;
  githubUrl?: string;
  githubToken?: string;
};

type LoopEventName = 'iteration-start' | 'iteration-complete' | 'loop-complete' | 'loop-error';

type LoopEventEnvelope = {
  id: number;
  event: LoopEventName;
  data: Record<string, unknown>;
};

type LoopIterationHistoryEntry = {
  iteration: number;
  score: number | null;
  improvement: number | null;
  commitUrl: string | null;
};

type LoopGitHubConfig = {
  session: GitHubCommitSession;
  scoreHistory: ScoreHistoryEntry[];
  queue: Promise<void>;
};

type LoopSessionRecord = {
  sessionId: string;
  config: LoopStartConfig;
  analysis: AnalysisResult | null;
  startedAtMs: number;
  startedAtIso: string;
  completedAtMs: number | null;
  bestScore: number | null;
  bestIteration: number;
  lastError: string | null;
  lastIterationScore: number | null;
  lastIterationEventKey: string | null;
  iterationHistory: LoopIterationHistoryEntry[];
  github: LoopGitHubConfig | null;
  events: LoopEventEnvelope[];
  subscribers: Set<Response>;
  autoEvaluatedIterations: Set<number>;
  autoEvaluationScores: Map<number, number>;
  iterationEventQueue: Promise<void>;
};

const loopSessions = new Map<string, LoopSessionRecord>();
let nextSseEventId = 1;

type OriginalUploadAsset = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

type RankedIterationScreenshot = {
  iteration: number;
  score: number;
  base64: string;
};

type IterationAutoEvaluationResult = {
  primaryScore: number | null;
  screenshotBase64: string | null;
  diffImageBase64: string | null;
  mode: 'vision+pixel' | 'pixel-only' | 'error';
  error: string | null;
};

type WsProbeEndpoint = {
  host: string;
  port: number;
};

const parseNumericValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const parseWsProbeEndpoint = (rawUrl: string): WsProbeEndpoint | null => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }

    const host = parsed.hostname.trim();
    if (host.length === 0) {
      return null;
    }

    const fallbackPort = parsed.protocol === 'wss:' ? 443 : 80;
    const port = parsed.port.length > 0 ? Number(parsed.port) : fallbackPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }

    return { host, port };
  } catch {
    return null;
  }
};

const probeTcpReachability = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    let socket: Socket;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    try {
      socket = createConnection({ host, port });
    } catch {
      resolve(false);
      return;
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });

const runOpenWaifuStartupProbe = async (): Promise<void> => {
  const wsUrl = (process.env.OPENWAIFU_WS_URL ?? OPENWAIFU_DEFAULT_WS_URL).trim();
  const endpoint = parseWsProbeEndpoint(wsUrl);

  if (!endpoint) {
    console.warn(`[startup] OPENWAIFU_WS_URL '${wsUrl}' is invalid. Expected ws:// or wss:// URL.`);
    return;
  }

  const reachable = await probeTcpReachability(endpoint.host, endpoint.port, OPENWAIFU_PROBE_TIMEOUT_MS);
  if (!reachable) {
    console.warn(
      `[startup] OpenWaifu WebSocket endpoint is unreachable at ${endpoint.host}:${endpoint.port} (${wsUrl}). Continuing startup.`,
    );
  }
};

const ensureRalphRunnerAvailable = async (): Promise<void> => {
  try {
    await fs.access(RALPH_RUNNER_PATH, fsConstants.F_OK | fsConstants.X_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new Error(
      `Ralph runner is missing or not executable at '${RALPH_RUNNER_PATH}'. Run 'npm run setup' first. (${detail})`,
    );
  }
};

const slugifyProjectName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : 'screenclone';
};

const formatZipScore = (score: number | null): string => {
  if (score === null || !Number.isFinite(score)) {
    return '0';
  }

  const bounded = Math.max(0, Math.min(100, score));
  return String(Math.round(bounded));
};

const getImageMimeTypeFromExtension = (extension: string): string => {
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }

  if (extension === '.webp') {
    return 'image/webp';
  }

  return 'image/png';
};

const collectOriginalUploadAssets = async (sessionId: string): Promise<OriginalUploadAsset[]> => {
  const sessionDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`);
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return [];
  }

  const originalFilenames = entries
    .filter((entry) => ALLOWED_IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const assets = await Promise.all(
    originalFilenames.map(async (filename) => {
      const fullPath = path.join(sessionDir, filename);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) {
          return null;
        }
        const extension = path.extname(filename).toLowerCase();
        const buffer = await fs.readFile(fullPath);
        return {
          filename,
          mimeType: getImageMimeTypeFromExtension(extension),
          buffer,
        } as OriginalUploadAsset;
      } catch {
        return null;
      }
    }),
  );

  return assets.filter((asset): asset is OriginalUploadAsset => asset !== null);
};

const collectBestIterationScreenshots = (session: LoopSessionRecord): RankedIterationScreenshot[] => {
  const screenshotByIteration = new Map<number, string>();

  for (const event of session.events) {
    if (event.event !== 'iteration-complete') {
      continue;
    }

    const iteration = parseNumericValue(event.data.iteration);
    const screenshotBase64 = typeof event.data.screenshotBase64 === 'string' ? event.data.screenshotBase64.trim() : '';
    if (!iteration || !Number.isInteger(iteration) || screenshotBase64.length === 0) {
      continue;
    }

    if (!screenshotByIteration.has(iteration)) {
      screenshotByIteration.set(iteration, screenshotBase64);
    }
  }

  return session.iterationHistory
    .filter((entry): entry is LoopIterationHistoryEntry & { score: number } => entry.score !== null)
    .filter((entry) => screenshotByIteration.has(entry.iteration))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.iteration - a.iteration;
    })
    .slice(0, 3)
    .map((entry) => ({
      iteration: entry.iteration,
      score: entry.score,
      base64: screenshotByIteration.get(entry.iteration) ?? '',
    }))
    .filter((entry) => entry.base64.length > 0);
};

const buildDownloadReadme = (params: {
  projectName: string;
  finalScore: number | null;
  totalIterations: number;
  timestampIso: string;
  originalScreenshotDataUri: string | null;
  iterationHistory: LoopIterationHistoryEntry[];
}): string => {
  const lines: string[] = [
    `# ${params.projectName} - Clone Export`,
    '',
    `- Final score: ${params.finalScore !== null ? `${params.finalScore.toFixed(2)}%` : 'n/a'}`,
    `- Total iterations: ${params.totalIterations}`,
    `- Exported at: ${params.timestampIso}`,
    '',
    '## Original Screenshot',
    '',
  ];

  if (params.originalScreenshotDataUri) {
    lines.push(`![Original Screenshot](${params.originalScreenshotDataUri})`);
  } else {
    lines.push('Original screenshot unavailable.');
  }

  lines.push('', '## Score History', '', '| Iteration | Score | Delta | Commit |', '| --- | ---: | ---: | --- |');

  if (params.iterationHistory.length === 0) {
    lines.push('| - | - | - | - |');
  } else {
    for (const entry of params.iterationHistory) {
      const scoreText = entry.score !== null ? `${entry.score.toFixed(2)}%` : 'n/a';
      const deltaText = entry.improvement !== null ? `${entry.improvement >= 0 ? '+' : ''}${entry.improvement.toFixed(2)}%` : 'n/a';
      const commitText = entry.commitUrl ? `[commit](${entry.commitUrl})` : '-';
      lines.push(`| ${entry.iteration} | ${scoreText} | ${deltaText} | ${commitText} |`);
    }
  }

  return `${lines.join('\n')}\n`;
};

const createLoopDownloadArchive = async (
  sessionId: string,
  session: LoopSessionRecord,
): Promise<{ filename: string; buffer: Buffer }> => {
  const originalAssets = await collectOriginalUploadAssets(sessionId);
  const scoreHistory: ScoreHistoryEntry[] = session.iterationHistory
    .filter((entry): entry is LoopIterationHistoryEntry & { score: number } => entry.score !== null)
    .sort((a, b) => a.iteration - b.iteration)
    .map((entry) => ({
      iteration: entry.iteration,
      score: entry.score,
      delta: entry.improvement,
      commitUrl: entry.commitUrl,
      recordedAt: new Date(session.startedAtMs + entry.iteration * 1000).toISOString(),
    }));

  const snapshotFiles = await buildSnapshotFiles({
    sessionId,
    projectName: session.config.projectName,
    targetScore: session.config.targetScore,
    branchName: session.github?.session.branchName ?? 'local-session',
    originalScreenshotReference: originalAssets[0]?.filename ?? null,
    scoreHistory,
  });

  const totalIterations = session.iterationHistory.reduce((maxIteration, entry) => Math.max(maxIteration, entry.iteration), 0);
  const finalScore = session.lastIterationScore ?? session.bestScore;
  const firstOriginal = originalAssets[0] ?? null;
  const originalScreenshotDataUri = firstOriginal
    ? `data:${firstOriginal.mimeType};base64,${firstOriginal.buffer.toString('base64')}`
    : null;

  const readme = buildDownloadReadme({
    projectName: session.config.projectName,
    finalScore,
    totalIterations,
    timestampIso: new Date().toISOString(),
    originalScreenshotDataUri,
    iterationHistory: [...session.iterationHistory].sort((a, b) => a.iteration - b.iteration),
  });

  const zip = new JSZip();
  zip.file('index.html', snapshotFiles.indexHtml);
  zip.file('styles.css', snapshotFiles.stylesCss);
  zip.file('script.js', snapshotFiles.scriptJs);
  zip.file('README.md', readme);

  const originalsFolder = zip.folder('originals');
  if (originalsFolder) {
    if (originalAssets.length === 0) {
      originalsFolder.file('README.txt', 'No uploaded reference screenshots were found for this session.\n');
    } else {
      for (const asset of originalAssets) {
        originalsFolder.file(asset.filename, asset.buffer);
      }
    }
  }

  const iterationScreenshots = collectBestIterationScreenshots(session);
  const iterationsFolder = zip.folder('iterations');
  if (iterationsFolder) {
    if (iterationScreenshots.length === 0) {
      iterationsFolder.file('README.txt', 'No iteration screenshots were available to export.\n');
    } else {
      let addedCount = 0;
      for (const screenshot of iterationScreenshots) {
        const imageBuffer = Buffer.from(screenshot.base64, 'base64');
        if (imageBuffer.length === 0) {
          continue;
        }

        const scoreToken = screenshot.score.toFixed(2).replace('.', '_');
        const fileName = `iteration-${String(screenshot.iteration).padStart(2, '0')}-${scoreToken}pct.png`;
        iterationsFolder.file(fileName, imageBuffer);
        addedCount += 1;
      }

      if (addedCount === 0) {
        iterationsFolder.file('README.txt', 'No valid iteration screenshots were available to export.\n');
      }
    }
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const filename = `ralphton-${slugifyProjectName(session.config.projectName)}-${formatZipScore(finalScore)}pct.zip`;
  return { filename, buffer };
};

const sanitizeFilename = (filename: string): string => {
  const base = path.basename(filename).trim();
  if (base.length === 0) {
    return `upload-${Date.now()}`;
  }

  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const ensureUploadSession = async (req: Request): Promise<void> => {
  if (req.uploadSessionId && req.uploadSessionDir) {
    return;
  }

  const sessionId = uuidv4();
  const sessionDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`);

  await fs.mkdir(sessionDir, { recursive: true });

  req.uploadSessionId = sessionId;
  req.uploadSessionDir = sessionDir;
};

const removeUploadSessionDir = async (req: Request): Promise<void> => {
  if (!req.uploadSessionDir) {
    return;
  }

  try {
    await fs.rm(req.uploadSessionDir, { recursive: true, force: true });
  } catch {
    // Cleanup failures should not hide the primary error path.
  }

  req.uploadSessionDir = undefined;
  req.uploadSessionId = undefined;
};

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void => {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(new ApiError(`Unsupported file type '${file.mimetype}'`, 'INVALID_FILE_TYPE', 400));
    return;
  }

  cb(null, true);
};

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      await ensureUploadSession(req);
      cb(null, req.uploadSessionDir!);
    } catch {
      cb(new ApiError('Failed to prepare upload session directory', 'UPLOAD_FAILED', 500), TMP_ROOT);
    }
  },
  filename: (_req, file, cb) => {
    cb(null, sanitizeFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES,
  },
});

const cleanupStaleUploadDirs = async (): Promise<void> => {
  let entries: string[];

  try {
    entries = await fs.readdir(TMP_ROOT);
  } catch {
    return;
  }

  const now = Date.now();
  const targets = entries.filter((entry) => entry.startsWith(SESSION_DIR_PREFIX));

  await Promise.all(
    targets.map(async (entry) => {
      const fullPath = path.join(TMP_ROOT, entry);

      try {
        const stats = await fs.stat(fullPath);
        if (!stats.isDirectory()) {
          return;
        }

        const ageMs = now - stats.mtimeMs;
        if (ageMs >= STALE_DIR_AGE_MS) {
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup races or stale stat entries.
      }
    }),
  );
};

void cleanupStaleUploadDirs();
const cleanupTimer = setInterval(() => {
  void cleanupStaleUploadDirs();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  }),
);
app.use(express.json({ limit: '2mb' }));

const apiKeyAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const configuredApiKey = process.env.API_KEY;
  if (!configuredApiKey) {
    next();
    return;
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const requestApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (requestApiKey !== configuredApiKey) {
    res.status(401).json({ error: 'Unauthorized', code: 'INVALID_REQUEST' });
    return;
  }

  next();
};

const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const heavyApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiKeyAuthMiddleware);
app.use('/api', apiRateLimiter);
app.use(['/api/render', '/api/loop/start', '/api/analyze', '/api/compare'], heavyApiRateLimiter);

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '1.0.0' });
});

app.post('/api/upload', (req: Request, res: Response, next: NextFunction) => {
  upload.array(UPLOAD_FIELD_NAME, MAX_FILES)(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      await removeUploadSessionDir(req);

      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new ApiError('File exceeds 10MB limit', 'FILE_TOO_LARGE', 400));
        return;
      }

      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        next(new ApiError('A maximum of 5 files is allowed', 'TOO_MANY_FILES', 400));
        return;
      }

      next(new ApiError(err.message, 'UPLOAD_FAILED', 400));
      return;
    }

    if (err) {
      await removeUploadSessionDir(req);
      next(err);
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      await removeUploadSessionDir(req);
      next(new ApiError('At least one image is required', 'NO_FILES', 400));
      return;
    }

    res.status(201).json({
      sessionId: req.uploadSessionId,
      files: files.map((file) => ({
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
      })),
    });
  });
});

const parseImageIndex = (rawValue: unknown): number | undefined => {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return undefined;
  }

  const parsedValue =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number(rawValue)
        : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new ApiError('imageIndex must be a non-negative integer', 'INVALID_REQUEST', 400);
  }

  return parsedValue;
};

const parseOptionalInteger = (
  rawValue: unknown,
  field: 'width' | 'height' | 'waitMs',
  min: number,
  max: number,
): number | undefined => {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return undefined;
  }

  const parsedValue =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number(rawValue)
        : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    throw new ApiError(`${field} must be an integer between ${min} and ${max}`, 'INVALID_REQUEST', 400);
  }

  return parsedValue;
};

const parseLoopString = (rawValue: unknown, field: string, required: boolean): string => {
  if (typeof rawValue !== 'string') {
    if (required) {
      throw new ApiError(`${field} is required`, 'INVALID_REQUEST', 400);
    }

    return '';
  }

  const trimmed = rawValue.trim();
  if (required && trimmed.length === 0) {
    throw new ApiError(`${field} is required`, 'INVALID_REQUEST', 400);
  }

  return trimmed;
};

const parseSessionId = (rawValue: unknown, field: string, required: boolean): string => {
  const parsed = parseLoopString(rawValue, field, required);
  if (parsed.length === 0) {
    return '';
  }

  if (!UUID_V4_REGEX.test(parsed)) {
    throw new ApiError(`${field} must be a valid UUID v4`, 'INVALID_REQUEST', 400);
  }

  return parsed;
};

const parseLoopInteger = (rawValue: unknown, field: string, min: number, max: number): number => {
  const parsedValue =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number(rawValue)
        : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    throw new ApiError(`${field} must be an integer between ${min} and ${max}`, 'INVALID_REQUEST', 400);
  }

  return parsedValue;
};

const isLoopStateActive = (state: RalphSessionState): boolean =>
  state === 'uploading' || state === 'analyzing' || state === 'cloning';

const getRalphStatusOrNull = (sessionId: string): RalphSessionStatus | null => {
  try {
    return ralphProcessManager.getStatus(sessionId);
  } catch {
    return null;
  }
};

const parseLoopStartRequest = (body: unknown): { sessionId: string; config: LoopStartConfig } => {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const sessionId = parseSessionId(payload.sessionId, 'sessionId', true);
  const configRaw = payload.config && typeof payload.config === 'object' ? (payload.config as Record<string, unknown>) : null;

  if (!configRaw) {
    throw new ApiError('config is required', 'INVALID_REQUEST', 400);
  }

  const projectName = parseLoopString(configRaw.projectName, 'config.projectName', true);
  const maxIterations = parseLoopInteger(configRaw.maxIterations, 'config.maxIterations', 1, 10_000);
  const targetScoreValue = configRaw.targetScore ?? 90;
  const targetScore = parseLoopInteger(targetScoreValue, 'config.targetScore', 0, 100);
  const githubUrl = parseLoopString(configRaw.githubUrl, 'config.githubUrl', false);
  const githubToken = parseLoopString(configRaw.githubToken, 'config.githubToken', false);
  const hasGitHubUrl = githubUrl.length > 0;
  const hasGitHubToken = githubToken.length > 0;

  if (hasGitHubUrl !== hasGitHubToken) {
    throw new ApiError('config.githubUrl and config.githubToken must both be provided', 'INVALID_REQUEST', 400);
  }

  if (hasGitHubUrl) {
    try {
      const parsedUrl = new URL(githubUrl);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error('invalid protocol');
      }
    } catch {
      throw new ApiError('config.githubUrl must be a valid URL', 'INVALID_REQUEST', 400);
    }
  }

  return {
    sessionId,
    config: {
      projectName,
      maxIterations,
      targetScore,
      githubUrl: githubUrl.length > 0 ? githubUrl : undefined,
      githubToken: githubToken.length > 0 ? githubToken : undefined,
    },
  };
};

const createLoopSessionRecord = (
  sessionId: string,
  config: LoopStartConfig,
  analysis: AnalysisResult | null,
  github: LoopGitHubConfig | null = null,
  startedAtMs: number = Date.now(),
): LoopSessionRecord => {
  return {
    sessionId,
    config,
    analysis,
    startedAtMs,
    startedAtIso: new Date(startedAtMs).toISOString(),
    completedAtMs: null,
    bestScore: null,
    bestIteration: 0,
    lastError: null,
    lastIterationScore: null,
    lastIterationEventKey: null,
    iterationHistory: [],
    github,
    events: [],
    subscribers: new Set<Response>(),
    autoEvaluatedIterations: new Set<number>(),
    autoEvaluationScores: new Map<number, number>(),
    iterationEventQueue: Promise.resolve(),
  };
};

const writeSseEvent = (res: Response, envelope: LoopEventEnvelope): boolean => {
  try {
    res.write(`id: ${envelope.id}\n`);
    res.write(`event: ${envelope.event}\n`);
    res.write(`data: ${JSON.stringify(envelope.data)}\n\n`);
    return true;
  } catch {
    return false;
  }
};

const publishLoopEvent = (sessionId: string, event: LoopEventName, data: Record<string, unknown>): void => {
  const session = loopSessions.get(sessionId);
  if (!session) {
    return;
  }

  const envelope: LoopEventEnvelope = {
    id: nextSseEventId++,
    event,
    data,
  };

  session.events.push(envelope);
  if (session.events.length > MAX_LOOP_EVENT_HISTORY) {
    session.events.splice(0, session.events.length - MAX_LOOP_EVENT_HISTORY);
  }

  for (const subscriber of Array.from(session.subscribers)) {
    const wrote = writeSseEvent(subscriber, envelope);
    if (!wrote) {
      session.subscribers.delete(subscriber);
    }
  }
};

const getLoopCodePreview = async (sessionId: string): Promise<string> => {
  const workspaceDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`, 'workspace');
  const candidatePaths = [
    path.join(workspaceDir, 'index.html'),
    path.join(workspaceDir, 'generated', 'index.html'),
    path.join(workspaceDir, 'output', 'index.html'),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const content = await fs.readFile(candidatePath, 'utf8');
      const normalized = content.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        return normalized.slice(0, 200);
      }
    } catch {
      // Continue fallback search.
    }
  }

  try {
    const outputLines = ralphProcessManager.getOutput(sessionId, 60);
    const preview = outputLines.slice(-20).join('\n').trim();
    return preview.slice(0, 200);
  } catch {
    return '';
  }
};

const getLoopImageArtifact = async (sessionId: string, candidateFilenames: string[]): Promise<string | null> => {
  const roots = [
    path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`, 'workspace'),
    path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`, 'workspace', 'ralph-runtime'),
  ];

  for (const root of roots) {
    for (const candidateFilename of candidateFilenames) {
      const candidatePath = path.join(root, candidateFilename);
      try {
        const stats = await fs.stat(candidatePath);
        if (!stats.isFile()) {
          continue;
        }

        const buffer = await fs.readFile(candidatePath);
        return buffer.toString('base64');
      } catch {
        // Continue searching for the first available artifact.
      }
    }
  }

  return null;
};

const getSessionWorkspaceDir = (sessionId: string): string =>
  path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`, 'workspace');

const getSessionRuntimeProgressPath = (sessionId: string): string =>
  path.join(getSessionWorkspaceDir(sessionId), 'ralph-runtime', 'progress.txt');

const getLoopGeneratedHtml = async (sessionId: string): Promise<string | null> => {
  const workspaceDir = getSessionWorkspaceDir(sessionId);
  const candidatePaths = [
    path.join(workspaceDir, 'index.html'),
    path.join(workspaceDir, 'generated', 'index.html'),
    path.join(workspaceDir, 'output', 'index.html'),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const html = await fs.readFile(candidatePath, 'utf8');
      if (html.trim().length > 0) {
        return html;
      }
    } catch {
      // Continue searching candidate output files.
    }
  }

  return null;
};

const getPrimaryOriginalScreenshotBase64 = async (sessionId: string): Promise<string | null> => {
  const originals = await collectOriginalUploadAssets(sessionId);
  const first = originals[0];
  if (!first) {
    return null;
  }

  return first.buffer.toString('base64');
};

const saveIterationImageArtifacts = async (params: {
  sessionId: string;
  iteration: number;
  generatedScreenshotBase64: string;
  diffImageBase64: string | null;
}): Promise<void> => {
  const workspaceDir = getSessionWorkspaceDir(params.sessionId);
  const iterationsDir = path.join(workspaceDir, 'iterations');

  const generatedBuffer = Buffer.from(params.generatedScreenshotBase64, 'base64');
  if (generatedBuffer.length === 0) {
    return;
  }

  const iterationToken = String(params.iteration).padStart(3, '0');
  const writes: Promise<void>[] = [
    fs.writeFile(path.join(workspaceDir, 'latest.png'), generatedBuffer),
    fs.writeFile(path.join(workspaceDir, 'generated.png'), generatedBuffer),
    fs.writeFile(path.join(iterationsDir, `iteration-${iterationToken}-generated.png`), generatedBuffer),
  ];

  if (params.diffImageBase64) {
    const diffBuffer = Buffer.from(params.diffImageBase64, 'base64');
    if (diffBuffer.length > 0) {
      writes.push(
        fs.writeFile(path.join(workspaceDir, 'diff.png'), diffBuffer),
        fs.writeFile(path.join(workspaceDir, 'pixel-diff.png'), diffBuffer),
        fs.writeFile(path.join(iterationsDir, `iteration-${iterationToken}-diff.png`), diffBuffer),
      );
    }
  }

  try {
    await fs.mkdir(iterationsDir, { recursive: true });
    await Promise.all(writes);
  } catch {
    // Artifact writes should never fail the loop.
  }
};

const appendAutoEvalProgressEntry = async (params: {
  sessionId: string;
  iteration: number;
  result: IterationAutoEvaluationResult;
  compareResult?: Awaited<ReturnType<typeof compareScreenshots>>;
}): Promise<void> => {
  const progressPath = getSessionRuntimeProgressPath(params.sessionId);
  const lines: string[] = ['', `## [AUTO_EVAL] Iteration ${params.iteration}`];

  if (params.result.error) {
    lines.push('Status: error', `Error: ${params.result.error}`);
  } else {
    lines.push(`Status: ${params.result.mode}`);
    if (params.result.primaryScore !== null) {
      lines.push(`Primary score: ${params.result.primaryScore.toFixed(2)}/100`);
    }

    if (params.compareResult?.vision) {
      const vision = params.compareResult.vision;
      lines.push(`Vision verdict: ${vision.verdict} (${vision.score.toFixed(2)}/100)`, 'Differences:');
      if (vision.differences.length === 0) {
        lines.push('- None reported');
      } else {
        lines.push(...vision.differences.map((item) => `- ${item}`));
      }

      lines.push('Suggestions:');
      if (vision.suggestions.length === 0) {
        lines.push('- None reported');
      } else {
        lines.push(...vision.suggestions.map((item) => `- ${item}`));
      }
    }

    if (params.compareResult?.pixel) {
      const pixel = params.compareResult.pixel;
      lines.push(
        `Pixel score: ${pixel.pixelScore.toFixed(2)}/100 (${pixel.mismatchedPixels}/${pixel.totalPixels} mismatched)`,
      );
    }
  }

  lines.push('---', '');

  try {
    await fs.appendFile(progressPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // Progress logging should not fail loop orchestration.
  }
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

const autoEvaluateIteration = async (
  sessionId: string,
  iteration: number,
): Promise<IterationAutoEvaluationResult> => {
  const generatedHtml = await getLoopGeneratedHtml(sessionId);
  if (!generatedHtml) {
    const result: IterationAutoEvaluationResult = {
      primaryScore: null,
      screenshotBase64: null,
      diffImageBase64: null,
      mode: 'error',
      error: 'Generated HTML was not found in workspace output paths.',
    };
    await appendAutoEvalProgressEntry({ sessionId, iteration, result });
    return result;
  }

  let renderedScreenshotBase64: string;
  try {
    const renderResult = await renderHtmlToScreenshot({ html: generatedHtml });
    renderedScreenshotBase64 = renderResult.screenshot;
  } catch (error) {
    const result: IterationAutoEvaluationResult = {
      primaryScore: null,
      screenshotBase64: null,
      diffImageBase64: null,
      mode: 'error',
      error: `Render failed: ${describeError(error)}`,
    };
    await appendAutoEvalProgressEntry({ sessionId, iteration, result });
    return result;
  }

  const originalBase64 = await getPrimaryOriginalScreenshotBase64(sessionId);
  if (!originalBase64) {
    const result: IterationAutoEvaluationResult = {
      primaryScore: null,
      screenshotBase64: renderedScreenshotBase64,
      diffImageBase64: null,
      mode: 'error',
      error: 'Original screenshot could not be loaded for comparison.',
    };
    await saveIterationImageArtifacts({
      sessionId,
      iteration,
      generatedScreenshotBase64: renderedScreenshotBase64,
      diffImageBase64: null,
    });
    await appendAutoEvalProgressEntry({ sessionId, iteration, result });
    return result;
  }

  try {
    const compareResult = await compareScreenshots({
      original: originalBase64,
      generated: renderedScreenshotBase64,
      mode: 'both',
    });
    const result: IterationAutoEvaluationResult = {
      primaryScore: compareResult.primaryScore,
      screenshotBase64: renderedScreenshotBase64,
      diffImageBase64: compareResult.pixel?.diffImage ?? null,
      mode: compareResult.vision ? 'vision+pixel' : 'pixel-only',
      error: null,
    };

    await saveIterationImageArtifacts({
      sessionId,
      iteration,
      generatedScreenshotBase64: renderedScreenshotBase64,
      diffImageBase64: result.diffImageBase64,
    });
    await appendAutoEvalProgressEntry({ sessionId, iteration, result, compareResult });

    return result;
  } catch (error) {
    const result: IterationAutoEvaluationResult = {
      primaryScore: null,
      screenshotBase64: renderedScreenshotBase64,
      diffImageBase64: null,
      mode: 'error',
      error: `Compare failed: ${describeError(error)}`,
    };
    await saveIterationImageArtifacts({
      sessionId,
      iteration,
      generatedScreenshotBase64: renderedScreenshotBase64,
      diffImageBase64: null,
    });
    await appendAutoEvalProgressEntry({ sessionId, iteration, result });
    return result;
  }
};

const enqueueGitHubTask = async <T>(session: LoopSessionRecord, task: () => Promise<T>): Promise<T> => {
  if (!session.github) {
    throw new Error('GitHub config is not enabled for this session');
  }

  const chainedTask = session.github.queue.then(task, task);
  session.github.queue = chainedTask.then(
    () => undefined,
    () => undefined,
  );

  return chainedTask;
};

const mapGitHubErrorToApiError = (error: GitHubCommitError): ApiError => {
  if (error.code === 'INVALID_TOKEN') {
    return new ApiError(error.message, 'GITHUB_AUTH_FAILED', 401);
  }

  if (error.code === 'INVALID_REPO') {
    const apiCode = error.status === 404 ? 'GITHUB_REPOSITORY_NOT_FOUND' : 'GITHUB_INVALID_REPO_URL';
    return new ApiError(error.message, apiCode, error.status);
  }

  return new ApiError(error.message, 'GITHUB_API_ERROR', error.status);
};

const commitImprovingIteration = async (
  session: LoopSessionRecord,
  iteration: number,
  score: number,
  deltaFromBest: number,
): Promise<string | null> => {
  const github = session.github;
  if (!github) {
    return null;
  }

  const scoreEntry: ScoreHistoryEntry = {
    iteration,
    score,
    delta: Number(deltaFromBest.toFixed(2)),
    commitUrl: null,
    recordedAt: new Date().toISOString(),
  };
  github.scoreHistory.push(scoreEntry);

  const commitUrl = await enqueueGitHubTask(session, async () => {
    const snapshotFiles = await buildSnapshotFiles({
      sessionId: session.sessionId,
      projectName: session.config.projectName,
      targetScore: session.config.targetScore,
      branchName: github.session.branchName,
      originalScreenshotReference: github.session.originalScreenshotReference,
      scoreHistory: github.scoreHistory,
    });

    return commitImprovementSnapshot({
      session: github.session,
      iteration,
      score,
      delta: deltaFromBest,
      files: snapshotFiles,
    });
  });

  if (commitUrl.length > 0) {
    scoreEntry.commitUrl = commitUrl;
    return commitUrl;
  }

  return null;
};

const commitFinalSummary = async (
  session: LoopSessionRecord,
  iteration: number,
  score: number,
): Promise<string | null> => {
  const github = session.github;
  if (!github) {
    return null;
  }

  return enqueueGitHubTask(session, async () => {
    const snapshotFiles = await buildSnapshotFiles({
      sessionId: session.sessionId,
      projectName: session.config.projectName,
      targetScore: session.config.targetScore,
      branchName: github.session.branchName,
      originalScreenshotReference: github.session.originalScreenshotReference,
      scoreHistory: github.scoreHistory,
    });

    const commitUrl = await commitFinalSnapshot({
      session: github.session,
      iteration,
      score,
      files: snapshotFiles,
    });

    return commitUrl;
  });
};

const buildLoopStatusResponse = (sessionId: string): Record<string, unknown> => {
  const session = loopSessions.get(sessionId);
  if (!session) {
    throw new ApiError(`Session '${sessionId}' not found`, 'LOOP_NOT_FOUND', 404);
  }

  const ralphStatus = getRalphStatusOrNull(sessionId);
  const resolvedState = ralphStatus?.state ?? (session.completedAtMs ? 'completed' : 'failed');
  const elapsedMs =
    ralphStatus?.elapsedMs ??
    (session.completedAtMs && session.startedAtMs ? session.completedAtMs - session.startedAtMs : Date.now() - session.startedAtMs);

  return {
    sessionId,
    config: {
      projectName: session.config.projectName,
      maxIterations: session.config.maxIterations,
      targetScore: session.config.targetScore,
      githubUrl: session.config.githubUrl ?? null,
    },
    state: resolvedState,
    currentIteration: ralphStatus?.currentIteration ?? session.bestIteration,
    maxIterations: ralphStatus?.maxIterations ?? session.config.maxIterations,
    lastScore: ralphStatus?.lastScore ?? session.lastIterationScore,
    startedAt: ralphStatus?.startedAt ?? session.startedAtIso,
    elapsedMs,
    bestScore: session.bestScore,
    bestIteration: session.bestIteration,
    lastError: session.lastError,
    analysis: session.analysis,
    recentEvents: session.events.slice(-25),
  };
};

type ManagerIterationStartEvent = {
  sessionId: string;
  iteration: number;
  maxIterations: number;
};

type ManagerIterationCompleteEvent = {
  sessionId: string;
  iteration: number;
  score: number | null;
};

type ManagerLoopCompleteEvent = {
  sessionId: string;
  totalIterations: number;
  finalScore: number | null;
};

type ManagerLoopErrorEvent = {
  sessionId: string;
  error: string;
  iteration: number;
  lastScore: number | null;
};

ralphProcessManager.on('iteration-start', (payload: ManagerIterationStartEvent) => {
  const session = loopSessions.get(payload.sessionId);
  if (!session) {
    return;
  }

  const status = getRalphStatusOrNull(payload.sessionId);
  publishLoopEvent(payload.sessionId, 'iteration-start', {
    iteration: payload.iteration,
    maxIterations: payload.maxIterations,
    elapsedMs: status?.elapsedMs ?? Date.now() - session.startedAtMs,
  });
});

ralphProcessManager.on('iteration-complete', (payload: ManagerIterationCompleteEvent) => {
  const session = loopSessions.get(payload.sessionId);
  if (!session) {
    return;
  }

  session.iterationEventQueue = session.iterationEventQueue
    .then(async () => {
      const status = getRalphStatusOrNull(payload.sessionId);
      const iteration = Math.max(payload.iteration, status?.currentIteration ?? 0);

      let autoEvaluationResult: IterationAutoEvaluationResult | null = null;
      if (!session.autoEvaluatedIterations.has(iteration)) {
        session.autoEvaluatedIterations.add(iteration);
        autoEvaluationResult = await autoEvaluateIteration(payload.sessionId, iteration);
        if (autoEvaluationResult.primaryScore !== null) {
          session.autoEvaluationScores.set(iteration, autoEvaluationResult.primaryScore);
        }
      }

      const knownScore = session.autoEvaluationScores.get(iteration) ?? null;
      const score = knownScore ?? autoEvaluationResult?.primaryScore ?? payload.score ?? status?.lastScore ?? null;
      const dedupeKey = `${iteration}:${score ?? 'null'}`;
      if (session.lastIterationEventKey === dedupeKey) {
        return;
      }
      session.lastIterationEventKey = dedupeKey;

      const previousScore = session.lastIterationScore;
      const improvement = previousScore !== null && score !== null ? Number((score - previousScore).toFixed(2)) : null;
      const previousBestScore = session.bestScore;
      const isBestImprovement = score !== null && (previousBestScore === null || score > previousBestScore);
      session.lastIterationScore = score;

      if (score !== null && (session.bestScore === null || score > session.bestScore)) {
        session.bestScore = score;
        session.bestIteration = iteration;
      }

      const iterationHistoryEntry: LoopIterationHistoryEntry = {
        iteration,
        score,
        improvement,
        commitUrl: null,
      };
      session.iterationHistory.push(iterationHistoryEntry);

      let commitUrl: string | null = null;
      if (score !== null && isBestImprovement && session.github) {
        const deltaFromBest = previousBestScore === null ? score : score - previousBestScore;
        try {
          commitUrl = await commitImprovingIteration(session, iteration, score, deltaFromBest);
        } catch (error) {
          const message = describeError(error);
          console.warn(`[github] iteration commit failed for session ${payload.sessionId}: ${message}`);
        }
      }

      const [codePreview, fallbackScreenshotBase64, fallbackDiffImageBase64] = await Promise.all([
        getLoopCodePreview(payload.sessionId),
        getLoopImageArtifact(payload.sessionId, ['latest.png', 'generated.png', 'screenshot.png', 'clone.png']),
        getLoopImageArtifact(payload.sessionId, ['diff.png', 'pixel-diff.png', 'overlay.png']),
      ]);

      const screenshotBase64 = autoEvaluationResult?.screenshotBase64 ?? fallbackScreenshotBase64;
      const diffImageBase64 = autoEvaluationResult?.diffImageBase64 ?? fallbackDiffImageBase64;
      iterationHistoryEntry.commitUrl = commitUrl;

      publishLoopEvent(payload.sessionId, 'iteration-complete', {
        iteration,
        maxIterations: status?.maxIterations ?? session.config.maxIterations,
        score,
        previousScore,
        improvement,
        screenshotBase64,
        codePreview,
        diffImageBase64,
        commitUrl,
        elapsedMs: status?.elapsedMs ?? Date.now() - session.startedAtMs,
      });
    })
    .catch((error: unknown) => {
      console.warn(`[loop] iteration handler failed for session ${payload.sessionId}: ${describeError(error)}`);
    });
});

ralphProcessManager.on('loop-complete', (payload: ManagerLoopCompleteEvent) => {
  void (async () => {
    const session = loopSessions.get(payload.sessionId);
    if (!session) {
      return;
    }

    const status = getRalphStatusOrNull(payload.sessionId);
    const finalScore = payload.finalScore ?? status?.lastScore ?? session.lastIterationScore;
    if (finalScore !== null && (session.bestScore === null || finalScore > session.bestScore)) {
      session.bestScore = finalScore;
      session.bestIteration = payload.totalIterations;
    }

    session.completedAtMs = Date.now();

    publishLoopEvent(payload.sessionId, 'loop-complete', {
      totalIterations: payload.totalIterations,
      finalScore,
      totalElapsedMs: status?.elapsedMs ?? session.completedAtMs - session.startedAtMs,
      bestIteration: session.bestIteration,
    });

    if (session.github && finalScore !== null) {
      const github = session.github;
      const existingFinalEntry = github.scoreHistory.find(
        (entry) => entry.iteration === payload.totalIterations && entry.score === finalScore,
      );
      const finalEntry =
        existingFinalEntry ??
        (() => {
          const entry: ScoreHistoryEntry = {
            iteration: payload.totalIterations,
            score: finalScore,
            delta: null,
            commitUrl: null,
            recordedAt: new Date().toISOString(),
          };
          github.scoreHistory.push(entry);
          return entry;
        })();

      try {
        const finalCommitUrl = await commitFinalSummary(session, payload.totalIterations, finalScore);
        if (finalCommitUrl) {
          finalEntry.commitUrl = finalCommitUrl;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown GitHub final commit failure';
        console.warn(`[github] final commit failed for session ${payload.sessionId}: ${message}`);
      }
    }
  })();
});

ralphProcessManager.on('loop-error', (payload: ManagerLoopErrorEvent) => {
  const session = loopSessions.get(payload.sessionId);
  if (!session) {
    return;
  }

  session.completedAtMs = Date.now();
  session.lastError = payload.error;
  if (payload.lastScore !== null) {
    session.lastIterationScore = payload.lastScore;
  }

  publishLoopEvent(payload.sessionId, 'loop-error', {
    error: payload.error,
    iteration: payload.iteration,
    lastScore: payload.lastScore,
  });
});

app.post('/api/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = parseSessionId(req.body?.sessionId, 'sessionId', true);

    const imageIndex = parseImageIndex(req.body?.imageIndex);
    const analysis = await analyzeSessionScreenshots({
      sessionId,
      imageIndex,
    });

    res.status(200).json(analysis);
  } catch (error) {
    if (error instanceof AnalysisError) {
      const responseDetails = error.retryable ? { retryable: true, retryAfterSeconds: 10 } : undefined;
      next(new ApiError(error.message, error.code as ApiErrorCode, error.status, responseDetails));
      return;
    }

    next(error);
  }
});

app.post('/api/render', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    if (!html.trim()) {
      throw new ApiError('html is required', 'INVALID_REQUEST', 400);
    }

    const width = parseOptionalInteger(req.body?.width, 'width', 64, 4096);
    const height = parseOptionalInteger(req.body?.height, 'height', 64, 4096);
    const waitMs = parseOptionalInteger(req.body?.waitMs, 'waitMs', 0, 25_000);

    const renderResult = await renderHtmlToScreenshot({
      html,
      width,
      height,
      waitMs,
    });

    res.status(200).json(renderResult);
  } catch (error) {
    if (error instanceof RenderError) {
      next(new ApiError(error.message, error.code as ApiErrorCode, error.status, error.details));
      return;
    }

    next(error);
  }
});

app.post('/api/compare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const iterationRaw = req.body?.iteration;
    let iteration: number | undefined;
    if (iterationRaw !== undefined && iterationRaw !== null && iterationRaw !== '') {
      const parsedIteration =
        typeof iterationRaw === 'number'
          ? iterationRaw
          : typeof iterationRaw === 'string'
            ? Number(iterationRaw)
            : Number.NaN;
      if (!Number.isInteger(parsedIteration) || parsedIteration < 0) {
        throw new ApiError('iteration must be a non-negative integer', 'INVALID_REQUEST', 400);
      }
      iteration = parsedIteration;
    }

    const parsedSessionId = parseSessionId(req.body?.sessionId, 'sessionId', false);
    const sessionId = parsedSessionId.length > 0 ? parsedSessionId : undefined;

    const modeRaw = req.body?.mode;
    let mode: CompareMode | undefined;
    if (modeRaw !== undefined && modeRaw !== null && modeRaw !== '') {
      if (typeof modeRaw !== 'string' || !ALLOWED_COMPARE_MODES.has(modeRaw as CompareMode)) {
        throw new ApiError("mode must be one of 'vision', 'pixel', or 'both'", 'INVALID_REQUEST', 400);
      }
      mode = modeRaw as CompareMode;
    }

    const compareResult = await compareScreenshots({
      original: typeof req.body?.original === 'string' ? req.body.original : '',
      generated: typeof req.body?.generated === 'string' ? req.body.generated : '',
      mode,
      sessionId,
      iteration,
    });

    res.status(200).json(compareResult);
  } catch (error) {
    if (error instanceof CompareError) {
      next(new ApiError(error.message, error.code as ApiErrorCode, error.status, error.details));
      return;
    }

    next(error);
  }
});

app.post('/api/loop/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, config } = parseLoopStartRequest(req.body);
    const existingStatus = getRalphStatusOrNull(sessionId);
    const loopStartedAtMs = Date.now();

    if (existingStatus && isLoopStateActive(existingStatus.state)) {
      throw new ApiError(`Session '${sessionId}' is already running`, 'LOOP_ALREADY_RUNNING', 409);
    }

    let github: LoopGitHubConfig | null = null;
    if (config.githubUrl && config.githubToken) {
      const githubSession = await initializeGitHubCommitSession({
        projectName: config.projectName,
        sessionId,
        repoUrl: config.githubUrl,
        token: config.githubToken,
      });
      github = {
        session: githubSession,
        scoreHistory: [],
        queue: Promise.resolve(),
      };
      config.githubToken = undefined;
    }

    const analysis = await analyzeSessionScreenshots({ sessionId });
    const record = createLoopSessionRecord(sessionId, config, analysis, github, loopStartedAtMs);
    const previousRecord = loopSessions.get(sessionId);
    if (previousRecord) {
      for (const subscriber of previousRecord.subscribers) {
        record.subscribers.add(subscriber);
      }
    }
    loopSessions.set(sessionId, record);
    let status: RalphSessionStatus;
    try {
      status = await ralphProcessManager.start(sessionId, {
        projectName: config.projectName,
        maxIterations: config.maxIterations,
        targetSimilarity: config.targetScore,
        analysis,
      });
    } catch (error) {
      loopSessions.delete(sessionId);
      throw error;
    }

    res.status(202).json({
      sessionId,
      state: status.state,
      currentIteration: status.currentIteration,
      maxIterations: status.maxIterations,
      targetScore: config.targetScore,
      startedAt: status.startedAt,
    });
  } catch (error) {
    if (error instanceof AnalysisError) {
      const responseDetails = error.retryable ? { retryable: true, retryAfterSeconds: 10 } : undefined;
      next(new ApiError(error.message, error.code as ApiErrorCode, error.status, responseDetails));
      return;
    }

    if (error instanceof GitHubCommitError) {
      next(mapGitHubErrorToApiError(error));
      return;
    }

    if (error instanceof ApiError) {
      next(error);
      return;
    }

    const message = error instanceof Error ? error.message : 'Unable to start loop';
    next(new ApiError(message, 'LOOP_START_FAILED', 400));
  }
});

app.get('/api/loop/:sessionId/events', (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = parseSessionId(req.params.sessionId, 'sessionId', true);
    const session = loopSessions.get(sessionId);
    if (!session) {
      throw new ApiError(`Session '${sessionId}' not found`, 'LOOP_NOT_FOUND', 404);
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    session.subscribers.add(res);
    for (const event of session.events) {
      writeSseEvent(res, event);
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepAlive);
        session.subscribers.delete(res);
      }
    }, SSE_KEEPALIVE_MS);
    keepAlive.unref();

    req.on('close', () => {
      clearInterval(keepAlive);
      session.subscribers.delete(res);
      res.end();
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/loop/:sessionId/status', (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = parseSessionId(req.params.sessionId, 'sessionId', true);
    const statusPayload = buildLoopStatusResponse(sessionId);
    res.status(200).json(statusPayload);
  } catch (error) {
    next(error);
  }
});

const handleLoopDownloadRequest = async (
  req: Request,
  res: Response,
  next: NextFunction,
  options: { headOnly: boolean },
): Promise<void> => {
  try {
    const sessionId = parseSessionId(req.params.sessionId, 'sessionId', true);
    const session = loopSessions.get(sessionId);
    if (!session) {
      throw new ApiError(`Session '${sessionId}' not found`, 'LOOP_NOT_FOUND', 404);
    }

    const status = getRalphStatusOrNull(sessionId);
    if (status && isLoopStateActive(status.state)) {
      throw new ApiError(`Session '${sessionId}' is still running`, 'LOOP_STILL_RUNNING', 409);
    }

    const isCompleted = status?.state === 'completed' || (session.completedAtMs !== null && session.lastError === null);
    if (!isCompleted) {
      throw new ApiError(`Session '${sessionId}' has not completed successfully`, 'LOOP_NOT_COMPLETED', 409);
    }

    const archive = await createLoopDownloadArchive(sessionId, session);

    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    res.setHeader('Content-Length', archive.buffer.byteLength.toString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Archive-Name', archive.filename);
    res.setHeader('X-Archive-Bytes', archive.buffer.byteLength.toString());

    if (options.headOnly) {
      res.end();
      return;
    }

    res.end(archive.buffer);
  } catch (error) {
    if (error instanceof ApiError) {
      next(error);
      return;
    }

    const message = error instanceof Error ? error.message : 'Failed to prepare archive download';
    next(new ApiError(message, 'DOWNLOAD_FAILED', 500));
  }
};

app.head('/api/loop/:sessionId/download', (req: Request, res: Response, next: NextFunction) => {
  void handleLoopDownloadRequest(req, res, next, { headOnly: true });
});

app.get('/api/loop/:sessionId/download', (req: Request, res: Response, next: NextFunction) => {
  void handleLoopDownloadRequest(req, res, next, { headOnly: false });
});

app.post('/api/loop/:sessionId/stop', (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = parseSessionId(req.params.sessionId, 'sessionId', true);
    const session = loopSessions.get(sessionId);
    if (!session) {
      throw new ApiError(`Session '${sessionId}' not found`, 'LOOP_NOT_FOUND', 404);
    }

    const status = getRalphStatusOrNull(sessionId);
    if (!status || !isLoopStateActive(status.state)) {
      throw new ApiError(`Session '${sessionId}' is not running`, 'LOOP_NOT_RUNNING', 409);
    }

    const stopped = ralphProcessManager.stop(sessionId);
    if (!stopped) {
      throw new ApiError(`Session '${sessionId}' is not running`, 'LOOP_NOT_RUNNING', 409);
    }

    res.status(202).json({
      sessionId,
      state: 'stopping',
      currentIteration: status.currentIteration,
      maxIterations: status.maxIterations,
      lastScore: status.lastScore,
    });
  } catch (error) {
    next(error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    const payload: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.details) {
      Object.assign(payload, err.details);
    }
    res.status(err.status).json(payload);
    return;
  }

  const bodyParserError = err as { type?: string; status?: number; message?: string } | null;
  if (bodyParserError?.type === 'entity.too.large' || bodyParserError?.status === 413) {
    res.status(413).json({ error: 'html payload exceeds 1MB', code: 'HTML_TOO_LARGE' });
    return;
  }

  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

let server: ReturnType<typeof app.listen> | null = null;

const startServer = async (): Promise<void> => {
  await ensureRalphRunnerAvailable();
  server = app.listen(port, () => {
    console.log(`ScreenClone backend listening on http://localhost:${port}`);
  });
  void runOpenWaifuStartupProbe().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[startup] OpenWaifu WebSocket probe failed: ${message}`);
  });
};

void startServer().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup] ${message}`);
  process.exit(1);
});

let isShuttingDown = false;
const shutdown = (): void => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  clearInterval(cleanupTimer);
  void Promise.allSettled([ralphProcessManager.shutdown(), closeRenderBrowser()]).finally(() => {
    if (!server) {
      process.exit(0);
      return;
    }

    server.close(() => {
      process.exit(0);
    });
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception', error);
  shutdown();
});
