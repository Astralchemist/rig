import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { TokenGate } from './TokenGate.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('root mount missing');
createRoot(root).render(
  <StrictMode>
    <TokenGate>
      <App />
    </TokenGate>
  </StrictMode>,
);
