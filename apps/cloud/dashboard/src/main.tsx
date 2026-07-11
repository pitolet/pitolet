import '@pitolet/ui/tokens.css';
import '@pitolet/ui/base.css';
import './dashboard.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<App />);
