// SPDX-License-Identifier: Apache-2.0
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ThemeProvider } from './theme.tsx';
import { ToastProvider } from './Toasts.tsx';
import { TokenGate } from './TokenGate.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('root mount missing');
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <TokenGate>
          <App />
        </TokenGate>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
