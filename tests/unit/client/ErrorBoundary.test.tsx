// @vitest-environment jsdom

import './setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from '../../../src/client/src/components/ErrorBoundary';

function CrashComponent(): JSX.Element {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('catches render errors and shows fallback UI', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <CrashComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Error Boundary')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Something went wrong.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload App' })).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
