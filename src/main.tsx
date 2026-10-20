import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './shell-premium.css';
import './brand-vds.css';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal-state">
          <h1>Une interruption est survenue</h1>
          <p>Vos dossiers sont conservés. Rechargez l’espace pour reprendre votre navigation.</p>
          <button className="button button-primary" onClick={() => location.reload()}>
            Rouvrir l’espace VDS
          </button>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
