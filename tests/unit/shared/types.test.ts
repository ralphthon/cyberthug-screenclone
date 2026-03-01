import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CompareMode,
  CompareRequest,
  LoopEventEnvelope,
  LoopStartRequest,
  LoopStatusResponse,
} from '../../../src/shared/types';

describe('shared types', () => {
  it('supports compare and loop request shapes', () => {
    const mode: CompareMode = 'both';
    const compareRequest: CompareRequest = {
      original: 'base64-original',
      generated: 'base64-generated',
      mode,
      sessionId: 'session-123',
      iteration: 3,
    };
    const loopRequest: LoopStartRequest = {
      sessionId: 'session-123',
      config: {
        projectName: 'landing-clone',
        maxIterations: 12,
        targetScore: 90,
      },
    };

    expect(compareRequest.mode).toBe('both');
    expect(loopRequest.config.maxIterations).toBe(12);
    expectTypeOf(compareRequest.sessionId).toEqualTypeOf<string | undefined>();
    expectTypeOf(loopRequest.config.targetScore).toEqualTypeOf<number>();
  });

  it('represents analysis and loop status payload contracts', () => {
    const analyzeRequest: AnalyzeRequest = {
      sessionId: 'session-123',
      imageIndex: 0,
    };

    const analyzeResponse: AnalyzeResponse = {
      layout: {
        type: 'grid',
        direction: 'row',
        sections: ['header', 'hero'],
      },
      colorPalette: {
        primary: '#111111',
        secondary: '#222222',
        background: '#ffffff',
        text: '#000000',
        accent: '#ff5500',
      },
      components: [{ type: 'button', position: 'hero', props: ['label', 'href'] }],
      textContent: ['Welcome'],
      fonts: ['Inter'],
      responsiveHints: ['stack on mobile'],
    };

    const recentEvents: LoopEventEnvelope[] = [
      {
        id: 1,
        event: 'iteration-start',
        data: { iteration: 1 },
      },
    ];

    const status: LoopStatusResponse = {
      sessionId: 'session-123',
      config: {
        projectName: 'landing-clone',
        maxIterations: 12,
        targetScore: 90,
        githubUrl: null,
      },
      state: 'running',
      currentIteration: 1,
      maxIterations: 12,
      lastScore: 72.5,
      startedAt: '2026-03-01T00:00:00.000Z',
      elapsedMs: 1_500,
      bestScore: 72.5,
      bestIteration: 1,
      lastError: null,
      analysis: analyzeResponse,
      recentEvents,
    };

    expect(analyzeRequest.imageIndex).toBe(0);
    expect(status.recentEvents[0]?.event).toBe('iteration-start');
    expectTypeOf(status.analysis).toEqualTypeOf<AnalyzeResponse | null>();
  });
});
