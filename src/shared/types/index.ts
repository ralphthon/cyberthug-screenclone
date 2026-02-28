export interface HealthResponse {
  status: 'ok';
  version: string;
}

export interface AnalyzeRequest {
  sessionId: string;
  imageIndex?: number;
}

export interface AnalyzeResponse {
  layout: {
    type: string;
    direction: string;
    sections: string[];
  };
  colorPalette: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    accent: string;
  };
  components: Array<{
    type: string;
    position: string;
    props: string[];
  }>;
  textContent: string[];
  fonts: string[];
  responsiveHints: string[];
}

export interface RenderRequest {
  html: string;
  width?: number;
  height?: number;
  waitMs?: number;
}

export interface RenderResponse {
  screenshot: string;
  width: number;
  height: number;
  renderTimeMs: number;
}

export type CompareMode = 'vision' | 'pixel' | 'both';

export interface CompareRequest {
  original: string;
  generated: string;
  mode?: CompareMode;
  sessionId?: string;
  iteration?: number;
}

export interface VisionCompareResult {
  score: number;
  layout_match: boolean;
  color_match: boolean;
  component_match: boolean;
  text_match: boolean;
  responsive_match: boolean;
  differences: string[];
  suggestions: string[];
  verdict: 'pass' | 'close' | 'fail';
  reasoning: string;
}

export interface PixelCompareResult {
  pixelScore: number;
  diffImage: string;
  mismatchedPixels: number;
  totalPixels: number;
}

export interface CompareResponse {
  vision?: VisionCompareResult;
  pixel?: PixelCompareResult;
  primaryScore: number;
}

export interface LoopStartConfig {
  projectName: string;
  maxIterations: number;
  targetScore: number;
  githubUrl?: string;
  githubToken?: string;
}

export interface LoopStartRequest {
  sessionId: string;
  config: LoopStartConfig;
}

export interface LoopStartResponse {
  sessionId: string;
  state: string;
  currentIteration: number;
  maxIterations: number;
  targetScore: number;
  startedAt: string | null;
}

export type LoopEventName = 'iteration-start' | 'iteration-complete' | 'loop-complete' | 'loop-error';

export interface LoopEventEnvelope {
  id: number;
  event: LoopEventName;
  data: Record<string, unknown>;
}

export interface LoopStatusResponse {
  sessionId: string;
  config: {
    projectName: string;
    maxIterations: number;
    targetScore: number;
    githubUrl: string | null;
  };
  state: string;
  currentIteration: number;
  maxIterations: number;
  lastScore: number | null;
  startedAt: string | null;
  elapsedMs: number;
  bestScore: number | null;
  bestIteration: number;
  lastError: string | null;
  analysis: AnalyzeResponse | null;
  recentEvents: LoopEventEnvelope[];
}
