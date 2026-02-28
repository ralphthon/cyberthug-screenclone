import cors from 'cors';
import express from 'express';
import multer, { MulterError } from 'multer';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_UPLOAD_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const TEMP_DIR_PREFIX = 'ralphton-';
const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UPLOAD_FIELD_NAME = 'screenshots';

class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface HealthResponse {
  status: 'ok';
  version: string;
}

interface UploadFileMetadata {
  filename: string;
  path: string;
  size: number;
  mimetype: string;
}

interface UploadResponse {
  sessionId: string;
  files: UploadFileMetadata[];
}

interface ApiErrorResponse {
  error: string;
  code: string;
}

const createApiError = (statusCode: number, code: string, message: string): ApiError =>
  new ApiError(statusCode, code, message);

const resolveSessionDirectory = (sessionId: string): string =>
  path.join(os.tmpdir(), `${TEMP_DIR_PREFIX}${sessionId}`);

const sanitizeFilename = (filename: string): string =>
  path.basename(filename).replace(/[/\\]+/g, '_');

const cleanupSessionDirectory = async (sessionDirectory?: string): Promise<void> => {
  if (!sessionDirectory) {
    return;
  }

  await rm(sessionDirectory, { recursive: true, force: true });
};

const hasPngSignature = (fileBuffer: Buffer): boolean =>
  fileBuffer.length >= 8 &&
  fileBuffer[0] === 0x89 &&
  fileBuffer[1] === 0x50 &&
  fileBuffer[2] === 0x4e &&
  fileBuffer[3] === 0x47 &&
  fileBuffer[4] === 0x0d &&
  fileBuffer[5] === 0x0a &&
  fileBuffer[6] === 0x1a &&
  fileBuffer[7] === 0x0a;

const hasJpegSignature = (fileBuffer: Buffer): boolean =>
  fileBuffer.length >= 3 &&
  fileBuffer[0] === 0xff &&
  fileBuffer[1] === 0xd8 &&
  fileBuffer[2] === 0xff;

const hasWebpSignature = (fileBuffer: Buffer): boolean =>
  fileBuffer.length >= 12 &&
  fileBuffer.toString('ascii', 0, 4) === 'RIFF' &&
  fileBuffer.toString('ascii', 8, 12) === 'WEBP';

const isMatchingImageSignature = (fileBuffer: Buffer, mimetype: string): boolean => {
  if (mimetype === 'image/png') {
    return hasPngSignature(fileBuffer);
  }

  if (mimetype === 'image/jpeg') {
    return hasJpegSignature(fileBuffer);
  }

  if (mimetype === 'image/webp') {
    return hasWebpSignature(fileBuffer);
  }

  return false;
};

const hasValidImageSignature = async (file: Express.Multer.File): Promise<boolean> => {
  const fileBuffer = await readFile(file.path);
  return isMatchingImageSignature(fileBuffer, file.mimetype);
};

const cleanupStaleSessionDirectories = async (): Promise<void> => {
  const cutoff = Date.now() - RETENTION_WINDOW_MS;
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_DIR_PREFIX))
      .map(async (entry) => {
        const directoryPath = path.join(os.tmpdir(), entry.name);
        const details = await stat(directoryPath);
        if (details.mtimeMs < cutoff) {
          await rm(directoryPath, { recursive: true, force: true });
        }
      }),
  );
};

declare module 'express-serve-static-core' {
  interface Request {
    uploadSessionId?: string;
    uploadSessionDir?: string;
  }
}

const storage = multer.diskStorage({
  destination: (req, _file, callback) => {
    if (!req.uploadSessionDir) {
      callback(
        createApiError(500, 'SESSION_DIR_MISSING', 'Upload session directory was not initialized.'),
        '',
      );
      return;
    }

    callback(null, req.uploadSessionDir);
  },
  filename: (_req, file, callback) => {
    callback(null, sanitizeFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_UPLOAD_FILES,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(
        createApiError(
          400,
          'INVALID_FILE_TYPE',
          'Only PNG, JPG, and WEBP images are allowed.',
        ),
      );
      return;
    }

    callback(null, true);
  },
});

const app = express();
const port = 3001;

app.use(
  cors({
    origin: 'http://localhost:5173',
  }),
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  const response: HealthResponse = { status: 'ok', version: '1.0.0' };
  res.json(response);
});

app.post('/api/upload', async (req, res, next) => {
  try {
    req.uploadSessionId = randomUUID();
    req.uploadSessionDir = resolveSessionDirectory(req.uploadSessionId);
    await mkdir(req.uploadSessionDir, { recursive: true });

    upload.array(UPLOAD_FIELD_NAME, MAX_UPLOAD_FILES)(req, res, (err) => {
      if (err) {
        cleanupSessionDirectory(req.uploadSessionDir)
          .catch((cleanupError) => {
            console.error('Failed to cleanup session directory after upload error:', cleanupError);
          })
          .finally(() => {
            next(err);
          });
        return;
      }

      const uploadedFiles = req.files as Express.Multer.File[] | undefined;
      if (!uploadedFiles || uploadedFiles.length === 0) {
        cleanupSessionDirectory(req.uploadSessionDir)
          .catch((cleanupError) => {
            console.error('Failed to cleanup session directory for empty upload:', cleanupError);
          })
          .finally(() => {
            next(createApiError(400, 'NO_FILES', 'No images were uploaded.'));
          });
        return;
      }

      if (!req.uploadSessionId) {
        cleanupSessionDirectory(req.uploadSessionDir)
          .catch((cleanupError) => {
            console.error('Failed to cleanup session directory with missing session ID:', cleanupError);
          })
          .finally(() => {
            next(createApiError(500, 'SESSION_ID_MISSING', 'Upload session ID was not initialized.'));
          });
        return;
      }

      Promise.all(uploadedFiles.map((file) => hasValidImageSignature(file)))
        .then((signatureValidationResults) => {
          if (signatureValidationResults.some((isValid) => !isValid)) {
            return cleanupSessionDirectory(req.uploadSessionDir).then(() => {
              throw createApiError(
                400,
                'INVALID_FILE_CONTENT',
                'Uploaded file content does not match its declared image type.',
              );
            });
          }

          const files: UploadFileMetadata[] = uploadedFiles.map((file) => ({
            filename: file.filename,
            path: file.path,
            size: file.size,
            mimetype: file.mimetype,
          }));

          const response: UploadResponse = {
            sessionId: req.uploadSessionId as string,
            files,
          };

          res.status(201).json(response);
        })
        .catch((validationError) => {
          next(validationError);
        });
    });
  } catch (error) {
    cleanupSessionDirectory(req.uploadSessionDir)
      .catch((cleanupError) => {
        console.error('Failed to cleanup session directory after request failure:', cleanupError);
      })
      .finally(() => {
        next(error);
      });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response<ApiErrorResponse>, _next: express.NextFunction) => {
  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        error: 'Each screenshot must be 10MB or smaller.',
        code: 'FILE_TOO_LARGE',
      });
      return;
    }

    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        error: `A maximum of ${MAX_UPLOAD_FILES} screenshots is allowed.`,
        code: 'TOO_MANY_FILES',
      });
      return;
    }

    res.status(400).json({
      error: error.message,
      code: error.code,
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
  });
});

const cleanupTimer = setInterval(() => {
  cleanupStaleSessionDirectories().catch((error) => {
    console.error('Failed to clean stale upload directories:', error);
  });
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

cleanupStaleSessionDirectories().catch((error) => {
  console.error('Initial stale directory cleanup failed:', error);
});

app.listen(port, () => {
  console.log(`ScreenClone backend listening on http://localhost:${port}`);
});
