import { OpenCode } from '@opencode/client';
import type { Config } from '../config.js';

export type OcClient = ReturnType<typeof OpenCode.make>;

export function authHeaders(password: string): Record<string, string> {
  const basic = Buffer.from(`opencode:${password}`).toString('base64');
  return { authorization: `Basic ${basic}` };
}

export function makeOcClient(cfg: Config, password: string): OcClient {
  return OpenCode.make({
    baseUrl: `http://${cfg.ocHost}:${cfg.ocPort}`,
    headers: authHeaders(password),
  });
}
