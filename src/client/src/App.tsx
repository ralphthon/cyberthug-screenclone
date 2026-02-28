import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001';

const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CONFIG_STORAGE_KEY = 'ralphton-config';
const SSE_RECONNECT_MS = 3_000;

type Toast = {
  id: number;
  message: string;
};

type PreviewItem = {
  file: File;
  url: string;
};

type CloneConfig = {
  projectName: string;
  githubRepoUrl: string;
  githubToken: string;
  maxIterations: string;
  targetSimilarity: string;
};

type CloneConfigField = keyof CloneConfig;

type CloneConfigErrors = Partial<Record<CloneConfigField, string>>;

type LoopStatus = 'idle' | 'running' | 'complete' | 'error';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type IterationState = 'running' | 'complete' | 'error';

type LoopEventName = 'iteration-start' | 'iteration-complete' | 'loop-complete' | 'loop-error';

type LoopStartRequest = {
  sessionId: string;
  config: {
    projectName: string;
    maxIterations: number;
    targetScore: number;
    githubUrl?: string;
    githubToken?: string;
  };
};

type LoopStartResponse = {
  sessionId: string;
  state: string;
  currentIteration: number;
  maxIterations: number;
  targetScore: number;
  startedAt: string | null;
};

type IterationCard = {
  iteration: number;
  maxIterations: number | null;
  state: IterationState;
  score: number | null;
  previousScore: number | null;
  delta: number | null;
  feedbackSnippet: string;
  screenshotBase64: string | null;
  diffImageBase64: string | null;
  codePreview: string | null;
  commitUrl: string | null;
  elapsedMs: number | null;
  error: string | null;
};

type UploadResponse = {
  sessionId: string;
};

type ApiErrorResponse = {
  error?: string;
};

const DEFAULT_CLONE_CONFIG: CloneConfig = {
  projectName: '',
  githubRepoUrl: '',
  githubToken: '',
  maxIterations: '1000',
  targetSimilarity: '90',
};

