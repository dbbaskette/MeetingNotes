import React from 'react';
import { createRoot } from 'react-dom/client';
import { buildErrorReport } from './lib/error-report';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');
const root = container;

async function bootstrap(): Promise<void> {
  // Browser preview only: without the Electron preload there is no window.api.
  // The stub must be installed before ./App is evaluated, because ipc/client
  // reads window.api at import time. Vite drops this branch from builds.
  if (import.meta.env.DEV && !window.api) {
    const { installPreviewApi } = await import('./dev/preview-api');
    installPreviewApi();
  }
  const [{ App }, { reportRendererError }] = await Promise.all([import('./App'), import('./components/ErrorBoundary')]);

  // Errors outside React's render path (event handlers, timers, rejected
  // promises) bypass error boundaries; record them in the app log (#251).
  window.addEventListener('error', (event) => {
    reportRendererError(buildErrorReport('window', 'window', event.error ?? event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError(buildErrorReport('promise', 'window', event.reason));
  });

  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
