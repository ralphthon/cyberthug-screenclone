import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Preserve crash details for debugging while rendering fallback UI for users.
    console.error('ScreenClone UI crashed', error, errorInfo);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="grid min-h-screen place-items-center bg-surface px-6 text-slate-100">
          <section className="w-full max-w-lg rounded-2xl border border-slate-700 bg-card/80 p-8 text-center shadow-lg shadow-black/20">
            <p className="text-sm uppercase tracking-wide text-slate-400">Error Boundary</p>
            <h1 className="mt-2 text-2xl font-bold">Something went wrong.</h1>
            <p className="mt-3 text-sm text-slate-300">
              The app hit an unexpected error. Refresh to recover this session.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Reload App
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
