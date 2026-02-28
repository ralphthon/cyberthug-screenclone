import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

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

type ComparisonMode = 'side-by-side' | 'slider' | 'diff';

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

type ScoreChartPoint = {
  iteration: number;
  score: number;
  scoreLow: number | null;
  scoreMid: number | null;
  scoreHigh: number | null;
  improvement: number | null;
  elapsedMs: number | null;
};

type SharedPanPoint = {
  x: number;
  y: number;
};

type UploadResponse = {
  sessionId: string;
};

type ApiErrorResponse = {
  error?: string;
};

type DownloadArchiveHeadResponse = {
  filename: string | null;
  bytes: number | null;
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

function formatElapsedMs(elapsedMs: number | null): string {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 'n/a';
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 KB';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}

function parseFilenameFromContentDisposition(disposition: string | null): string | null {
  if (!disposition) {
    return null;
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim() || null;
    } catch {
      // Fall through to quoted filename parsing.
    }
  }

  const quotedMatch = disposition.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    const value = quotedMatch[1].trim();
    return value.length > 0 ? value : null;
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWheelDelta(event: React.WheelEvent<HTMLDivElement>): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 15;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * 40;
  }

  return event.deltaY;
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
  const comparisonViewportRef = useRef<HTMLDivElement | null>(null);
  const sliderCanvasRef = useRef<HTMLDivElement | null>(null);
  const activeSliderPointerIdRef = useRef<number | null>(null);
  const isPanningRef = useRef(false);
  const panAnchorRef = useRef<{ pointerX: number; pointerY: number; panX: number; panY: number } | null>(null);

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
  const [downloadEstimateBytes, setDownloadEstimateBytes] = useState<number | null>(null);
  const [downloadArchiveName, setDownloadArchiveName] = useState<string | null>(null);
  const [isDownloadEstimateLoading, setIsDownloadEstimateLoading] = useState(false);
  const [isDownloadingArchive, setIsDownloadingArchive] = useState(false);
  const [expandedIteration, setExpandedIteration] = useState<number | null>(null);
  const [iterationCards, setIterationCards] = useState<Record<number, IterationCard>>({});
  const [selectedComparisonIteration, setSelectedComparisonIteration] = useState<number | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('side-by-side');
  const [sliderPosition, setSliderPosition] = useState(50);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState<SharedPanPoint>({ x: 0, y: 0 });
  const [isScoreChartExpanded, setIsScoreChartExpanded] = useState(false);

  const previews = useMemo<PreviewItem[]>(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  const orderedIterations = useMemo(() => {
    return Object.values(iterationCards).sort((a, b) => b.iteration - a.iteration);
  }, [iterationCards]);

  const currentComparisonIteration = useMemo(() => {
    if (selectedComparisonIteration !== null && iterationCards[selectedComparisonIteration]) {
      return iterationCards[selectedComparisonIteration];
    }

    return orderedIterations[0] ?? null;
  }, [iterationCards, orderedIterations, selectedComparisonIteration]);

  const currentComparisonScore = currentComparisonIteration?.score ?? null;
  const currentComparisonImage = toDataUrl(currentComparisonIteration?.screenshotBase64 ?? null);
  const selectedDiffImage = toDataUrl(currentComparisonIteration?.diffImageBase64 ?? null);
  const referencePreview = previews[0]?.url ?? null;
  const targetScore = useMemo(() => {
    const parsed = Number(cloneConfig.targetSimilarity);
    if (!Number.isFinite(parsed)) {
      return 90;
    }
    return clamp(parsed, 0, 100);
  }, [cloneConfig.targetSimilarity]);

  const fallbackArchiveBytesEstimate = useMemo(() => {
    const uploadedBytes = files.reduce((total, file) => total + file.size, 0);
    const iterationImageBytes = Object.values(iterationCards).reduce((total, card) => {
      const screenshotBytes = card.screenshotBase64 ? Math.floor((card.screenshotBase64.length * 3) / 4) : 0;
      const diffBytes = card.diffImageBase64 ? Math.floor((card.diffImageBase64.length * 3) / 4) : 0;
      return total + screenshotBytes + diffBytes;
    }, 0);
    const codeBytes = Object.values(iterationCards).reduce((total, card) => total + (card.codePreview?.length ?? 0), 0);

    const estimated = uploadedBytes + Math.floor(iterationImageBytes * 0.35) + codeBytes + 80 * 1024;
    return Math.max(estimated, 120 * 1024);
  }, [files, iterationCards]);

  const scoreChartData = useMemo<ScoreChartPoint[]>(() => {
    return [...Object.values(iterationCards)]
      .sort((a, b) => a.iteration - b.iteration)
      .filter((card): card is IterationCard & { score: number } => card.score !== null && Number.isFinite(card.score))
      .map((card) => {
        const score = clamp(card.score, 0, 100);
        const improvement =
          card.delta ??
          (card.previousScore !== null && Number.isFinite(card.previousScore) ? score - card.previousScore : null);

        return {
          iteration: card.iteration,
          score,
          scoreLow: score < 50 ? score : null,
          scoreMid: score >= 50 && score <= 80 ? score : null,
          scoreHigh: score > 80 ? score : null,
          improvement,
          elapsedMs: card.elapsedMs,
        };
      });
  }, [iterationCards]);

  const bestScorePoint = useMemo<ScoreChartPoint | null>(() => {
    if (scoreChartData.length === 0) {
      return null;
    }

    return scoreChartData.reduce((best, point) => {
      if (point.score > best.score) {
        return point;
      }

      if (point.score === best.score && point.iteration > best.iteration) {
        return point;
      }

      return best;
    }, scoreChartData[0]);
  }, [scoreChartData]);

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

  useEffect(() => {
    if (orderedIterations.length === 0) {
      if (selectedComparisonIteration !== null) {
        setSelectedComparisonIteration(null);
      }
      return;
    }

    if (selectedComparisonIteration === null || !iterationCards[selectedComparisonIteration]) {
      setSelectedComparisonIteration(orderedIterations[0]?.iteration ?? null);
    }
  }, [iterationCards, orderedIterations, selectedComparisonIteration]);

  useEffect(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  }, [currentComparisonIteration?.iteration, comparisonMode]);

  useEffect(() => {
    if (loopStatus !== 'complete' || !loopSessionId) {
      setIsDownloadEstimateLoading(false);
      return;
    }

    let isCancelled = false;
    const controller = new AbortController();
    setIsDownloadEstimateLoading(true);

    const requestEstimate = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/loop/${loopSessionId}/download`, {
          method: 'HEAD',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await parseApiError(response, 'Unable to estimate ZIP size.'));
        }

        const headerPayload: DownloadArchiveHeadResponse = {
          filename:
            parseString(response.headers.get('x-archive-name')) ??
            parseFilenameFromContentDisposition(response.headers.get('content-disposition')),
          bytes: parseNumber(response.headers.get('x-archive-bytes')) ?? parseNumber(response.headers.get('content-length')),
        };

        if (!isCancelled) {
          setDownloadArchiveName(headerPayload.filename);
          setDownloadEstimateBytes(
            headerPayload.bytes !== null && Number.isFinite(headerPayload.bytes) && headerPayload.bytes > 0
              ? Math.round(headerPayload.bytes)
              : null,
          );
        }
      } catch (error) {
        if (isCancelled) {
          return;
        }

        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setDownloadEstimateBytes(null);
      } finally {
        if (!isCancelled) {
          setIsDownloadEstimateLoading(false);
        }
      }
    };

    void requestEstimate();

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [loopSessionId, loopStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (orderedIterations.length === 0) {
        return;
      }

      const hasInputFocus =
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.tagName === 'INPUT' ||
          document.activeElement.tagName === 'TEXTAREA' ||
          document.activeElement.tagName === 'SELECT');

      if (hasInputFocus) {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        setComparisonMode((previous) => (previous === 'diff' ? 'side-by-side' : 'diff'));
        return;
      }

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      event.preventDefault();

      setSelectedComparisonIteration((previous) => {
        if (orderedIterations.length === 0) {
          return null;
        }

        const sortedAscending = [...orderedIterations].sort((a, b) => a.iteration - b.iteration);
        const currentIteration = previous ?? sortedAscending[sortedAscending.length - 1]?.iteration ?? null;
        if (currentIteration === null) {
          return null;
        }

        const currentIndex = sortedAscending.findIndex((card) => card.iteration === currentIteration);
        if (currentIndex === -1) {
          return sortedAscending[sortedAscending.length - 1]?.iteration ?? null;
        }

        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const targetIndex = clamp(currentIndex + direction, 0, sortedAscending.length - 1);
        return sortedAscending[targetIndex]?.iteration ?? currentIteration;
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [orderedIterations]);

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
    setDownloadEstimateBytes(null);
    setDownloadArchiveName(null);
    setIsDownloadEstimateLoading(false);
    setIsDownloadingArchive(false);
    setIterationCards({});
    setExpandedIteration(null);
    setSelectedComparisonIteration(null);
    setComparisonMode('slider');
    setSliderPosition(50);
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
    setIsScoreChartExpanded(false);
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

  const handleDownloadArchive = useCallback(async () => {
    if (!loopSessionId || loopStatus !== 'complete' || isDownloadingArchive) {
      return;
    }

    setIsDownloadingArchive(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/loop/${loopSessionId}/download`);
      if (!response.ok) {
        throw new Error(await parseApiError(response, 'Failed to download ZIP archive.'));
      }

      const archiveName =
        parseFilenameFromContentDisposition(response.headers.get('content-disposition')) ??
        parseString(response.headers.get('x-archive-name')) ??
        downloadArchiveName ??
        `ralphton-${Date.now()}.zip`;

      const blob = await response.blob();
      if (blob.size > 0) {
        setDownloadEstimateBytes(blob.size);
      }

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = archiveName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      addToast('ZIP archive download started.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download ZIP archive.';
      addToast(message);
    } finally {
      setIsDownloadingArchive(false);
    }
  }, [addToast, downloadArchiveName, isDownloadingArchive, loopSessionId, loopStatus]);

  const handleStartClone = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void startCloneLoop();
    },
    [startCloneLoop],
  );

  const canStartClone = cloneConfig.projectName.trim().length > 0 && files.length > 0 && !isCloneRunning;
  const dropZoneDisabled = files.length >= MAX_FILES;

  const handleComparisonWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!comparisonViewportRef.current) {
        return;
      }

      event.preventDefault();

      const viewport = comparisonViewportRef.current;
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const wheelDelta = normalizeWheelDelta(event);
      const scaleFactor = wheelDelta < 0 ? 1.1 : 0.9;

      setZoomScale((previousScale) => {
        const nextScale = clamp(previousScale * scaleFactor, 1, 4);
        if (nextScale === previousScale) {
          return previousScale;
        }

        setPanOffset((previousPan) => {
          const relativeX = (pointerX - previousPan.x) / previousScale;
          const relativeY = (pointerY - previousPan.y) / previousScale;
          return {
            x: pointerX - relativeX * nextScale,
            y: pointerY - relativeY * nextScale,
          };
        });

        return nextScale;
      });
    },
    [comparisonViewportRef],
  );

  const updateSliderPositionFromPointer = useCallback((clientX: number) => {
    const sliderCanvas = sliderCanvasRef.current;
    if (!sliderCanvas) {
      return;
    }

    const sliderRect = sliderCanvas.getBoundingClientRect();
    if (sliderRect.width <= 0) {
      return;
    }

    const relativePercent = ((clientX - sliderRect.left) / sliderRect.width) * 100;
    setSliderPosition(clamp(relativePercent, 0, 100));
  }, []);

  const handleSliderCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (zoomScale > 1) {
        return;
      }

      activeSliderPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateSliderPositionFromPointer(event.clientX);
    },
    [updateSliderPositionFromPointer, zoomScale],
  );

  const handleSliderCanvasPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (activeSliderPointerIdRef.current !== event.pointerId) {
        return;
      }

      updateSliderPositionFromPointer(event.clientX);
    },
    [updateSliderPositionFromPointer],
  );

  const handleSliderCanvasPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activeSliderPointerIdRef.current !== event.pointerId) {
      return;
    }

    activeSliderPointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (zoomScale <= 1) {
        return;
      }

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      isPanningRef.current = true;
      panAnchorRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        panX: panOffset.x,
        panY: panOffset.y,
      };
    },
    [panOffset.x, panOffset.y, zoomScale],
  );

  const continuePan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current || !panAnchorRef.current) {
      return;
    }

    const offsetX = event.clientX - panAnchorRef.current.pointerX;
    const offsetY = event.clientY - panAnchorRef.current.pointerY;

    setPanOffset({
      x: panAnchorRef.current.panX + offsetX,
      y: panAnchorRef.current.panY + offsetY,
    });
  }, []);

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    isPanningRef.current = false;
    panAnchorRef.current = null;
  }, []);

  const comparisonTransform = `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`;
  const similarityPercent = currentComparisonScore !== null ? clamp(currentComparisonScore, 0, 100) : 0;
  const sliderClip = `inset(0 ${100 - sliderPosition}% 0 0)`;
  const resolvedArchiveEstimate = downloadEstimateBytes ?? fallbackArchiveBytesEstimate;
  const downloadEstimatePrefix = downloadEstimateBytes === null ? '~' : '';
  const downloadButtonLabel = isDownloadingArchive
    ? 'Preparing ZIP...'
    : `📦 Download ZIP (${downloadEstimatePrefix}${formatFileSize(resolvedArchiveEstimate)})`;

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
        <header className="mb-10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-400 to-indigo-600 text-xs font-bold text-white">
              SC
            </span>
            <h1 className="text-3xl font-bold tracking-tight text-slate-100">ScreenClone</h1>
          </div>

          {loopStatus === 'complete' && loopSessionId ? (
            <button
              type="button"
              onClick={() => {
                void handleDownloadArchive();
              }}
              disabled={isDownloadingArchive}
              title={downloadArchiveName ?? undefined}
              className="rounded-lg border border-indigo-400/60 bg-indigo-500/20 px-4 py-2 text-sm font-semibold text-indigo-100 transition hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloadButtonLabel}
              {isDownloadEstimateLoading && downloadEstimateBytes === null ? ' ...' : ''}
            </button>
          ) : null}
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

        <section className="mx-auto mt-8 grid w-full max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="rounded-2xl border border-slate-700 bg-card/70 p-5 shadow-lg shadow-black/20">
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
          </div>

          <aside className="rounded-2xl border border-slate-700 bg-card/70 p-4 shadow-lg shadow-black/20">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-slate-100">Score Progress</h3>
              <button
                type="button"
                onClick={() => setIsScoreChartExpanded((previous) => !previous)}
                className="rounded-md border border-indigo-400/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/20"
              >
                {isScoreChartExpanded ? 'Collapse' : 'Expand'}
              </button>
            </div>

            {scoreChartData.length === 0 ? (
              <div className="grid h-[200px] place-items-center rounded-xl border border-dashed border-slate-700 bg-surface/50 px-4 text-center text-sm text-slate-400">
                No data yet. Complete an iteration to plot score progression.
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsScoreChartExpanded((previous) => !previous)}
                className="w-full rounded-xl border border-slate-700 bg-surface/60 p-2 text-left"
                aria-label={isScoreChartExpanded ? 'Collapse score chart' : 'Expand score chart'}
              >
                <div className={`${isScoreChartExpanded ? 'h-[400px]' : 'h-[200px]'} w-full`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={scoreChartData} margin={{ top: 18, right: 16, left: -10, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(100,116,139,0.22)" vertical={false} />
                      <XAxis
                        dataKey="iteration"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        allowDecimals={false}
                        tickLine={false}
                        axisLine={{ stroke: 'rgba(148,163,184,0.35)' }}
                        tick={{ fill: '#94a3b8', fontSize: 11 }}
                      />
                      <YAxis
                        type="number"
                        domain={[0, 100]}
                        ticks={[0, 20, 40, 60, 80, 100]}
                        tickLine={false}
                        axisLine={{ stroke: 'rgba(148,163,184,0.35)' }}
                        tick={{ fill: '#94a3b8', fontSize: 11 }}
                        tickFormatter={(value: number) => `${value}%`}
                        width={34}
                      />
                      <Tooltip
                        cursor={{ stroke: 'rgba(129,140,248,0.35)', strokeWidth: 1 }}
                        content={({ active, payload }) => {
                          if (!active || !payload || payload.length === 0) {
                            return null;
                          }

                          const rawPoint = payload[0]?.payload as ScoreChartPoint | undefined;
                          if (!rawPoint) {
                            return null;
                          }

                          return (
                            <div className="rounded-lg border border-slate-700 bg-surface/95 px-3 py-2 text-xs text-slate-200 shadow-xl">
                              <p className="font-semibold text-slate-100">Iteration #{rawPoint.iteration}</p>
                              <p className={getScoreColorClass(rawPoint.score)}>Score: {rawPoint.score.toFixed(2)}%</p>
                              <p className="text-slate-300">Improvement: {formatDelta(rawPoint.improvement)}</p>
                              <p className="text-slate-300">Elapsed: {formatElapsedMs(rawPoint.elapsedMs)}</p>
                            </div>
                          );
                        }}
                      />
                      <ReferenceLine
                        y={targetScore}
                        stroke="#f59e0b"
                        strokeDasharray="6 4"
                        ifOverflow="extendDomain"
                        label={{
                          value: `Target ${targetScore.toFixed(0)}%`,
                          position: 'insideTopRight',
                          fill: '#fbbf24',
                          fontSize: 11,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="scoreLow"
                        stroke="#f87171"
                        strokeWidth={2.5}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive
                        animationDuration={300}
                      />
                      <Line
                        type="monotone"
                        dataKey="scoreMid"
                        stroke="#facc15"
                        strokeWidth={2.5}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive
                        animationDuration={300}
                      />
                      <Line
                        type="monotone"
                        dataKey="scoreHigh"
                        stroke="#34d399"
                        strokeWidth={2.5}
                        dot={false}
                        connectNulls={false}
                        activeDot={{ r: 4, fill: '#34d399', stroke: '#052e16', strokeWidth: 1 }}
                        isAnimationActive
                        animationDuration={300}
                      />
                      {bestScorePoint ? (
                        <ReferenceDot
                          x={bestScorePoint.iteration}
                          y={bestScorePoint.score}
                          r={6}
                          fill="#22c55e"
                          stroke="#ecfdf5"
                          strokeWidth={1.5}
                          ifOverflow="extendDomain"
                          label={{
                            value: `Best ${bestScorePoint.score.toFixed(1)}%`,
                            position: 'top',
                            fill: '#86efac',
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        />
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </button>
            )}
          </aside>
        </section>

        <section className="mx-auto mt-8 w-full max-w-6xl rounded-2xl border border-slate-700 bg-card/70 p-5 shadow-lg shadow-black/20">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-slate-100">
              Compare: Iteration #{currentComparisonIteration?.iteration ?? 'n/a'}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setComparisonMode('slider')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  comparisonMode === 'slider'
                    ? 'bg-primary text-white'
                    : 'bg-surface/70 text-slate-300 hover:bg-surface hover:text-slate-100'
                }`}
              >
                Slider
              </button>
              <button
                type="button"
                onClick={() => setComparisonMode('diff')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  comparisonMode === 'diff'
                    ? 'bg-primary text-white'
                    : 'bg-surface/70 text-slate-300 hover:bg-surface hover:text-slate-100'
                }`}
              >
                Diff Overlay
              </button>
              <button
                type="button"
                onClick={() => setComparisonMode('side-by-side')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  comparisonMode === 'side-by-side'
                    ? 'bg-primary text-white'
                    : 'bg-surface/70 text-slate-300 hover:bg-surface hover:text-slate-100'
                }`}
              >
                Side-by-Side
              </button>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-300">
            <label htmlFor="compare-iteration" className="font-medium text-slate-200">
              Iteration
            </label>
            <select
              id="compare-iteration"
              value={currentComparisonIteration?.iteration ?? ''}
              onChange={(event) => setSelectedComparisonIteration(Number(event.target.value))}
              className="rounded-md border border-slate-700 bg-surface/80 px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              disabled={orderedIterations.length === 0}
            >
              {orderedIterations.map((card) => (
                <option key={card.iteration} value={card.iteration}>
                  Iteration #{card.iteration}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-400">Keyboard: ←/→ switch iteration, Space toggles mode</p>
          </div>

          {currentComparisonIteration && currentComparisonImage && referencePreview ? (
            <>
              <div
                ref={comparisonViewportRef}
                className={`relative overflow-hidden rounded-xl border border-slate-700 bg-surface/70 ${
                  zoomScale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
                }`}
                onWheel={handleComparisonWheel}
                onPointerDown={beginPan}
                onPointerMove={continuePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
              >
                {comparisonMode === 'side-by-side' ? (
                  <div className="grid gap-3 p-3 md:grid-cols-2">
                    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70">
                      <p className="border-b border-slate-700 px-3 py-2 text-sm font-medium text-slate-300">Original</p>
                      <div className="comparison-canvas relative h-[18rem] overflow-hidden">
                        <img
                          src={referencePreview}
                          alt="Original screenshot"
                          className="comparison-image"
                          style={{ transform: comparisonTransform }}
                          draggable={false}
                        />
                      </div>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70">
                      <p className="border-b border-slate-700 px-3 py-2 text-sm font-medium text-slate-300">
                        Generated - {currentComparisonScore !== null ? `${currentComparisonScore.toFixed(1)}% match` : 'n/a'}
                      </p>
                      <div className="comparison-canvas relative h-[18rem] overflow-hidden">
                        <img
                          src={currentComparisonImage}
                          alt={`Generated clone iteration ${currentComparisonIteration.iteration}`}
                          className="comparison-image"
                          style={{ transform: comparisonTransform }}
                          draggable={false}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {comparisonMode === 'slider' ? (
                  <div className="relative p-3">
                    <div
                      ref={sliderCanvasRef}
                      className="comparison-canvas relative h-[22rem] overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70"
                      onPointerDown={handleSliderCanvasPointerDown}
                      onPointerMove={handleSliderCanvasPointerMove}
                      onPointerUp={handleSliderCanvasPointerUp}
                      onPointerCancel={handleSliderCanvasPointerUp}
                    >
                      <img
                        src={referencePreview}
                        alt="Original screenshot"
                        className="comparison-image"
                        style={{ transform: comparisonTransform }}
                        draggable={false}
                      />
                      <img
                        src={currentComparisonImage}
                        alt={`Generated clone iteration ${currentComparisonIteration.iteration}`}
                        className="comparison-image absolute inset-0"
                        style={{ transform: comparisonTransform, clipPath: sliderClip }}
                        draggable={false}
                      />
                      <div
                        className="pointer-events-none absolute inset-y-0 z-10 w-px bg-indigo-300/90"
                        style={{ left: `${sliderPosition}%` }}
                      >
                        <span className="absolute left-1/2 top-1/2 block h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-indigo-300/80 bg-indigo-500/25 shadow-[0_0_14px_rgba(99,102,241,0.5)]" />
                      </div>
                      <div
                        className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-surface/90 px-2 py-1 text-xs font-semibold text-slate-100"
                        style={{ transform: `translateX(${(sliderPosition - 50) * 1.2}px)` }}
                      >
                        {sliderPosition.toFixed(0)}%
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-sm text-slate-300">
                      <span>Reveal</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={sliderPosition}
                        onChange={(event) => setSliderPosition(Number(event.target.value))}
                        className="h-1 w-full accent-indigo-400"
                      />
                      <span>{sliderPosition.toFixed(0)}%</span>
                    </div>
                  </div>
                ) : null}

                {comparisonMode === 'diff' ? (
                  <div className="p-3">
                    <div className="comparison-canvas relative h-[22rem] overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70">
                      <img
                        src={referencePreview}
                        alt="Original screenshot"
                        className="comparison-image"
                        style={{ transform: comparisonTransform }}
                        draggable={false}
                      />
                      {selectedDiffImage ? (
                        <img
                          src={selectedDiffImage}
                          alt={`Diff overlay iteration ${currentComparisonIteration.iteration}`}
                          className="comparison-image absolute inset-0 opacity-70 mix-blend-screen"
                          style={{ transform: comparisonTransform }}
                          draggable={false}
                        />
                      ) : (
                        <div className="absolute inset-0 grid place-items-center text-sm text-slate-400">
                          No diff image available for this iteration.
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
                  <span>Similarity</span>
                  <span className={getScoreColorClass(currentComparisonScore)}>
                    {currentComparisonScore !== null ? `${currentComparisonScore.toFixed(1)}%` : 'n/a'}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-red-500 via-yellow-400 to-emerald-400 transition-all"
                    style={{ width: `${similarityPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <span>Zoom: {zoomScale.toFixed(2)}x</span>
                  <span>Mouse wheel to zoom, drag to pan when zoomed</span>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700 bg-surface/50 px-4 py-10 text-center text-sm text-slate-400">
              Start cloning and complete an iteration to unlock comparison modes.
            </div>
          )}
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
