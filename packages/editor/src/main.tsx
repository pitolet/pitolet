import '@pitolet/ui/tokens.css';
import '@pitolet/ui/base.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { useEditor } from './store/index.js';

if (import.meta.env.DEV) {
  // Console access for debugging: __pitolet.getState()
  (window as unknown as Record<string, unknown>).__pitolet = useEditor;
}

createRoot(document.getElementById('root')!).render(<App />);
