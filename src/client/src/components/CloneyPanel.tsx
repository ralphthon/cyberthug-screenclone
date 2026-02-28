import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type OlvConnectionStatus = 'disconnected' | 'connecting' | 'connected';
type EmotionTag = 'joy' | 'sadness' | 'surprise' | 'neutral' | 'fear';
type ChatSender = 'user' | 'cloney' | 'system';
type ConnectionTestState = 'idle' | 'testing' | 'success' | 'failure';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type BridgeIntent = 'clone' | 'stop' | 'status' | 'compare' | null;

type OlvConfig = {
  serverUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  ttsVoice: string;
  personaEnabled: boolean;
  iframeUrl: string;
};

type ChatMessage = {
  id: number;
  sender: ChatSender;
  text: string;
  emotion: EmotionTag | null;
  progressBadge: string | null;
  createdAt: number;
};

type GenericPayload = Record<string, unknown>;

export type CloneyBridgeLoopEventName = 'iteration-start' | 'iteration-complete' | 'loop-complete' | 'loop-error';

export type CloneyBridgeLoopEvent = {
  id: number;
  event: CloneyBridgeLoopEventName;
  payload: Record<string, unknown>;
};

export type CloneyBridgeActionResult = {
  ok: boolean;
  message: string;
  sessionId?: string | null;
};

export type CloneyBridgeStatusSummary = {
  sessionId: string | null;
  loopStatus: string;
  currentIteration: number | null;
  maxIterations: number | null;
  lastScore: number | null;
  bestScore: number | null;
};

export type CloneyBridgeStatusResult = {
  ok: boolean;
  message: string;
  summary: CloneyBridgeStatusSummary | null;
};

export type CloneyBridgePasteResult = {
  added: number;
  rejected: number;
};

export type CloneyBridgeProps = {
  uploadedFileCount: number;
  maxFiles: number;
  screencloneSessionId: string | null;
  latestLoopEvent: CloneyBridgeLoopEvent | null;
  addPastedImages: (files: File[]) => CloneyBridgePasteResult;
  startClone: () => Promise<CloneyBridgeActionResult>;
  stopClone: () => Promise<CloneyBridgeActionResult>;
  getStatus: () => Promise<CloneyBridgeStatusResult>;
};

type CloneyPanelProps = {
  bridge: CloneyBridgeProps;
};

const OLV_CONFIG_STORAGE_KEY = 'ralphton-olv-config';
const OLV_PANEL_COLLAPSED_STORAGE_KEY = 'ralphton-olv-panel-collapsed';
const OLV_DEFAULT_WS_URL = 'ws://localhost:12393/ws';
const OLV_DEFAULT_IFRAME_URL = 'http://localhost:12393';
const OLV_RECONNECT_BASE_DELAY_MS = 1_000;
const OLV_RECONNECT_MAX_DELAY_MS = 30_000;
const OLV_CONNECTION_TEST_TIMEOUT_MS = 3_000;

const LLM_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'openai-gpt-4o', label: 'OpenAI GPT-4o' },
  { value: 'claude-4-sonnet', label: 'Claude 4 Sonnet' },
  { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { value: 'ollama-local', label: 'Ollama local' },
  { value: 'custom', label: 'Custom' },
];

const TTS_VOICE_OPTIONS = ['Sohee', 'Ara', 'Jiyoon', 'Sera', 'Custom'];

const EMOTION_EMOJI: Record<EmotionTag, string> = {
  joy: '😊',
  sadness: '😢',
  surprise: '😲',
  fear: '😨',
  neutral: '😐',
};

const EXPRESSION_INDEX: Record<EmotionTag, number> = {
  joy: 6,
  sadness: 9,
  surprise: 7,
  fear: 10,
  neutral: 11,
};

const TTS_CHARACTERISTICS: Record<EmotionTag, { pitch: number; speed: number; breathing: string }> = {
  joy: { pitch: 2, speed: 1.08, breathing: 'light' },
  sadness: { pitch: -2, speed: 0.9, breathing: 'soft' },
  surprise: { pitch: 4, speed: 1.12, breathing: 'sharp' },
  fear: { pitch: 1, speed: 0.96, breathing: 'shaky' },
  neutral: { pitch: 0, speed: 1, breathing: 'balanced' },
};

const DEFAULT_OLV_CONFIG: OlvConfig = {
  serverUrl: OLV_DEFAULT_WS_URL,
  llmModel: 'claude-4-sonnet',
  llmApiKey: '',
  llmBaseUrl: 'https://api.openai.com/v1',
  ttsVoice: 'Sohee',
  personaEnabled: true,
  iframeUrl: OLV_DEFAULT_IFRAME_URL,
};

const INITIAL_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 1,
    sender: 'cloney',
    text: 'Hi, I am Cloney. Share screenshots and tell me what to clone.',
    emotion: 'joy',
    progressBadge: null,
    createdAt: Date.now(),
  },
];

