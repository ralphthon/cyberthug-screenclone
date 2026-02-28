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
