import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { StatusProvider } from './status/StatusProvider.js';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <StatusProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StatusProvider>
    </ThemeProvider>
  </StrictMode>,
);
