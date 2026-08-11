import '@pitolet/ui/tokens.css';
import '@pitolet/ui/base.css';
import '@pitolet/ui/feedback.css';
import './dashboard.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ClientErrorBoundary } from './ClientErrorBoundary.js';

createRoot(document.getElementById('root')!).render(
  <ClientErrorBoundary>
    <App />
  </ClientErrorBoundary>,
);
