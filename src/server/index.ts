import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import { promises as fs } from 'node:fs';
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
const SSE_KEEPALIVE_MS = 15_000;
const MAX_LOOP_EVENT_HISTORY = 200;

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
};

const loopSessions = new Map<string, LoopSessionRecord>();
let nextSseEventId = 1;

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

app.use(
  cors({
    origin: 'http://localhost:5173',
  }),
);
app.use(express.json({ limit: '2mb' }));

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
        path: file.path,
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
  const sessionId = parseLoopString(payload.sessionId, 'sessionId', true);
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
  const candidatePaths = [path.join(workspaceDir, 'index.html'), path.join(workspaceDir, 'generated', 'index.html')];

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
  void (async () => {
    const session = loopSessions.get(payload.sessionId);
    if (!session) {
      return;
    }

    const status = getRalphStatusOrNull(payload.sessionId);
    const score = payload.score ?? status?.lastScore ?? null;
    const iteration = Math.max(payload.iteration, status?.currentIteration ?? 0);
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
        const message = error instanceof Error ? error.message : 'unknown GitHub commit failure';
        console.warn(`[github] iteration commit failed for session ${payload.sessionId}: ${message}`);
      }
    }

    const [codePreview, screenshotBase64, diffImageBase64] = await Promise.all([
      getLoopCodePreview(payload.sessionId),
      getLoopImageArtifact(payload.sessionId, ['latest.png', 'generated.png', 'screenshot.png', 'clone.png']),
      getLoopImageArtifact(payload.sessionId, ['diff.png', 'pixel-diff.png', 'overlay.png']),
    ]);

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
  })();
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
    const sessionId =
      typeof req.body?.sessionId === 'string' && req.body.sessionId.trim().length > 0
        ? req.body.sessionId.trim()
        : null;

    if (!sessionId) {
      throw new ApiError('sessionId is required', 'INVALID_REQUEST', 400);
    }

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

    const sessionId =
      typeof req.body?.sessionId === 'string' && req.body.sessionId.trim().length > 0
        ? req.body.sessionId.trim()
        : undefined;

    const compareResult = await compareScreenshots({
      original: typeof req.body?.original === 'string' ? req.body.original : '',
      generated: typeof req.body?.generated === 'string' ? req.body.generated : '',
      mode: req.body?.mode as 'vision' | 'pixel' | 'both' | undefined,
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
    const sessionId = parseLoopString(req.params.sessionId, 'sessionId', true);
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
    const sessionId = parseLoopString(req.params.sessionId, 'sessionId', true);
    const statusPayload = buildLoopStatusResponse(sessionId);
    res.status(200).json(statusPayload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/loop/:sessionId/stop', (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = parseLoopString(req.params.sessionId, 'sessionId', true);
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

const server = app.listen(port, () => {
  console.log(`ScreenClone backend listening on http://localhost:${port}`);
});

let isShuttingDown = false;
const shutdown = (): void => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  clearInterval(cleanupTimer);
  void Promise.allSettled([ralphProcessManager.shutdown(), closeRenderBrowser()]).finally(() => {
    server.close(() => {
      process.exit(0);
    });
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
