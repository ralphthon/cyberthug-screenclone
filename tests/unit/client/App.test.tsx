// @vitest-environment jsdom

import './setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: unknown }) => <div>{children}</div>;
  return {
    CartesianGrid: Stub,
    Line: Stub,
    LineChart: Stub,
    ReferenceDot: Stub,
    ReferenceLine: Stub,
    ResponsiveContainer: Stub,
    Tooltip: Stub,
    XAxis: Stub,
    YAxis: Stub,
  };
});

vi.mock('../../../src/client/src/components/CloneyPanel.tsx', () => ({
  default: () => <div data-testid="cloney-panel-mock" />,
}));

import App from '../../../src/client/src/App';

class MockIntersectionObserver {
  public root: Element | Document | null = null;
  public rootMargin = '';
  public thresholds: number[] = [];

  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
  public takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class MockEventSource {
  public onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  public onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  public constructor(_url: string) {}
  public addEventListener(): void {}
  public close(): void {}
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    vi.stubGlobal('EventSource', MockEventSource);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the main UI with clone controls', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'ScreenClone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Clone Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start cloning/i })).toBeDisabled();
    expect(screen.getByTestId('cloney-panel-mock')).toBeInTheDocument();
  });

  it('accepts valid images and enables start when project name is entered', () => {
    const { container } = render(<App />);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const validFile = new File(['image-bytes'], 'homepage.png', { type: 'image/png' });
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [validFile] },
    });

    expect(screen.getByText('1/5 uploaded')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: 'marketing-site' },
    });

    expect(screen.getByRole('button', { name: /start cloning/i })).toBeEnabled();
  });

  it('shows a validation toast for invalid upload types', () => {
    const { container } = render(<App />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const invalidFile = new File(['not-image'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [invalidFile] },
    });

    expect(screen.getByText('Only PNG, JPG, and WEBP images are allowed.')).toBeInTheDocument();
  });
});
