import type { ID } from '@studi0/shared';
import { useGraphInfo } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

export function GraphView({ subjectId, version }: { subjectId: ID; version: number }) {
  const info = useGraphInfo(subjectId, version);
  if (info.loading) return <p className="muted">Loading graph…</p>;
  if (info.error !== null) return <ErrorBanner message={info.error} />;
  const g = info.data;
  if (g === null) return null;
  if (!g.hasGraph) {
    return (
      <EmptyState
        title="No graph yet"
        hint="Build the graph from your material to explore it here."
      />
    );
  }
  return (
    <section aria-labelledby="graph-title" className="panel">
      <h3 id="graph-title">Knowledge graph</h3>
      <iframe
        key={g.lastBuiltAt ?? 'none'}
        title="Interactive knowledge graph"
        className="graph-frame"
        sandbox="allow-scripts"
        src={`/api/subjects/${subjectId}/graph/raw/graph.html`}
      />
    </section>
  );
}
