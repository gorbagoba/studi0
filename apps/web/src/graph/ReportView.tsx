import type { ID } from '@studi0/shared';
import { useReport } from '../api/hooks';

export function ReportView({ subjectId, version }: { subjectId: ID; version: number }) {
  const report = useReport(subjectId, version);
  if (report.error !== null) return null; // reports are optional; omit silently on fetch trouble
  const r = report.data;
  if (r === null || (r.graphReport === null && r.verifyReport === null)) return null;
  return (
    <section aria-labelledby="reports-title" className="panel">
      <h3 id="reports-title">Reports</h3>
      {r.graphReport !== null && (
        <details>
          <summary>Graph report (GRAPH_REPORT.md)</summary>
          <pre className="report-pre">{r.graphReport}</pre>
        </details>
      )}
      {r.verifyReport !== null && (
        <details>
          <summary>Verification report (VERIFY_REPORT.md)</summary>
          <pre className="report-pre">{r.verifyReport}</pre>
        </details>
      )}
    </section>
  );
}
