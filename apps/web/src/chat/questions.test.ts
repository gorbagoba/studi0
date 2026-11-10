import { describe, expect, it } from 'vitest';
import { extractQuestions } from './questions';

const block = (json: string): string => '```studi0-questions\n' + json + '\n```';

describe('extractQuestions', () => {
  it('strips a valid block and returns its questions', () => {
    const text = 'Before you start:\n\n' + block('{"questions":[{"id":"pace","prompt":"How long?","options":["<1 week"]}]}');
    const { visibleText, questions } = extractQuestions(text);
    expect(questions?.questions).toEqual([{ id: 'pace', prompt: 'How long?', options: ['<1 week'] }]);
    expect(visibleText).toBe('Before you start:');
  });

  it('leaves the text untouched when the JSON is invalid', () => {
    const text = 'Hello\n' + block('{not json}');
    expect(extractQuestions(text)).toEqual({ visibleText: text, questions: null });
  });

  it('takes only the first block', () => {
    const first = block('{"questions":[{"id":"first","prompt":"One?"}]}');
    const second = block('{"questions":[{"id":"second","prompt":"Two?"}]}');
    const { visibleText, questions } = extractQuestions(`A\n${first}\nB\n${second}`);
    expect(questions?.questions.map((q) => q.id)).toEqual(['first']);
    expect(visibleText).not.toContain('"first"');
    expect(visibleText).toContain('B');
  });

  it('returns the text unchanged when there is no block', () => {
    expect(extractQuestions('Just a reply.')).toEqual({ visibleText: 'Just a reply.', questions: null });
  });
});
