import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type OlvConnectionStatus = 'disconnected' | 'connecting' | 'connected';
type EmotionTag = 'joy' | 'sadness' | 'surprise' | 'neutral';
type ChatSender = 'user' | 'cloney' | 'system';
type ConnectionTestState = 'idle' | 'testing' | 'success' | 'failure';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

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
  createdAt: number;
};

type GenericPayload = Record<string, unknown>;

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
  neutral: '😐',
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
    createdAt: Date.now(),
  },
];

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
  const match = rawText.match(/\[(joy|sadness|surprise|neutral)\]/i);
  const emotion = (match?.[1]?.toLowerCase() as EmotionTag | undefined) ?? null;
  const textWithoutTag = rawText.replace(/\[(joy|sadness|surprise|neutral)\]/gi, '').trim();

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

function CloneyPanel(): JSX.Element {
  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualCloseRef = useRef(false);
  const collapsedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

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
  const [unreadCount, setUnreadCount] = useState(0);
  const [iframeReachable, setIframeReachable] = useState(true);
  const [iframeReloadKey, setIframeReloadKey] = useState(0);

  const appendMessage = useCallback((sender: ChatSender, text: string, emotion: EmotionTag | null) => {
    const nextText = text.trim();
    if (nextText.length === 0) {
      return;
    }

    const nextMessage: ChatMessage = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      sender,
      text: nextText,
      emotion,
      createdAt: Date.now(),
    };

    setChatMessages((previous) => [...previous, nextMessage]);

    if (sender === 'cloney' && collapsedRef.current) {
      setUnreadCount((previous) => previous + 1);
    }
  }, []);

  const postMessageToIframe = useCallback((payload: GenericPayload) => {
    const contentWindow = iframeRef.current?.contentWindow;
    if (!contentWindow) {
      return;
    }

    contentWindow.postMessage(payload, '*');
  }, []);

  const handleBridgePayload = useCallback(
    (payload: GenericPayload) => {
      const messageType = parseString(payload.type);
      if (!messageType) {
        return;
      }

      if (messageType === 'display_text') {
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
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OLV_PANEL_COLLAPSED_STORAGE_KEY, String(isPanelCollapsed));
  }, [isPanelCollapsed]);

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
  }, [appliedConfig.serverUrl, closeWebSocket, handleBridgePayload]);

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

  const handleChatSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const trimmed = chatInput.trim();
      if (trimmed.length === 0) {
        return;
      }

      appendMessage('user', trimmed, null);
      sendTextInput(trimmed);
      setChatInput('');
    },
    [appendMessage, chatInput, sendTextInput],
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
        <header className="border-b border-slate-700/80 px-4 py-3">
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
          <div className="relative h-48 overflow-hidden rounded-lg border border-slate-700 bg-surface/80">
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
