// @vitest-environment jsdom

import './setup';
import React from 'react';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloneyPanel, { type CloneyBridgeProps } from '../../../src/client/src/components/CloneyPanel';

class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState = MockWebSocket.OPEN;
  public onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  public onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  public onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  public onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  public send = vi.fn();

  public constructor(_url: string) {
    window.setTimeout(() => {
      this.onopen?.call(this as unknown as WebSocket, new Event('open'));
    }, 0);
  }

  public close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close'));
  }
}

const buildBridge = (overrides: Partial<CloneyBridgeProps> = {}): CloneyBridgeProps => {
  return {
    uploadedFileCount: 1,
    maxFiles: 5,
    screencloneSessionId: null,
    latestLoopEvent: null,
    addPastedImages: vi.fn(() => ({ added: 1, rejected: 0 })),
    startClone: vi.fn(async () => ({ ok: true, message: 'started', sessionId: 'sess-1' })),
    stopClone: vi.fn(async () => ({ ok: true, message: 'stopped', sessionId: 'sess-1' })),
    getStatus: vi.fn(async () => ({
      ok: true,
      message: 'status',
      summary: {
        sessionId: 'sess-1',
        loopStatus: 'running',
        currentIteration: 2,
        maxIterations: 10,
        lastScore: 75.5,
        bestScore: 82.4,
      },
    })),
    ...overrides,
  };
};

describe('CloneyPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();

    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders and supports collapse / expand interaction', async () => {
    render(<CloneyPanel bridge={buildBridge()} />);

    expect(screen.getByText('OLV Settings')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByRole('button', { name: 'Expand Cloney panel' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Cloney panel' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    });
  });

  it('invokes bridge startClone when user sends clone intent', async () => {
    const bridge = buildBridge();
    render(<CloneyPanel bridge={bridge} />);

    const input = screen.getByPlaceholderText('Message Cloney...');
    fireEvent.change(input, { target: { value: 'clone this page' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(bridge.startClone).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/세션 sess-1/)).toBeInTheDocument();
  });

  it('handles image paste via bridge.addPastedImages', () => {
    const bridge = buildBridge();
    render(<CloneyPanel bridge={bridge} />);

    const input = screen.getByPlaceholderText('Message Cloney...');
    const file = new File(['image-bytes'], 'captured.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(input);
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file] },
    });

    fireEvent(input, pasteEvent);

    expect(bridge.addPastedImages).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/이미지 1개를 업로드했어/)).toBeInTheDocument();
  });
});
