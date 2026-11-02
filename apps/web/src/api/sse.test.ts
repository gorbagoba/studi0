import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSseFrame, postChatStream, stripStepMarkers } from './sse';

describe('parseSseFrame', () => {
  it('parses event name and JSON data', () => {
    expect(parseSseFrame('event: token\ndata: {"text":"hi"}')).toEqual({
      event: 'token',
      data: '{"text":"hi"}',
    });
  });

  it('ignores heartbeat comments and empty frames', () => {
    expect(parseSseFrame(': ping')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });

  it('handles CRLF line endings and frames without an explicit event', () => {
    expect(parseSseFrame('data: {"a":1}\r\n')).toEqual({ event: 'message', data: '{"a":1}' });
  });
});

describe('stripStepMarkers (QA #8: markers never reach the chat DOM)', () => {
  it('removes complete markers and the space after them', () => {
    expect(stripStepMarkers('§3§ hello §12§world')).toBe('hello world');
    expect(stripStepMarkers('plain text stays')).toBe('plain text stays');
  });

  it('filters markers from streamed token frames end to end', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'event: token\ndata: {"text":"§1§ Heaps "}\n\n',
      'event: token\ndata: {"text":"are fun §2§\\n"}\n\n',
      'event: done\ndata: {"messageCount":2}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const f of frames) controller.enqueue(encoder.encode(f));
                controller.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const tokens: string[] = [];
    let done = false;
    await postChatStream('ses1', { content: 'hi' }, { onToken: (t) => tokens.push(t), onDone: () => (done = true) });
    // '§2§' plus one trailing whitespace char are consumed, like the server-side strip
    expect(tokens.join('')).toBe('Heaps are fun ');
    expect(done).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
