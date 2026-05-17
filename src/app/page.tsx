import { ImportPanel } from "@/components/import-panel";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="app-header">
        <div>
          <h1>NBrain</h1>
          <p>Notion-backed repo memory with claims, evidence, and review tasks.</p>
        </div>
        <div className="status-pill">Prototype</div>
      </header>
      <ImportPanel />
    </main>
  );
}
