const signals = [
  { value: "3.4×", label: "faster planning cycles" },
  { value: "92%", label: "work stays connected" },
  { value: "18h", label: "saved every sprint" },
];

export function SignalPanel() {
  return (
    <section className="signal-panel" aria-labelledby="signal-title">
      <div className="signal-heading">
        <p>Clarity compounds</p>
        <h2 id="signal-title">One view from intent to impact.</h2>
      </div>

      <div className="signal-grid">
        {signals.map((signal) => (
          <article className="signal-card" key={signal.label}>
            <strong>{signal.value}</strong>
            <span>{signal.label}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
