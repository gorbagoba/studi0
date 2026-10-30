import type { Health } from '@studi0/shared';

export async function getHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json() as Promise<Health>;
}
