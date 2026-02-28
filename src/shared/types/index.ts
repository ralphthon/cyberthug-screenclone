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
