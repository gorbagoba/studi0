import { describe, expect, it } from 'vitest';
import { parseSseFrame } from './sse';

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
