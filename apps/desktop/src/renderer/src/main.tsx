import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// In the browser build we draw a little desktop scene around the widget. In
// Electron the widget is the entire window.
if (!window.talkie) document.documentElement.classList.add('is-web');
document.documentElement.dataset.platform = window.talkie?.platform ?? 'web';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
