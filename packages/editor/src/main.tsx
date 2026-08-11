import '@pitolet/ui/tokens.css';
import '@pitolet/ui/base.css';
import '@pitolet/ui/feedback.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initializeCloudDiagnostics } from './cloudDiagnostics.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useEditor } from './store/index.js';

if (import.meta.env.DEV) {
  // Console access for debugging: __pitolet.getState()
  (window as unknown as Record<string, unknown>).__pitolet = useEditor;
}

void initializeCloudDiagnostics().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary name="Pitolet">
      <App />
    </ErrorBoundary>,
  );
});