const SCREENCLONE_TOOL_PERSONA_PROMPT = [
  'You are Cloney, the ScreenClone assistant.',
  'ScreenClone tools:',
  "- 'clone|클론|copy|복사|make this|만들어' starts clone when screenshots exist.",
  "- 'stop|멈춰' stops the active clone session.",
  "- 'status|어디까지 했어' reports current iteration, score, and loop state.",
  "- 'compare|비교' explains comparison modes and latest match score.",
  'Score guide: <30 very early, 30-50 improving slowly, 50-70 strong progress, 70-90 near complete, >90 almost exact.',
  'Progress reporting style: concise Korean updates with iteration number, score, and change from previous iteration.',
].join('\n');

const CLONE_INTENT_KEYWORDS = ['clone', '클론', 'copy', '복사', 'make this', '만들어'];
const STOP_INTENT_KEYWORDS = ['stop', '멈춰'];
const STATUS_INTENT_KEYWORDS = ['status', '어디까지 했어'];
const COMPARE_INTENT_KEYWORDS = ['compare', '비교'];

function parseString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function includesKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function detectBridgeIntent(input: string): BridgeIntent {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  if (includesKeyword(normalized, CLONE_INTENT_KEYWORDS)) {
    return 'clone';
  }

  if (includesKeyword(normalized, STOP_INTENT_KEYWORDS)) {
    return 'stop';
  }

  if (includesKeyword(normalized, STATUS_INTENT_KEYWORDS)) {
    return 'status';
  }

  if (includesKeyword(normalized, COMPARE_INTENT_KEYWORDS)) {
    return 'compare';
  }

  return null;
}

function describeIterationComplete(score: number | null, previousScore: number | null): { text: string; emotion: EmotionTag } {
  if (score === null) {
    return { text: '조금씩 나아지고 있어. 기다려줘~', emotion: 'neutral' };
  }

  if (previousScore !== null && score < previousScore) {
    return { text: '어... 이전보다 나빠졌어. 다시 시도해볼게.', emotion: 'fear' };
  }

  if (score < 30) {
    return { text: '음... 아직 많이 부족해. 더 열심히 해볼게.', emotion: 'sadness' };
  }

  if (score < 50) {
    return { text: '조금씩 나아지고 있어. 기다려줘~', emotion: 'neutral' };
  }

  if (score < 70) {
    return { text: '오~ 점점 비슷해지고 있어!', emotion: 'joy' };
  }

  if (score <= 90) {
    return { text: '거의 다 왔어! 조금만 더!', emotion: 'joy' };
  }

  return { text: '와~! 거의 똑같아! 클론 완성이야! 🎉', emotion: 'surprise' };
}

function formatProgressBadge(score: number | null): string | null {
  if (score === null) {
    return null;
  }

  return `${score.toFixed(1)}%`;
}

function formatStatusSummary(summary: CloneyBridgeStatusSummary): string {
  const iterationText =
    summary.currentIteration !== null && summary.maxIterations !== null
      ? `${summary.currentIteration}/${summary.maxIterations}`
      : 'n/a';
  const scoreText = summary.lastScore !== null ? `${summary.lastScore.toFixed(1)}%` : 'n/a';
  const bestText = summary.bestScore !== null ? `${summary.bestScore.toFixed(1)}%` : 'n/a';

  return `상태: ${summary.loopStatus} | 반복: ${iterationText} | 현재 점수: ${scoreText} | 최고 점수: ${bestText}`;
}

function deriveIframeUrlFromWs(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return OLV_DEFAULT_IFRAME_URL;
  }
}

function toConfigSyncUrl(iframeUrl: string): string | null {
  try {
    const parsed = new URL(iframeUrl);
    parsed.pathname = '/api/config';
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeOlvConfig(config: OlvConfig): OlvConfig {
  const serverUrl = parseString(config.serverUrl) ?? OLV_DEFAULT_WS_URL;
  const iframeUrl = parseString(config.iframeUrl) ?? deriveIframeUrlFromWs(serverUrl);
  const llmBaseUrl = parseString(config.llmBaseUrl) ?? DEFAULT_OLV_CONFIG.llmBaseUrl;
  const llmModel = parseString(config.llmModel) ?? DEFAULT_OLV_CONFIG.llmModel;
  const ttsVoice = parseString(config.ttsVoice) ?? DEFAULT_OLV_CONFIG.ttsVoice;

  return {
    serverUrl,
    llmModel,
    llmApiKey: config.llmApiKey,
    llmBaseUrl,
    ttsVoice,
    personaEnabled: config.personaEnabled,
    iframeUrl,
  };
}

function coerceStoredOlvConfig(value: unknown): OlvConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<Record<keyof OlvConfig, unknown>>;

  const nextConfig: OlvConfig = {
    serverUrl: parseString(candidate.serverUrl) ?? OLV_DEFAULT_WS_URL,
    llmModel: parseString(candidate.llmModel) ?? DEFAULT_OLV_CONFIG.llmModel,
    llmApiKey: typeof candidate.llmApiKey === 'string' ? candidate.llmApiKey : '',
    llmBaseUrl: parseString(candidate.llmBaseUrl) ?? DEFAULT_OLV_CONFIG.llmBaseUrl,
    ttsVoice: parseString(candidate.ttsVoice) ?? DEFAULT_OLV_CONFIG.ttsVoice,
    personaEnabled: parseBoolean(candidate.personaEnabled) ?? true,
    iframeUrl: parseString(candidate.iframeUrl) ?? OLV_DEFAULT_IFRAME_URL,
  };

  return normalizeOlvConfig(nextConfig);
}

function parsePayload(raw: string): GenericPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as GenericPayload;
  } catch {
    return null;
  }
}

