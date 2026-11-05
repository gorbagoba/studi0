import { HttpError } from '../util/errors.js';
import type { Config } from '../config.js';

/** One accumulated OpenAI tool call (fragments merged by `index`). */
export interface ToolCallAccum {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * One SSE yield. `content` is an incremental text delta; `toolCalls` (present
 * whenever that chunk carried tool-call fragments) is the FULL accumulated
 * tool-call state so far — receivers replace, never merge.
 * `reasoning` fields are deliberately not represented: never surfaced.
 */
export interface StreamDelta {
  content?: string;
  toolCalls?: ToolCallAccum[];
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface ChatBody {
  model: string;
  messages: LlmMessage[];
  tools?: unknown[];
}

function url(cfg: Config): string {
  return `${cfg.chatBaseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function headers(cfg: Config): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${cfg.chatApiKey ?? ''}` };
}

/** Non-2xx → typed error; message carries status + short body, never the key. */
async function httpError(res: Response): Promise<HttpError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // body unreadable — status alone
  }
  return new HttpError('INTERNAL', `chat gateway error ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** POST /chat/completions; returns the full response JSON (includes `reasoning` — callers must not surface it). */
export async function chatCompletion(cfg: Config, body: ChatBody, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url(cfg), {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  return res.json();
}

interface ChunkShape {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

/**
 * POST /chat/completions with stream:true; yields content deltas live and the
 * running tool-call accumulation (fragments merged by index, OpenAI protocol).
 * Malformed data lines are skipped; [DONE] ends the stream.
 */
export async function* streamCompletion(
  cfg: Config,
  body: ChatBody,
  signal: AbortSignal,
): AsyncGenerator<StreamDelta> {
  const res = await fetch(url(cfg), {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new HttpError('INTERNAL', 'chat gateway returned no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCallAccum>();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let chunk: ChunkShape;
        try {
          chunk = JSON.parse(data) as ChunkShape;
        } catch {
          continue; // truncated/malformed line — skip, the next lines still parse
        }
        const delta = chunk.choices?.[0]?.delta;
        const out: StreamDelta = {};
        if (typeof delta?.content === 'string' && delta.content) out.content = delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const i = typeof tc.index === 'number' ? tc.index : 0;
          const acc = calls.get(i) ?? { index: i, id: `call_${i}`, name: '', arguments: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments;
          calls.set(i, acc);
          out.toolCalls = [...calls.values()];
        }
        if (out.content || out.toolCalls) yield out;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
