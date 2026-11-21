import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SplashScreen } from './components/SplashScreen';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/pages.css';

// The transparent splash window is told apart by a flag injected from Rust
// before the page loads; the hash keeps the same screen reachable in a browser.
const splash =
  (window as unknown as { __TRINITY_SPLASH__?: boolean }).__TRINITY_SPLASH__ === true ||
  window.location.hash === '#splash';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{splash ? <SplashScreen /> : <App />}</StrictMode>,
);
