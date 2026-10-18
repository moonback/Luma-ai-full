import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App, bootstrap } from './App';
import { connectEvents } from './store';
import { DETACHED_STAGE_HASH, DetachedStage3D } from './features/Visualizer';

connectEvents();
void bootstrap();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === DETACHED_STAGE_HASH ? <DetachedStage3D /> : <App />}
  </StrictMode>,
);
