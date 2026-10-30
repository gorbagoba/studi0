import type { Stats } from '@studi0/shared';

export function StatsCards({ stats }: { stats: Stats | null }) {
  if (stats === null) return null;
  return (
    <section aria-labelledby="stats-title" className="panel">
      <h3 id="stats-title">Progress</h3>
      <dl className="cards">
        <div className="card">
          <dt>Due today</dt>
          <dd>{stats.dueCount}</dd>
        </div>
        <div className="card">
          <dt>Streak</dt>
          <dd>{stats.streakDays}</dd>
        </div>
        <div className="card">
          <dt>Questions</dt>
          <dd>{stats.totalQuestions}</dd>
        </div>
      </dl>
      {stats.perTopic.length > 0 && (
        <table className="file-table">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Attempts</th>
              <th scope="col">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {stats.perTopic.map((t) => (
              <tr key={t.topic}>
                <td>{t.topic}</td>
                <td>{t.attempts}</td>
                <td>{Math.round(t.accuracy * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
