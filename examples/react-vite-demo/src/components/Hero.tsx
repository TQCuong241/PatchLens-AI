export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <div className="eyebrow">
          <span className="eyebrow-dot" />
          Planning for growing teams
        </div>

        <h1 id="hero-title">
          Build what matters,
          <em> together.</em>
        </h1>

        <p className="hero-description">
          A calmer workspace for turning ambitious plans into work your whole
          team can understand, trust, and move forward.
        </p>

        <div className="hero-actions">
          <button className="primary-action" type="button">
            Start planning
            <span aria-hidden="true">↗</span>
          </button>
          <button className="secondary-action" type="button">
            Watch the story
          </button>
        </div>

        <div className="proof-line">
          <div className="avatar-stack" aria-hidden="true">
            <span>AM</span>
            <span>RS</span>
            <span>JL</span>
          </div>
          <p>Trusted by 280+ product teams</p>
        </div>
      </div>

      <div className="hero-visual" aria-label="Northstar workspace preview">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="sun-core">
          <span>Q3</span>
          <strong>Momentum</strong>
        </div>
        <div className="floating-note note-top">
          <span className="note-icon">✓</span>
          12 teammates aligned
        </div>
        <div className="floating-note note-bottom">
          <span className="note-pulse" />
          Launch confidence 92%
        </div>
      </div>
    </section>
  );
}
