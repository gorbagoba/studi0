import { useEffect, useState } from 'react';
import type { ID } from '@studi0/shared';
import { api } from '../api/client';
import { useGraphInfo } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

interface GraphPayload {
  nodes?: { entity_type?: string }[];
  links?: { relation?: string }[];
}

interface Legend {
  types: [string, number][];
  relations: [string, number][];
}

function countBy(values: ReadonlyArray<string | undefined> | undefined): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values ?? []) {
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function GraphView({ subjectId, version }: { subjectId: ID; version: number }) {
  const info = useGraphInfo(subjectId, version);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [full, setFull] = useState(false);

  // legend counts come straight from the generated graph.json via the raw passthrough
  useEffect(() => {
    if (!info.data?.hasGraph) return;
    let live = true;
    setLegend(null);
    api<GraphPayload>(`/api/subjects/${subjectId}/graph/raw/graph.json`)
      .then((g) => {
        if (!live) return;
        setLegend({
          types: countBy(g.nodes?.map((n) => n.entity_type)),
          relations: countBy(g.links?.map((l) => l.relation)),
        });

      })
      .catch(() => undefined); // the legend is chrome — a failed read just hides it
    return () => {
      live = false;
    };
  }, [subjectId, version, info.data]);

  // a rebuilt graph remounts the iframe — the loading state comes back with it
  useEffect(() => {
    setLoaded(false);
  }, [info.data?.lastBuiltAt]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

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
    <section aria-labelledby="graph-title" className={`panel graph-pane${full ? ' fullscreen' : ''}`}>
      <div className="graph-head">
        <h3 id="graph-title">Knowledge graph</h3>
        <span className="muted graph-hint">Scroll to zoom · drag to pan · click a node for details</span>
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={full}
          onClick={() => setFull((v) => !v)}
        >
          {full ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      {legend !== null && (legend.types.length > 0 || legend.relations.length > 0) && (
        <div className="graph-legend" aria-label="Graph legend">
          {legend.types.map(([name, count]) => (
            <span key={`t-${name}`} className="chip">
              {name} ×{count}
            </span>
          ))}
          {legend.relations.map(([name, count]) => (
            <span key={`r-${name}`} className="chip chip-relation">
              {name} ×{count}
            </span>
          ))}
        </div>
      )}
      <div className="graph-frame-wrap">
        {!loaded && (
          <p className="muted graph-loading" role="status">
            Loading graph…
          </p>
        )}
        <iframe
          key={g.lastBuiltAt ?? 'none'}
          title="Interactive knowledge graph"
          className="graph-frame"
          sandbox="allow-scripts"
          src={`/api/subjects/${subjectId}/graph/raw/graph.html`}
          onLoad={() => setLoaded(true)}
        />
      </div>
    </section>
  );
}
