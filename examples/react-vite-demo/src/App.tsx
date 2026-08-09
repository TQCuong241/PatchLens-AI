import { Hero } from "./components/Hero";
import { SignalPanel } from "./components/SignalPanel";

export function App() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Northstar home">
          Northstar<span>.</span>
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#stories">Stories</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <button className="login-button" type="button">
          Log in
        </button>
      </header>

      <main id="top">
        <Hero />
        <SignalPanel />
      </main>

      <footer className="site-footer">
        <span>Northstar planning systems</span>
        <span>Built for calm, ambitious teams.</span>
      </footer>
    </div>
  );
}
