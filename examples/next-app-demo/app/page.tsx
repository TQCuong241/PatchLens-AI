import { Counter } from './ui/Counter';

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">PatchLens Next.js spike</p>
        <h1>Server-rendered shell, client interaction.</h1>
        <p>
          Select this Server Component or the interactive counter to inspect its source boundary.
        </p>
        <Counter />
      </section>
    </main>
  );
}
