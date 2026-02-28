import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

type ApiErrorCode =
  | 'NO_FILES'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'UPLOAD_FAILED'
  | 'INTERNAL_ERROR';

class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;

  constructor(message: string, code: ApiErrorCode, status: number) {
    super(message);
    this.code = code;
    this.status = status;
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

const UPLOAD_FIELD_NAME = 'screenshots';
const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const SESSION_DIR_PREFIX = 'ralphton-';
const TMP_ROOT = '/tmp';
const STALE_DIR_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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
app.use(express.json());

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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }

  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

const server = app.listen(port, () => {
  console.log(`ScreenClone backend listening on http://localhost:${port}`);
});

const shutdown = (): void => {
  clearInterval(cleanupTimer);
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