function extractEmotionTag(rawText: string): { emotion: EmotionTag | null; text: string } {
  const match = rawText.match(/\[(joy|sadness|surprise|neutral|fear)\]/i);
  const emotion = (match?.[1]?.toLowerCase() as EmotionTag | undefined) ?? null;
  const textWithoutTag = rawText.replace(/\[(joy|sadness|surprise|neutral|fear)\]/gi, '').trim();

  return {
    emotion,
    text: textWithoutTag.length > 0 ? textWithoutTag : rawText,
  };
}

function getConnectionIndicatorClass(status: OlvConnectionStatus): string {
  if (status === 'connected') {
    return 'bg-emerald-400';
  }

  if (status === 'connecting') {
    return 'bg-amber-400';
  }

  return 'bg-red-400';
}

function getConnectionLabel(status: OlvConnectionStatus): string {
  if (status === 'connected') {
    return 'Connected';
  }

  if (status === 'connecting') {
    return 'Connecting';
  }

  return 'Disconnected';
}

function CloneyPanel({ bridge }: CloneyPanelProps): JSX.Element {
  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const celebrationResetTimerRef = useRef<number | null>(null);
  const celebrationExpressionTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualCloseRef = useRef(false);
  const collapsedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionBridgeRef = useRef<Map<string, string>>(new Map());
  const lastHandledLoopEventIdRef = useRef<number | null>(null);
  const lastMappedSessionIdRef = useRef<string | null>(null);
  const openWaifuSessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `owf-${Date.now()}`,
  );

  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [isSettingsExpanded, setIsSettingsExpanded] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [olvConfig, setOlvConfig] = useState<OlvConfig>(DEFAULT_OLV_CONFIG);
  const [appliedConfig, setAppliedConfig] = useState<OlvConfig>(DEFAULT_OLV_CONFIG);
  const [connectionStatus, setConnectionStatus] = useState<OlvConnectionStatus>('disconnected');
  const [connectionDetail, setConnectionDetail] = useState('Disconnected');
  const [connectionTestState, setConnectionTestState] = useState<ConnectionTestState>('idle');
  const [connectionTestMessage, setConnectionTestMessage] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT_MESSAGES);
  const [chatInput, setChatInput] = useState('');
  const [currentExpression, setCurrentExpression] = useState('neutral');
  const [isCelebrating, setIsCelebrating] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [iframeReachable, setIframeReachable] = useState(true);
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const [isVoiceMuted, setIsVoiceMuted] = useState(false);

  const postMessageToIframe = useCallback((payload: GenericPayload) => {
    const contentWindow = iframeRef.current?.contentWindow;
    if (!contentWindow) {
      return;
    }

    contentWindow.postMessage(payload, '*');
  }, []);

  const broadcastExpression = useCallback(
    (expressionIndex: number) => {
      const expression = String(expressionIndex);
      setCurrentExpression(expression);
      postMessageToIframe({
        type: 'set-expression',
        expression,
        expression_index: expressionIndex,
      });

      const ws = websocketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'set-expression',
            expression,
            expression_index: expressionIndex,
          }),
        );
      }
    },
    [postMessageToIframe],
  );

  const clearCelebrationTimers = useCallback(() => {
    if (celebrationResetTimerRef.current !== null) {
      window.clearTimeout(celebrationResetTimerRef.current);
      celebrationResetTimerRef.current = null;
    }

    if (celebrationExpressionTimerRef.current !== null) {
      window.clearInterval(celebrationExpressionTimerRef.current);
      celebrationExpressionTimerRef.current = null;
    }
  }, []);

  const triggerCelebration = useCallback(() => {
    clearCelebrationTimers();
    setIsCelebrating(true);

    postMessageToIframe({
      type: 'play-motion',
      motion: 'celebrate',
    });

    const ws = websocketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'play-motion',
          motion: 'celebrate',
        }),
      );
    }

    let step = 0;
    celebrationExpressionTimerRef.current = window.setInterval(() => {
      step += 1;
      broadcastExpression(step % 2 === 0 ? 3 : 6);
      if (step >= 6 && celebrationExpressionTimerRef.current !== null) {
        window.clearInterval(celebrationExpressionTimerRef.current);
        celebrationExpressionTimerRef.current = null;
      }
    }, 420);

    celebrationResetTimerRef.current = window.setTimeout(() => {
      setIsCelebrating(false);
      if (celebrationExpressionTimerRef.current !== null) {
        window.clearInterval(celebrationExpressionTimerRef.current);
        celebrationExpressionTimerRef.current = null;
      }
    }, 3200);
  }, [broadcastExpression, clearCelebrationTimers, postMessageToIframe]);

  const sendSystemSpeech = useCallback(
    (text: string, emotion: EmotionTag | null) => {
      const ws = websocketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || isVoiceMuted) {
        return;
      }

      ws.send(
        JSON.stringify({
          type: 'text-input',
          sender: 'system',
          text,
          emotion: emotion ? `[${emotion}]` : undefined,
          voice_enabled: !isVoiceMuted,
          tts: {
            engine: 'qwen3',
            voice: appliedConfig.ttsVoice,
            max_sentences: 2,
            characteristics: TTS_CHARACTERISTICS[emotion ?? 'neutral'],
          },
        }),
      );
    },
    [appliedConfig.ttsVoice, isVoiceMuted],
  );

  const applyEmotionExpression = useCallback(
    (emotion: EmotionTag) => {
      const expressionIndex =
        emotion === 'joy' ? (Date.now() % 2 === 0 ? 3 : 6) : EXPRESSION_INDEX[emotion];
      broadcastExpression(expressionIndex);
    },
    [broadcastExpression],
  );

  const appendMessage = useCallback(
    (
      sender: ChatSender,
      text: string,
      emotion: EmotionTag | null,
      options?: { progressBadge?: string | null; voice?: boolean },
    ) => {
    const nextText = text.trim();
    if (nextText.length === 0) {
      return;
    }

    const nextMessage: ChatMessage = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      sender,
      text: nextText,
      emotion,
      progressBadge: options?.progressBadge ?? null,
      createdAt: Date.now(),
    };

    setChatMessages((previous) => [...previous, nextMessage]);

    if (sender === 'cloney' && emotion) {
      applyEmotionExpression(emotion);
    }

    if (sender === 'cloney' && options?.voice !== false) {
      sendSystemSpeech(nextText, emotion);
    }

    if (sender === 'cloney' && collapsedRef.current) {
      setUnreadCount((previous) => previous + 1);
    }
  },
    [applyEmotionExpression, sendSystemSpeech],
  );

  const handleBridgePayload = useCallback(
    (payload: GenericPayload) => {
      const messageType = parseString(payload.type);
      if (!messageType) {
        return;
      }

      if (messageType === 'display_text') {
        if (parseString(payload.sender) === 'system') {
          return;
        }

        const rawText =
          parseString(payload.text) ??
          parseString(payload.message) ??
          parseString(payload.content) ??
          parseString(payload.display_text) ??
          '';

        if (rawText.length === 0) {
          return;
        }

        const { emotion, text } = extractEmotionTag(rawText);
        appendMessage('cloney', text, emotion);
        return;
      }

      if (messageType === 'set-expression') {
        const expression = parseString(payload.expression) ?? parseString(payload.value) ?? 'neutral';
        setCurrentExpression(expression);
        postMessageToIframe({ type: 'set-expression', expression });
        return;
      }

      if (messageType === 'audio-play-start') {
        const summary = parseString(payload.text) ?? 'Audio response started.';
        appendMessage('system', summary, null);
      }
    },
    [appendMessage, postMessageToIframe],
  );

  const closeWebSocket = useCallback(() => {
    manualCloseRef.current = true;

    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (websocketRef.current) {
      websocketRef.current.close();
      websocketRef.current = null;
    }
  }, []);

  useEffect(() => {
    collapsedRef.current = isPanelCollapsed;

    if (!isPanelCollapsed) {
      setUnreadCount(0);
    }
  }, [isPanelCollapsed]);

  useEffect(() => {
    const savedConfig = window.localStorage.getItem(OLV_CONFIG_STORAGE_KEY);
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig) as unknown;
        const nextConfig = coerceStoredOlvConfig(parsed);

        if (nextConfig) {
          setOlvConfig(nextConfig);
          setAppliedConfig(nextConfig);
        }
      } catch {
        window.localStorage.removeItem(OLV_CONFIG_STORAGE_KEY);
      }
    }

    const storedCollapsed = window.localStorage.getItem(OLV_PANEL_COLLAPSED_STORAGE_KEY);
    if (storedCollapsed === 'true') {
      setIsPanelCollapsed(true);
    }

    const storedVoiceMuted = window.localStorage.getItem('ralphton-cloney-voice-muted');
    if (storedVoiceMuted === 'true') {
      setIsVoiceMuted(true);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OLV_PANEL_COLLAPSED_STORAGE_KEY, String(isPanelCollapsed));
  }, [isPanelCollapsed]);

  useEffect(() => {
    window.localStorage.setItem('ralphton-cloney-voice-muted', String(isVoiceMuted));
  }, [isVoiceMuted]);

  useEffect(() => {
    if (isPanelCollapsed) {
      return;
    }

    const chatContainer = chatScrollRef.current;
    if (!chatContainer) {
      return;
    }

    chatContainer.scrollTo({
      top: chatContainer.scrollHeight,
      behavior: 'smooth',
    });
  }, [chatMessages, isPanelCollapsed]);

  useEffect(() => {
    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        return;
      }

      handleBridgePayload(event.data as GenericPayload);
    };

    window.addEventListener('message', handleWindowMessage);
    return () => {
      window.removeEventListener('message', handleWindowMessage);
    };
  }, [handleBridgePayload]);

  useEffect(() => {
    return () => {
      clearCelebrationTimers();
    };
  }, [clearCelebrationTimers]);

  useEffect(() => {
    manualCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    setConnectionStatus('connecting');
    setConnectionDetail('Connecting...');

    const connect = (): void => {
      if (manualCloseRef.current) {
        return;
      }

      const nextUrl = parseString(appliedConfig.serverUrl);
      if (!nextUrl) {
        setConnectionStatus('disconnected');
        setConnectionDetail('Missing server URL.');
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(nextUrl);
      } catch {
        const delay = Math.min(
          OLV_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current,
          OLV_RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttemptRef.current += 1;

        setConnectionStatus('connecting');
        setConnectionDetail(`Reconnect in ${Math.ceil(delay / 1000)}s`);

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
        return;
      }

      websocketRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnectionStatus('connected');
        setConnectionDetail('Connected');

        if (appliedConfig.personaEnabled) {
          socket.send(
            JSON.stringify({
              type: 'persona_prompt',
              persona_prompt: SCREENCLONE_TOOL_PERSONA_PROMPT,
            }),
          );
        }
      };

      socket.onmessage = (event) => {
        const payload = parsePayload(event.data);
        if (!payload) {
          return;
        }

        handleBridgePayload(payload);
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onclose = () => {
        if (websocketRef.current === socket) {
          websocketRef.current = null;
        }

        if (manualCloseRef.current) {
          setConnectionStatus('disconnected');
          setConnectionDetail('Disconnected');
          return;
        }

        const delay = Math.min(
          OLV_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current,
          OLV_RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttemptRef.current += 1;

        setConnectionStatus('connecting');
        setConnectionDetail(`Reconnect in ${Math.ceil(delay / 1000)}s`);

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      closeWebSocket();
      setConnectionStatus('disconnected');
      setConnectionDetail('Disconnected');
    };
  }, [appliedConfig.personaEnabled, appliedConfig.serverUrl, closeWebSocket, handleBridgePayload]);

  const mapSessionIdToOpenWaifu = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    sessionBridgeRef.current.set(openWaifuSessionIdRef.current, sessionId);
    lastMappedSessionIdRef.current = sessionId;
  }, []);

  const resolveMappedSessionId = useCallback((): string | null => {
    return sessionBridgeRef.current.get(openWaifuSessionIdRef.current) ?? bridge.screencloneSessionId;
  }, [bridge.screencloneSessionId]);

  useEffect(() => {
    if (!bridge.screencloneSessionId || bridge.screencloneSessionId === lastMappedSessionIdRef.current) {
      return;
    }

    mapSessionIdToOpenWaifu(bridge.screencloneSessionId);
  }, [bridge.screencloneSessionId, mapSessionIdToOpenWaifu]);

  useEffect(() => {
    const loopEvent = bridge.latestLoopEvent;
    if (!loopEvent) {
      return;
    }

    if (lastHandledLoopEventIdRef.current === loopEvent.id) {
      return;
    }

    lastHandledLoopEventIdRef.current = loopEvent.id;
    const eventSessionId = parseString(loopEvent.payload.sessionId) ?? bridge.screencloneSessionId;
    mapSessionIdToOpenWaifu(eventSessionId);

    if (loopEvent.event === 'iteration-start') {
      const iteration = parseNumber(loopEvent.payload.iteration);
      const maxIterations = parseNumber(loopEvent.payload.maxIterations);
      const iterationLabel =
        iteration !== null && maxIterations !== null ? `${iteration}/${maxIterations}` : '다음 반복';
      appendMessage('cloney', `시작할게~ ${iterationLabel} 반복 진행 중이야.`, 'joy');
      return;
    }

      if (loopEvent.event === 'iteration-complete') {
        const score = parseNumber(loopEvent.payload.score);
        const previousScore = parseNumber(loopEvent.payload.previousScore);
        const { text, emotion } = describeIterationComplete(score, previousScore);
        appendMessage('cloney', text, emotion, { progressBadge: formatProgressBadge(score) });
        return;
      }

      if (loopEvent.event === 'loop-complete') {
        const finalScore = parseNumber(loopEvent.payload.finalScore);
        const bestIteration = parseNumber(loopEvent.payload.bestIteration);
        const scoreText = finalScore !== null ? `${finalScore.toFixed(1)}%` : 'n/a';
        const bestText = bestIteration !== null ? ` 최고 반복은 #${bestIteration}야.` : '';
        triggerCelebration();
        appendMessage('cloney', `와~! 거의 똑같아! 클론 완성이야! 🎉 최종 점수 ${scoreText}.${bestText}`.trim(), 'surprise', {
          progressBadge: finalScore !== null ? `${finalScore.toFixed(1)}% 완료` : null,
        });
        return;
      }

      if (loopEvent.event === 'loop-error') {
        const errorText = parseString(loopEvent.payload.error) ?? '알 수 없는 오류가 발생했어.';
        appendMessage('cloney', `문제가 생겼어. ${errorText} 다시 시도해볼까?`, 'fear');
      }
    }, [appendMessage, bridge.latestLoopEvent, bridge.screencloneSessionId, mapSessionIdToOpenWaifu, triggerCelebration]);

  const handleConfigChange = useCallback((field: keyof OlvConfig, value: string | boolean) => {
    setOlvConfig((previous) => ({
      ...previous,
      [field]: value,
    }));
  }, []);

  const handleSaveSettings = useCallback(async () => {
    const nextConfig = normalizeOlvConfig(olvConfig);

    setSaveState('saving');
    setSaveMessage('Saving settings...');

    setOlvConfig(nextConfig);
    window.localStorage.setItem(OLV_CONFIG_STORAGE_KEY, JSON.stringify(nextConfig));
    setAppliedConfig(nextConfig);

    const configUrl = toConfigSyncUrl(nextConfig.iframeUrl);
    if (!configUrl) {
      setSaveState('saved');
      setSaveMessage('Saved locally.');
      return;
    }

    try {
      const response = await fetch(configUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          openai_compatible_llm: {
            base_url: nextConfig.llmBaseUrl,
            llm_api_key: nextConfig.llmApiKey,
            model: nextConfig.llmModel,
          },
          qwen3_tts: {
            voice: nextConfig.ttsVoice,
          },
          persona_enabled: nextConfig.personaEnabled,
          persona_prompt: nextConfig.personaEnabled ? SCREENCLONE_TOOL_PERSONA_PROMPT : '',
        }),
      });

      if (!response.ok) {
        throw new Error('Config sync failed');
      }

      setSaveState('saved');
      setSaveMessage('Saved and synced with OLV server.');
    } catch {
      setSaveState('saved');
      setSaveMessage('Saved locally. OLV config sync unavailable.');
    }
  }, [olvConfig]);

  const handleTestConnection = useCallback(() => {
    const targetUrl = parseString(olvConfig.serverUrl);
    if (!targetUrl) {
      setConnectionTestState('failure');
      setConnectionTestMessage('Enter a valid WebSocket URL.');
      return;
    }

    setConnectionTestState('testing');
    setConnectionTestMessage('Testing...');

    let hasResolved = false;
    let socket: WebSocket;

    try {
      socket = new WebSocket(targetUrl);
    } catch {
      setConnectionTestState('failure');
      setConnectionTestMessage('Enter a valid WebSocket URL.');
      return;
    }

    const timeout = window.setTimeout(() => {
      if (hasResolved) {
        return;
      }

      hasResolved = true;
      setConnectionTestState('failure');
      setConnectionTestMessage('Connection test timed out.');
      socket.close();
    }, OLV_CONNECTION_TEST_TIMEOUT_MS);

    socket.onopen = () => {
      if (hasResolved) {
        return;
      }

      hasResolved = true;
      window.clearTimeout(timeout);
      setConnectionTestState('success');
      setConnectionTestMessage('Connection test passed.');
      socket.close();
    };

    socket.onerror = () => {
      if (hasResolved) {
        return;
      }

      hasResolved = true;
      window.clearTimeout(timeout);
      setConnectionTestState('failure');
      setConnectionTestMessage('Unable to reach OLV WebSocket.');
      socket.close();
    };
  }, [olvConfig.serverUrl]);

  const sendTextInput = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }

      const ws = websocketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendMessage('system', 'OLV WebSocket is not connected.', null);
        return;
      }

      ws.send(
        JSON.stringify({
          type: 'text-input',
          text: trimmed,
        }),
      );

      postMessageToIframe({ type: 'text-input', text: trimmed });
    },
    [appendMessage, postMessageToIframe],
  );

  const handleBridgeIntent = useCallback(
    async (intent: BridgeIntent): Promise<void> => {
      if (intent === 'clone') {
        if (bridge.uploadedFileCount <= 0) {
          appendMessage('cloney', '먼저 스크린샷을 올려줘야 클론을 시작할 수 있어.', 'neutral');
          return;
        }

        const result = await bridge.startClone();
        if (result.ok) {
          mapSessionIdToOpenWaifu(result.sessionId ?? bridge.screencloneSessionId);
          const mappedSessionId = resolveMappedSessionId();
          appendMessage(
            'cloney',
            mappedSessionId ? `시작할게~ 세션 ${mappedSessionId}에서 클론을 돌릴게.` : '시작할게~ 클론 루프를 실행했어.',
            'joy',
          );
        } else {
          appendMessage('cloney', result.message, 'sadness');
        }
        return;
      }

      if (intent === 'stop') {
        const result = await bridge.stopClone();
        appendMessage('cloney', result.message, result.ok ? 'neutral' : 'sadness');
        return;
      }

      if (intent === 'status') {
        const result = await bridge.getStatus();
        if (!result.ok || !result.summary) {
          appendMessage('cloney', result.message, 'neutral');
          return;
        }

        mapSessionIdToOpenWaifu(result.summary.sessionId);
        appendMessage('cloney', formatStatusSummary(result.summary), 'neutral');
        return;
      }

      if (intent === 'compare') {
        const latestScore =
          parseNumber(bridge.latestLoopEvent?.payload.score) ??
          parseNumber(bridge.latestLoopEvent?.payload.finalScore) ??
          null;
        if (latestScore !== null) {
          appendMessage(
            'cloney',
            `최근 비교 점수는 ${latestScore.toFixed(1)}%야. Slider / Diff / Side-by-Side로 차이를 확인해줘.`,
            'neutral',
          );
          return;
        }

        appendMessage('cloney', '아직 비교 점수가 없어. 먼저 클론을 시작해줘.', 'neutral');
      }
    },
    [appendMessage, bridge, mapSessionIdToOpenWaifu, resolveMappedSessionId],
  );

  const handleChatSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const trimmed = chatInput.trim();
      if (trimmed.length === 0) {
        return;
      }

      appendMessage('user', trimmed, null);
      setChatInput('');

      const intent = detectBridgeIntent(trimmed);
      if (intent) {
        void handleBridgeIntent(intent);
        return;
      }

      sendTextInput(trimmed);
    },
    [appendMessage, chatInput, handleBridgeIntent, sendTextInput],
  );

  const handleChatPaste = useCallback(
    (event: React.ClipboardEvent<HTMLInputElement>) => {
      const clipboardFiles = Array.from(event.clipboardData.files ?? []);
      const imageFiles = clipboardFiles.filter((file) => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        return;
      }

      event.preventDefault();
      const pasteResult = bridge.addPastedImages(imageFiles);

      if (pasteResult.added > 0) {
        const nextCount = Math.min(bridge.uploadedFileCount + pasteResult.added, bridge.maxFiles);
        appendMessage(
          'cloney',
          `이미지 ${pasteResult.added}개를 업로드했어. 지금 ${nextCount}/${bridge.maxFiles}장이야.`,
          'joy',
        );
      }

      if (pasteResult.rejected > 0) {
        appendMessage('system', `${pasteResult.rejected}개 이미지는 제한(형식/크기/개수) 때문에 제외됐어.`, null);
      }
    },
    [appendMessage, bridge],
  );

  const handleVoicePreview = useCallback(() => {
    sendTextInput(`Preview voice ${olvConfig.ttsVoice}`);
    appendMessage('system', `Voice preview requested: ${olvConfig.ttsVoice}`, null);
  }, [appendMessage, olvConfig.ttsVoice, sendTextInput]);

  const connectionStatusClass = useMemo(() => getConnectionIndicatorClass(connectionStatus), [connectionStatus]);
  const connectionStatusLabel = useMemo(() => getConnectionLabel(connectionStatus), [connectionStatus]);

  if (isPanelCollapsed) {
    return (
      <button
        type="button"
        onClick={() => setIsPanelCollapsed(false)}
        className="cloney-avatar-float fixed bottom-6 right-6 z-40 h-16 w-16 rounded-2xl border border-fuchsia-400/50 bg-card/95 text-2xl shadow-[0_0_24px_rgba(217,70,239,0.35)] transition hover:scale-105"
        aria-label="Expand Cloney panel"
      >
        <span aria-hidden="true">🤖</span>
        {unreadCount > 0 ? (
          <span className="cloney-unread-badge absolute -right-2 -top-2 min-w-[1.4rem] rounded-full bg-fuchsia-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <aside className="mt-8 rounded-2xl border border-slate-700 bg-card/80 shadow-lg shadow-black/30 lg:fixed lg:bottom-4 lg:right-4 lg:top-4 lg:z-30 lg:mt-0 lg:w-[min(30vw,420px)] lg:min-w-[320px] lg:overflow-hidden">
      <div className="flex h-full flex-col">
        <header
          className={`border-b border-slate-700/80 px-4 py-3 transition ${
            isCelebrating ? 'bg-emerald-500/10' : ''
          }`}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <span className={`h-2.5 w-2.5 rounded-full ${connectionStatusClass}`} aria-hidden="true" />
              OLV {connectionStatusLabel}
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-fuchsia-400/40 bg-fuchsia-500/10 px-2 py-0.5 text-[11px] font-semibold text-fuchsia-200">
                {currentExpression}
              </span>
              <button
                type="button"
                onClick={() => setIsPanelCollapsed(true)}
                className="rounded-md border border-slate-600 bg-surface/70 px-2 py-1 text-xs text-slate-300 transition hover:border-indigo-400/60 hover:text-indigo-200"
              >
                Collapse
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSettingsExpanded((previous) => !previous)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-surface/70 px-3 py-2 text-left"
          >
            <span className="text-sm font-semibold text-slate-100">OLV Settings</span>
            <span className="text-xs text-slate-400">{isSettingsExpanded ? 'Hide' : 'Show'}</span>
          </button>

          {isSettingsExpanded ? (
            <div className="mt-3 space-y-3">
              <label className="block text-xs text-slate-300">
                Server URL
                <input
                  type="text"
                  value={olvConfig.serverUrl}
                  onChange={(event) => handleConfigChange('serverUrl', event.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-surface/90 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400"
                  placeholder="ws://localhost:12393/ws"
                />
              </label>

              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-xs text-slate-300">
                  LLM Model
                  <select
                    value={olvConfig.llmModel}
                    onChange={(event) => handleConfigChange('llmModel', event.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-surface/90 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400"
                  >
                    {LLM_MODEL_OPTIONS.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs text-slate-300">
                  TTS Voice
                  <select
                    value={olvConfig.ttsVoice}
                    onChange={(event) => handleConfigChange('ttsVoice', event.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-surface/90 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400"
                  >
                    {TTS_VOICE_OPTIONS.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-xs text-slate-300">
                LLM API Key
                <div className="mt-1 flex items-center gap-2 rounded-md border border-slate-700 bg-surface/90 px-2.5 py-1.5">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={olvConfig.llmApiKey}
                    onChange={(event) => handleConfigChange('llmApiKey', event.target.value)}
                    className="w-full bg-transparent text-sm text-slate-100 outline-none"
                    placeholder="sk-..."
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((previous) => !previous)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-indigo-200 transition hover:bg-indigo-500/20"
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              <label className="block text-xs text-slate-300">
                LLM Base URL
                <input
                  type="text"
                  value={olvConfig.llmBaseUrl}
                  onChange={(event) => handleConfigChange('llmBaseUrl', event.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-surface/90 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400"
                  placeholder="https://api.openai.com/v1"
                />
              </label>

              <label className="flex items-center justify-between rounded-md border border-slate-700 bg-surface/70 px-2.5 py-2 text-xs text-slate-200">
                Persona prompt enabled
                <input
                  type="checkbox"
                  checked={olvConfig.personaEnabled}
                  onChange={(event) => handleConfigChange('personaEnabled', event.target.checked)}
                  className="h-4 w-4 accent-indigo-500"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={connectionTestState === 'testing'}
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-60"
                >
                  {connectionTestState === 'testing' ? 'Testing...' : 'Test Connection'}
                </button>
              <button
                type="button"
                onClick={handleVoicePreview}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
              >
                Preview Voice
              </button>
              <button
                type="button"
                onClick={() => setIsVoiceMuted((previous) => !previous)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                  isVoiceMuted
                    ? 'border border-slate-500/60 bg-slate-600/25 text-slate-100 hover:bg-slate-600/35'
                    : 'border border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-100 hover:bg-fuchsia-500/25'
                }`}
              >
                {isVoiceMuted ? 'Unmute Voice' : 'Mute Voice'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSaveSettings();
                }}
                  disabled={saveState === 'saving'}
                  className="rounded-md border border-indigo-500/50 bg-indigo-500/20 px-2.5 py-1.5 text-xs font-semibold text-indigo-100 transition hover:bg-indigo-500/30 disabled:opacity-60"
                >
                  {saveState === 'saving' ? 'Saving...' : 'Save Settings'}
                </button>
              </div>

              <div className="space-y-1 text-[11px] text-slate-400">
                <p>{connectionDetail}</p>
                {connectionTestMessage ? (
                  <p
                    className={
                      connectionTestState === 'success'
                        ? 'text-emerald-300'
                        : connectionTestState === 'failure'
                          ? 'text-red-300'
                          : 'text-slate-400'
                    }
                  >
                    {connectionTestMessage}
                  </p>
                ) : null}
                {saveMessage ? (
                  <p className={saveState === 'error' ? 'text-red-300' : 'text-indigo-200'}>{saveMessage}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </header>

        <section className="border-b border-slate-700/70 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Live2D Canvas</h3>
          <div
            className={`relative h-48 overflow-hidden rounded-lg border bg-surface/80 transition ${
              isCelebrating ? 'border-emerald-400/70 shadow-[0_0_18px_rgba(52,211,153,0.35)]' : 'border-slate-700'
            }`}
          >
            {iframeReachable ? (
              <iframe
                key={iframeReloadKey}
                ref={iframeRef}
                src={appliedConfig.iframeUrl}
                title="OpenWaifu Live2D"
                className="h-full w-full border-0"
                onLoad={() => {
                  setIframeReachable(true);
                  postMessageToIframe({ type: 'set-expression', expression: currentExpression });
                }}
                onError={() => setIframeReachable(false)}
              />
            ) : (
              <div className="grid h-full place-items-center px-4 text-center text-sm text-slate-300">
                <div>
                  <p className="font-semibold text-slate-200">OLV server not connected</p>
                  <p className="mt-1 text-xs text-slate-400">Unable to load Live2D iframe.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setIframeReachable(true);
                      setIframeReloadKey((previous) => previous + 1);
                    }}
                    className="mt-3 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/20"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0 flex-1 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Chat History</h3>
          <div ref={chatScrollRef} className="h-full max-h-[240px] overflow-y-auto rounded-lg border border-slate-700 bg-surface/60 p-3">
            <div className="space-y-2">
              {chatMessages.map((message) => {
                const isUser = message.sender === 'user';
                const isSystem = message.sender === 'system';

                return (
                  <article
                    key={message.id}
                    className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
                      isUser
                        ? 'ml-auto bg-indigo-500/85 text-white'
                        : isSystem
                          ? 'mx-auto bg-slate-700/70 text-slate-200'
                          : 'mr-auto bg-card text-slate-100'
                    }`}
                  >
                    {message.sender === 'cloney' && message.emotion ? (
                      <p className="mb-1 text-[11px] text-slate-300">
                        {EMOTION_EMOJI[message.emotion]} {message.emotion}
                      </p>
                    ) : null}
                    {message.sender === 'cloney' && message.progressBadge ? (
                      <p className="mb-1 inline-flex rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5 text-[11px] font-semibold text-indigo-200">
                        {message.progressBadge}
                      </p>
                    ) : null}
                    <p className="leading-relaxed">{message.text}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-slate-700/80 px-4 py-3">
          <form onSubmit={handleChatSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onPaste={handleChatPaste}
              placeholder="Message Cloney..."
              className="w-full rounded-md border border-slate-700 bg-surface/90 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-indigo-400"
            />
            <button
              type="submit"
              className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
            >
              Send
            </button>
          </form>
        </section>
      </div>
    </aside>
  );
}

export default CloneyPanel;