function coerceStoredConfig(value: unknown): CloneConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<Record<CloneConfigField, unknown>>;

  const toStringValue = (field: CloneConfigField): string => {
    const fieldValue = candidate[field];
    return typeof fieldValue === 'string' ? fieldValue : DEFAULT_CLONE_CONFIG[field];
  };

  return {
    projectName: toStringValue('projectName'),
    githubRepoUrl: toStringValue('githubRepoUrl'),
    githubToken: toStringValue('githubToken'),
    maxIterations: toStringValue('maxIterations'),
    targetSimilarity: toStringValue('targetSimilarity'),
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function parseString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseEventData(rawData: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deriveFeedbackSnippet(score: number | null, delta: number | null, fallback: string | null): string {
  if (typeof delta === 'number') {
    if (delta > 0) {
      return `Improved by +${delta.toFixed(2)} points this iteration.`;
    }

    if (delta < 0) {
      return `Dropped by ${delta.toFixed(2)} points this iteration.`;
    }

    return 'Score held steady from the previous iteration.';
  }

  if (typeof score === 'number') {
    return `Scored ${score.toFixed(2)} on this iteration.`;
  }

  if (fallback && fallback.length > 0) {
    return fallback;
  }

  return 'Iteration update received.';
}

function formatDelta(delta: number | null): string {
  if (delta === null) {
    return 'n/a';
  }

  const prefix = delta > 0 ? '+' : '';
  return `${prefix}${delta.toFixed(2)}`;
}

function getScoreColorClass(score: number | null): string {
  if (score === null) {
    return 'text-slate-300';
  }

  if (score < 50) {
    return 'text-red-400';
  }

  if (score <= 80) {
    return 'text-yellow-400';
  }

  return 'text-green-400';
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (typeof body.error === 'string' && body.error.trim().length > 0) {
      return body.error;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function toDataUrl(base64: string | null): string | null {
  if (!base64) {
    return null;
  }

  return `data:image/png;base64,${base64}`;
}

function App(): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimersRef = useRef<number[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const processedEventIdsRef = useRef<Set<number>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const newestAnchorRef = useRef<HTMLDivElement | null>(null);
  const isAtNewestRef = useRef(true);
  const loopStatusRef = useRef<LoopStatus>('idle');

  const [files, setFiles] = useState<File[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [cloneConfig, setCloneConfig] = useState<CloneConfig>(DEFAULT_CLONE_CONFIG);
  const [cloneConfigErrors, setCloneConfigErrors] = useState<CloneConfigErrors>({});
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [isCloneRunning, setIsCloneRunning] = useState(false);

  const [loopSessionId, setLoopSessionId] = useState<string | null>(null);
  const [loopStatus, setLoopStatus] = useState<LoopStatus>('idle');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [loopErrorMessage, setLoopErrorMessage] = useState<string | null>(null);
  const [loopSummary, setLoopSummary] = useState<{ finalScore: number | null; bestIteration: number | null } | null>(
    null,
  );
  const [expandedIteration, setExpandedIteration] = useState<number | null>(null);
  const [iterationCards, setIterationCards] = useState<Record<number, IterationCard>>({});

  const previews = useMemo<PreviewItem[]>(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  const orderedIterations = useMemo(() => {
    return Object.values(iterationCards).sort((a, b) => b.iteration - a.iteration);
  }, [iterationCards]);

  useEffect(() => {
    loopStatusRef.current = loopStatus;
  }, [loopStatus]);

  useEffect(() => {
    return () => {
      for (const preview of previews) {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [previews]);

  useEffect(() => {
    return () => {
      for (const timerId of toastTimersRef.current) {
        window.clearTimeout(timerId);
      }

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const savedConfig = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!savedConfig) {
      return;
    }

    try {
      const parsed = JSON.parse(savedConfig) as unknown;
      const nextConfig = coerceStoredConfig(parsed);

      if (nextConfig) {
        setCloneConfig(nextConfig);
      }
    } catch {
      window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = newestAnchorRef.current;

    if (!container || !anchor) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry) {
          isAtNewestRef.current = entry.isIntersecting;
        }
      },
      {
        root: container,
        threshold: 1,
      },
    );

    observer.observe(anchor);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isAtNewestRef.current) {
      return;
    }

    scrollContainerRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [orderedIterations.length]);

  const addToast = useCallback((message: string) => {
    const toastId = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((previous) => [...previous, { id: toastId, message }]);

    const timerId = window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== toastId));
      toastTimersRef.current = toastTimersRef.current.filter((activeId) => activeId !== timerId);
    }, 3200);

    toastTimersRef.current.push(timerId);
  }, []);

  const closeEventStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const upsertIterationCard = useCallback((iteration: number, update: Partial<IterationCard>) => {
    setIterationCards((previous) => {
      const existing = previous[iteration];
      const fallbackScore = parseNumber(update.score) ?? existing?.score ?? null;
      const fallbackDelta = parseNumber(update.delta) ?? existing?.delta ?? null;
      const nextCard: IterationCard = {
        iteration,
        maxIterations: parseNumber(update.maxIterations) ?? existing?.maxIterations ?? null,
        state: update.state ?? existing?.state ?? 'running',
        score: fallbackScore,
        previousScore: parseNumber(update.previousScore) ?? existing?.previousScore ?? null,
        delta: fallbackDelta,
        feedbackSnippet:
          update.feedbackSnippet ??
          existing?.feedbackSnippet ??
          deriveFeedbackSnippet(fallbackScore, fallbackDelta, parseString(update.codePreview) ?? null),
        screenshotBase64: parseString(update.screenshotBase64) ?? existing?.screenshotBase64 ?? null,
        diffImageBase64: parseString(update.diffImageBase64) ?? existing?.diffImageBase64 ?? null,
        codePreview: parseString(update.codePreview) ?? existing?.codePreview ?? null,
        commitUrl: parseString(update.commitUrl) ?? existing?.commitUrl ?? null,
        elapsedMs: parseNumber(update.elapsedMs) ?? existing?.elapsedMs ?? null,
        error: parseString(update.error) ?? existing?.error ?? null,
      };

      return {
        ...previous,
        [iteration]: nextCard,
      };
    });
  }, []);

  const handleLoopEvent = useCallback(
    (eventName: LoopEventName, messageEvent: MessageEvent<string>) => {
      if (messageEvent.lastEventId) {
        const id = Number(messageEvent.lastEventId);
        if (Number.isInteger(id)) {
          if (processedEventIdsRef.current.has(id)) {
            return;
          }
          processedEventIdsRef.current.add(id);
        }
      }

      const eventData = parseEventData(messageEvent.data);
      if (!eventData) {
        return;
      }

      if (eventName === 'iteration-start') {
        const iteration = parseNumber(eventData.iteration);
        if (iteration === null) {
          return;
        }

        upsertIterationCard(iteration, {
          iteration,
          state: 'running',
          maxIterations: parseNumber(eventData.maxIterations),
          elapsedMs: parseNumber(eventData.elapsedMs),
          feedbackSnippet: `Iteration ${iteration} in progress...`,
        });
        return;
      }

      if (eventName === 'iteration-complete') {
        const iteration = parseNumber(eventData.iteration);
        if (iteration === null) {
          return;
        }

        const score = parseNumber(eventData.score);
        const delta = parseNumber(eventData.improvement);
        const codePreview = parseString(eventData.codePreview);

        upsertIterationCard(iteration, {
          iteration,
          state: 'complete',
          maxIterations: parseNumber(eventData.maxIterations),
          score,
          previousScore: parseNumber(eventData.previousScore),
          delta,
          screenshotBase64: parseString(eventData.screenshotBase64),
          diffImageBase64: parseString(eventData.diffImageBase64),
          codePreview,
          commitUrl: parseString(eventData.commitUrl),
          elapsedMs: parseNumber(eventData.elapsedMs),
          feedbackSnippet: deriveFeedbackSnippet(score, delta, codePreview),
          error: null,
        });
        return;
      }

      if (eventName === 'loop-complete') {
        setLoopStatus('complete');
        setIsCloneRunning(false);
        setConnectionStatus('disconnected');
        setLoopSummary({
          finalScore: parseNumber(eventData.finalScore),
          bestIteration: parseNumber(eventData.bestIteration),
        });
        closeEventStream();
        return;
      }

      if (eventName === 'loop-error') {
        const message = parseString(eventData.error) ?? 'Loop failed unexpectedly.';
        const iteration = parseNumber(eventData.iteration);

        if (iteration !== null) {
          upsertIterationCard(iteration, {
            iteration,
            state: 'error',
            score: parseNumber(eventData.lastScore),
            feedbackSnippet: message,
            error: message,
          });
        }

        setLoopStatus('error');
        setLoopErrorMessage(message);
        setIsCloneRunning(false);
        setConnectionStatus('disconnected');
        closeEventStream();
      }
    },
    [closeEventStream, upsertIterationCard],
  );

  const connectToLoopEvents = useCallback(
    (sessionId: string) => {
      closeEventStream();
      setConnectionStatus('connecting');

      const eventSource = new EventSource(`${API_BASE_URL}/api/loop/${sessionId}/events`);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnectionStatus('connected');
      };

      const attachHandler = (eventName: LoopEventName): ((event: Event) => void) => {
        return (event: Event) => {
          const messageEvent = event as MessageEvent<string>;
          handleLoopEvent(eventName, messageEvent);
        };
      };

      const iterationStartHandler = attachHandler('iteration-start');
      const iterationCompleteHandler = attachHandler('iteration-complete');
      const loopCompleteHandler = attachHandler('loop-complete');
      const loopErrorHandler = attachHandler('loop-error');

      eventSource.addEventListener('iteration-start', iterationStartHandler);
      eventSource.addEventListener('iteration-complete', iterationCompleteHandler);
      eventSource.addEventListener('loop-complete', loopCompleteHandler);
      eventSource.addEventListener('loop-error', loopErrorHandler);

      eventSource.onerror = () => {
        eventSource.close();
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }

        if (loopStatusRef.current !== 'running') {
          return;
        }

        setConnectionStatus('reconnecting');

        if (reconnectTimerRef.current !== null) {
          return;
        }

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (loopStatusRef.current === 'running') {
            connectToLoopEvents(sessionId);
          }
        }, SSE_RECONNECT_MS);
      };
    },
    [closeEventStream, handleLoopEvent],
  );

  const handleIncomingFiles = useCallback(
    (incomingFiles: File[]) => {
      if (incomingFiles.length === 0) {
        return;
      }

      let remainingSlots = MAX_FILES - files.length;
      if (remainingSlots <= 0) {
        addToast('Maximum reached. Remove an image before adding more.');
        return;
      }

      const acceptedFiles: File[] = [];
      let typeRejections = 0;
      let sizeRejections = 0;
      let overflowRejections = 0;

      for (const file of incomingFiles) {
        if (!ACCEPTED_FILE_TYPES.has(file.type)) {
          typeRejections += 1;
          continue;
        }

        if (file.size > MAX_FILE_SIZE_BYTES) {
          sizeRejections += 1;
          continue;
        }

        if (remainingSlots === 0) {
          overflowRejections += 1;
          continue;
        }

        acceptedFiles.push(file);
        remainingSlots -= 1;
      }

      if (typeRejections > 0) {
        addToast('Only PNG, JPG, and WEBP images are allowed.');
      }

      if (sizeRejections > 0) {
        addToast('Each file must be 10MB or less.');
      }

      if (overflowRejections > 0) {
        addToast('Only 5 screenshots can be uploaded at once.');
      }

      if (acceptedFiles.length > 0) {
        setFiles((previous) => [...previous, ...acceptedFiles]);
      }
    },
    [addToast, files.length],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (files.length < MAX_FILES) {
        setIsDragActive(true);
      }
    },
    [files.length],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragActive(false);

      if (files.length >= MAX_FILES) {
        addToast('Maximum reached. Remove an image before adding more.');
        return;
      }

      handleIncomingFiles(Array.from(event.dataTransfer.files));
    },
    [addToast, files.length, handleIncomingFiles],
  );

  const handleBrowseFiles = useCallback(() => {
    if (files.length >= MAX_FILES) {
      addToast('Maximum reached. Remove an image before adding more.');
      return;
    }

    fileInputRef.current?.click();
  }, [addToast, files.length]);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleIncomingFiles(Array.from(event.target.files ?? []));
      event.currentTarget.value = '';
    },
    [handleIncomingFiles],
  );

  const handleDropZoneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      handleBrowseFiles();
    },
    [handleBrowseFiles],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index));
  }, []);

  const validateCloneConfig = useCallback((config: CloneConfig): CloneConfigErrors => {
    const nextErrors: CloneConfigErrors = {};

    if (config.projectName.trim().length === 0) {
      nextErrors.projectName = 'Project name is required.';
    }

    const trimmedRepoUrl = config.githubRepoUrl.trim();
    if (trimmedRepoUrl.length > 0) {
      try {
        const parsedUrl = new URL(trimmedRepoUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          nextErrors.githubRepoUrl = 'GitHub repo URL must start with http:// or https://.';
        }
      } catch {
        nextErrors.githubRepoUrl = 'Enter a valid GitHub repo URL.';
      }
    }

    const maxIterations = Number(config.maxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      nextErrors.maxIterations = 'Max iterations must be an integer of at least 1.';
    }

    const targetSimilarity = Number(config.targetSimilarity);
    if (!Number.isFinite(targetSimilarity) || targetSimilarity < 50 || targetSimilarity > 100) {
      nextErrors.targetSimilarity = 'Target similarity must be between 50 and 100.';
    }

    return nextErrors;
  }, []);

  const handleConfigValueChange = useCallback(
    (field: CloneConfigField, value: string) => {
      setCloneConfig((previous) => ({ ...previous, [field]: value }));
      setCloneConfigErrors((previous) => ({ ...previous, [field]: undefined }));
    },
    [],
  );

  const startCloneLoop = useCallback(async () => {
    if (isCloneRunning) {
      return;
    }

    const nextErrors = validateCloneConfig(cloneConfig);
    const hasErrors = Object.values(nextErrors).some((error) => typeof error === 'string');

    if (hasErrors) {
      setCloneConfigErrors(nextErrors);
      return;
    }

    if (files.length === 0) {
      addToast('Upload at least one screenshot before starting.');
      return;
    }

    closeEventStream();
    processedEventIdsRef.current.clear();

    setLoopStatus('running');
    setConnectionStatus('connecting');
    setLoopErrorMessage(null);
    setLoopSummary(null);
    setIterationCards({});
    setExpandedIteration(null);
    setIsCloneRunning(true);

    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cloneConfig));
    setCloneConfigErrors({});

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('screenshots', file);
      }

      const uploadResponse = await fetch(`${API_BASE_URL}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(await parseApiError(uploadResponse, 'Upload failed.'));
      }

      const uploadResult = (await uploadResponse.json()) as UploadResponse;

      const loopRequest: LoopStartRequest = {
        sessionId: uploadResult.sessionId,
        config: {
          projectName: cloneConfig.projectName.trim(),
          maxIterations: Number(cloneConfig.maxIterations),
          targetScore: Number(cloneConfig.targetSimilarity),
          githubUrl: cloneConfig.githubRepoUrl.trim() || undefined,
          githubToken: cloneConfig.githubToken.trim() || undefined,
        },
      };

      const startResponse = await fetch(`${API_BASE_URL}/api/loop/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(loopRequest),
      });

      if (!startResponse.ok) {
        throw new Error(await parseApiError(startResponse, 'Failed to start loop.'));
      }

      const startPayload = (await startResponse.json()) as LoopStartResponse;
      setLoopSessionId(startPayload.sessionId);
      connectToLoopEvents(startPayload.sessionId);
      addToast('Clone session started.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start clone loop.';
      setLoopStatus('error');
      setConnectionStatus('disconnected');
      setLoopErrorMessage(message);
      setIsCloneRunning(false);
      addToast(message);
    }
  }, [
    addToast,
    cloneConfig,
    closeEventStream,
    connectToLoopEvents,
    files,
    isCloneRunning,
    validateCloneConfig,
  ]);

  const handleStartClone = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void startCloneLoop();
    },
    [startCloneLoop],
  );

  const canStartClone = cloneConfig.projectName.trim().length > 0 && files.length > 0 && !isCloneRunning;
  const dropZoneDisabled = files.length >= MAX_FILES;

  return (
    <main className="min-h-screen bg-surface text-slate-100">
      <div className="pointer-events-none fixed right-5 top-5 z-20 flex w-full max-w-sm flex-col gap-3">
        {toasts.map((toast) => (
          <p
            key={toast.id}
            className="rounded-lg border border-red-400/50 bg-card/95 px-4 py-2 text-sm text-red-200 shadow-lg"
          >
            {toast.message}
          </p>
        ))}
      </div>

      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
        <header className="mb-10 flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-400 to-indigo-600 text-xs font-bold text-white">
            SC
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">ScreenClone</h1>
        </header>

        <section className="mx-auto w-full max-w-2xl">
          <div
            className={`rounded-2xl border-2 border-dashed px-8 py-10 text-center transition ${
              dropZoneDisabled
                ? 'cursor-not-allowed border-slate-700 bg-card/40 opacity-70'
                : isDragActive
                  ? 'cursor-copy border-primary bg-card/80 shadow-[0_0_0_1px_rgba(99,102,241,0.6)]'
                  : 'cursor-pointer border-indigo-500/40 bg-card/50 hover:border-indigo-400/80 hover:bg-card/70'
            }`}
            onClick={dropZoneDisabled ? undefined : handleBrowseFiles}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onKeyDown={dropZoneDisabled ? undefined : handleDropZoneKeyDown}
            role="button"
            tabIndex={dropZoneDisabled ? -1 : 0}
            aria-disabled={dropZoneDisabled}
          >
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-indigo-400/60 text-xl text-indigo-300">
              +
            </div>
            <p className="text-3xl font-semibold text-slate-100">Drop screenshots here</p>
            <p className="mt-2 text-sm text-slate-400">PNG, JPG, WEBP - Max {MAX_FILES} images</p>
            <button
              type="button"
              className="mt-5 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Browse Files
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm text-slate-400">
            <p>
              {files.length}/{MAX_FILES} uploaded
            </p>
            <p>{files.length > 0 ? `${files.length} file(s) staged` : 'No files staged yet'}</p>
          </div>

          <div className="mt-6 grid grid-cols-5 gap-3">
            {Array.from({ length: MAX_FILES }, (_, slotIndex) => {
              const preview = previews[slotIndex];

              if (!preview) {
                return (
                  <div
                    key={`placeholder-${slotIndex}`}
                    className="aspect-[4/3] rounded-lg border border-dashed border-slate-700 bg-card/40"
                  />
                );
              }

              return (
                <div key={preview.url} className="relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-700">
                  <img
                    src={preview.url}
                    alt={preview.file.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                  <button
                    type="button"
                    onClick={() => removeFile(slotIndex)}
                    className="absolute right-1 top-1 rounded-full bg-black/65 px-1.5 py-0.5 text-xs font-semibold text-white transition hover:bg-black/85"
                    aria-label={`Remove ${preview.file.name}`}
                  >
                    X
                  </button>
                </div>
              );
            })}
          </div>

          <section className="mt-8 rounded-2xl border border-slate-700 bg-card/70 p-5 shadow-lg shadow-black/20">
            <h2 className="text-3xl font-semibold text-slate-100">Clone Settings</h2>
            <form className="mt-4 space-y-4" onSubmit={handleStartClone}>
              <fieldset disabled={isCloneRunning} className={isCloneRunning ? 'opacity-60' : ''}>
                <div className="space-y-4">
                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Project Name *</span>
                    <input
                      type="text"
                      value={cloneConfig.projectName}
                      onChange={(event) => handleConfigValueChange('projectName', event.target.value)}
                      placeholder="my-landing-page"
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.projectName ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.projectName}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">GitHub Repo URL</span>
                    <input
                      type="text"
                      value={cloneConfig.githubRepoUrl}
                      onChange={(event) => handleConfigValueChange('githubRepoUrl', event.target.value)}
                      placeholder="https://github.com/owner/repo"
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.githubRepoUrl ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.githubRepoUrl}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">GitHub Token</span>
                    <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                      <input
                        type={showGithubToken ? 'text' : 'password'}
                        value={cloneConfig.githubToken}
                        onChange={(event) => handleConfigValueChange('githubToken', event.target.value)}
                        placeholder="ghp_xxx..."
                        className="w-full bg-transparent text-base text-slate-100 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowGithubToken((previous) => !previous)}
                        className="rounded-md px-2 py-1 text-sm text-indigo-300 transition hover:bg-primary/20 hover:text-indigo-200"
                        aria-label={showGithubToken ? 'Hide GitHub token' : 'Show GitHub token'}
                      >
                        {showGithubToken ? '🙈' : '👁️'}
                      </button>
                    </div>
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Max Iterations</span>
                    <input
                      type="number"
                      min={1}
                      value={cloneConfig.maxIterations}
                      onChange={(event) => handleConfigValueChange('maxIterations', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.maxIterations ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.maxIterations}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Target Similarity</span>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={cloneConfig.targetSimilarity}
                      onChange={(event) => handleConfigValueChange('targetSimilarity', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.targetSimilarity ? (
                      <span className="mt-1 block text-sm text-red-400">
                        {cloneConfigErrors.targetSimilarity}
                      </span>
                    ) : null}
                  </label>
                </div>
              </fieldset>

              <button
                type="submit"
                disabled={!canStartClone}
                className="w-full rounded-lg bg-primary px-5 py-2.5 text-lg font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-600/70 disabled:text-slate-300"
              >
                🚀 Start Cloning
              </button>

              {isCloneRunning ? (
                <p className="text-center text-sm text-emerald-300">
                  Clone is running. Form is locked until the current session completes.
                </p>
              ) : null}
            </form>
          </section>
        </section>

        <section className="mx-auto mt-8 w-full max-w-4xl rounded-2xl border border-slate-700 bg-card/70 p-5 shadow-lg shadow-black/20">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-slate-100">Iteration Timeline</h2>
            <p className="text-sm text-slate-400">
              {loopSessionId ? `Session ${loopSessionId}` : 'No active session'}{' '}
              {loopStatus === 'running' ? `(${connectionStatus})` : ''}
            </p>
          </div>

          {loopStatus === 'complete' && loopSummary ? (
            <div className="success-banner relative mb-4 overflow-hidden rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-emerald-200">
              <div className="absolute inset-0 pointer-events-none">
                <span className="confetti-dot confetti-dot-a" />
                <span className="confetti-dot confetti-dot-b" />
                <span className="confetti-dot confetti-dot-c" />
                <span className="confetti-dot confetti-dot-d" />
              </div>
              <p className="relative text-sm font-semibold">
                Loop complete. Final score {loopSummary.finalScore !== null ? loopSummary.finalScore.toFixed(2) : 'n/a'}
                {loopSummary.bestIteration !== null ? `, best at iteration ${loopSummary.bestIteration}` : ''}.
              </p>
            </div>
          ) : null}

          {loopStatus === 'error' ? (
            <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-200">Loop failed: {loopErrorMessage ?? 'Unknown error'}</p>
              <button
                type="button"
                className="mt-3 rounded-md bg-red-500/30 px-3 py-1.5 text-sm font-semibold text-red-100 transition hover:bg-red-500/45 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isCloneRunning}
                onClick={() => {
                  void startCloneLoop();
                }}
              >
                Retry
              </button>
            </div>
          ) : null}

          <div
            ref={scrollContainerRef}
            className="max-h-[34rem] overflow-y-auto rounded-xl border border-slate-800 bg-surface/60 p-4"
          >
            <div ref={newestAnchorRef} />

            {orderedIterations.length === 0 ? (
              <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-slate-300">
                <span className="loading-spinner" aria-hidden="true" />
                <p className="text-sm">Waiting for first iteration update...</p>
              </div>
            ) : (
              <div className="space-y-3">
                {orderedIterations.map((card) => {
                  const isExpanded = expandedIteration === card.iteration;
                  const thumbSrc = toDataUrl(card.screenshotBase64);
                  const diffSrc = toDataUrl(card.diffImageBase64);
                  const scoreClass = getScoreColorClass(card.score);
                  const isActive = card.state === 'running' && loopStatus === 'running';

                  return (
                    <article
                      key={card.iteration}
                      className={`timeline-card-enter rounded-xl border bg-card/80 transition ${
                        isActive
                          ? 'running-card border-indigo-400/60 shadow-[0_0_0_1px_rgba(99,102,241,0.6)]'
                          : card.state === 'error'
                            ? 'border-red-500/40'
                            : 'border-slate-700'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedIteration((previous) => (previous === card.iteration ? null : card.iteration))}
                        className="flex w-full items-start gap-3 p-3 text-left"
                      >
                        <div className="mt-1 h-4 w-4 rounded-full border border-indigo-300/60 bg-indigo-400/70" />
                        <div className="w-[120px] shrink-0 overflow-hidden rounded-md border border-slate-700 bg-slate-900/70">
                          {thumbSrc ? (
                            <img src={thumbSrc} alt={`Iteration ${card.iteration} thumbnail`} className="h-[80px] w-[120px] object-cover" />
                          ) : (
                            <div className="grid h-[80px] w-[120px] place-items-center text-xs text-slate-500">No image</div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <p className="text-2xl font-bold leading-none text-slate-100">
                              #{card.iteration}
                            </p>
                            <p className="text-sm font-semibold text-slate-300">
                              {card.maxIterations !== null ? `of ${card.maxIterations}` : 'in progress'}
                            </p>
                            <p className={`text-sm font-semibold ${scoreClass}`}>
                              Score: {card.score !== null ? card.score.toFixed(2) : 'n/a'}
                            </p>
                            <p className="text-sm text-slate-300">Delta: {formatDelta(card.delta)}</p>
                          </div>
                          <p className="mt-1 truncate text-sm text-slate-300">{card.feedbackSnippet}</p>
                        </div>
                      </button>

                      {isExpanded ? (
                        <div className="space-y-4 border-t border-slate-700/80 px-4 pb-4 pt-3">
                          {thumbSrc ? (
                            <div>
                              <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Screenshot</p>
                              <img
                                src={thumbSrc}
                                alt={`Iteration ${card.iteration} full screenshot`}
                                className="w-full rounded-lg border border-slate-700 bg-slate-900 object-contain"
                              />
                            </div>
                          ) : null}

                          {thumbSrc && diffSrc ? (
                            <div>
                              <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Diff Overlay</p>
                              <div className="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
                                <img src={thumbSrc} alt="Base screenshot" className="w-full object-contain" />
                                <img
                                  src={diffSrc}
                                  alt="Diff overlay"
                                  className="absolute inset-0 h-full w-full object-contain opacity-65 mix-blend-screen"
                                />
                              </div>
                            </div>
                          ) : null}

                          {card.codePreview ? (
                            <div>
                              <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Code Preview</p>
                              <pre className="max-h-80 overflow-auto rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-xs leading-relaxed text-emerald-200">
                                <code>{card.codePreview}</code>
                              </pre>
                            </div>
                          ) : null}

                          {card.commitUrl ? (
                            <p className="text-sm">
                              <a
                                href={card.commitUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-indigo-300 underline transition hover:text-indigo-200"
                              >
                                View commit
                              </a>
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
    </main>
  );
}

export default App;
