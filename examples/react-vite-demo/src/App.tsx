import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { HmrFixture } from './HmrFixture.js';

const plans = [
  {
    name: 'Starter',
    price: '$19',
    description: 'For focused product prototypes.',
    featured: false,
  },
  {
    name: 'Builder',
    price: '$49',
    description: 'For teams shipping every week.',
    featured: true,
  },
  {
    name: 'Scale',
    price: '$99',
    description: 'For multiple products and agents.',
    featured: false,
  },
];

export function App() {
  const [showDetails, setShowDetails] = useState(true);
  const [showTip, setShowTip] = useState(false);

  return (
    <div className="page-shell">
      <header className="site-header">
        <a className="brand" href="#top">
          PatchLens Demo
        </a>
        <nav aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <PrimaryButton>Start building</PrimaryButton>
      </header>

      <main id="top">
        <section className="hero">
          <p className="kicker">Point. Prompt. Patch.</p>
          <h1>Select interface. Send exact context. Ship safer changes.</h1>
          <p className="hero-copy">
            Demo fixtures exercise direct DOM elements, wrapper components, fragments, conditional
            content, repeated lists and portals.
          </p>
          <div className="hero-actions">
            <PrimaryButton>Open Studio</PrimaryButton>
            <button
              className="secondary-button"
              type="button"
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
            >
              Hover for portal
            </button>
          </div>
        </section>

        <FeatureFragment />
        <HmrFixture />

        <section className="pricing-section" id="pricing">
          <div className="section-heading">
            <div>
              <p className="kicker">Fixtures</p>
              <h2>Choose a test component</h2>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setShowDetails((visible) => !visible)}
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
          </div>

          <div className="pricing-grid">
            {plans.map((plan) => (
              <PricingCard key={plan.name} plan={plan} showDetails={showDetails} />
            ))}
          </div>
        </section>

        <section className="faq-section" id="faq">
          <p className="kicker">Conditional render</p>
          <h2>Why visual-to-code grounding first?</h2>
          {showDetails ? (
            <p>
              Agent integration becomes useful only after selection maps to source with measurable
              confidence.
            </p>
          ) : (
            <p className="muted">Details hidden for conditional fixture.</p>
          )}
        </section>
      </main>

      {showTip ? <PortalTip /> : null}
    </div>
  );
}

function PrimaryButton({ children }: { children: ReactNode }) {
  return (
    <button className="primary-button" type="button">
      {children}
    </button>
  );
}

function FeatureFragment() {
  return (
    <Fragment>
      <section className="feature-strip" id="features">
        <FeatureMetric value="Exact" label="Compiler metadata" />
        <FeatureMetric value="Local" label="Daemon boundary" />
        <FeatureMetric value="Safe" label="Transaction undo" />
      </section>
    </Fragment>
  );
}

function FeatureMetric({ value, label }: { value: string; label: string }) {
  return (
    <article>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function PricingCard({
  plan,
  showDetails,
}: {
  plan: (typeof plans)[number];
  showDetails: boolean;
}) {
  return (
    <article className={plan.featured ? 'pricing-card featured-card' : 'pricing-card'}>
      {plan.featured ? <span className="badge">Most useful</span> : null}
      <h3>{plan.name}</h3>
      <p className="price">{plan.price}</p>
      {showDetails ? <p>{plan.description}</p> : null}
      <PrimaryButton>Choose {plan.name}</PrimaryButton>
    </article>
  );
}

function PortalTip() {
  const portalRoot = document.getElementById('portal-root');
  if (!portalRoot) {
    return null;
  }

  return createPortal(
    <aside className="portal-tip">Portal content remains selectable.</aside>,
    portalRoot,
  );
}
