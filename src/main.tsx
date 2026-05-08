// Vite entry — boots the harness, which wraps <App /> with the data-injection
// control panel. To run the production dashboard standalone (no harness),
// swap <NexusTestbed /> for <App /> here.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NexusTestbed } from './harness/NexusTestbed';
import './styles/tokens.css';
import './styles/dashboard.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('main.tsx: #root element not found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <NexusTestbed />
  </StrictMode>,
);
