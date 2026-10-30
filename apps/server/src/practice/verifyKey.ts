import { extractJson } from '../pipeline/parse.js';
import { keyVerificationPrompt } from '../graph/prompts.js';
import * as questionsRepo from '../db/repos/questions.js';
import type { Db } from '../db/index.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { QuestionRow } from '../db/repos/questions.js';
import type { OneshotFn } from '../util/oneshot.js';
import type { Question, QuestionKey } from '@studi0/shared';

export interface VerifyResult {
  keyStatus: 'verified' | 'failed';
  reason?: string;
}

/** Second-pass key verification; gates reveal (AC19), not grading. */
export async function verifyQuestionKey(
  oneshot: OneshotFn,
  db: Db,
  subject: SubjectRow,
  row: QuestionRow,
): Promise<VerifyResult> {
  const payload = JSON.parse(row.payload_json) as Question['payload'];
  const key = JSON.parse(row.key_json) as QuestionKey;
  let result: VerifyResult;
  try {
    const raw = await oneshot(
      subject.path,
      keyVerificationPrompt({ topic: row.topic, type: row.type, payload, key }),
    );
    const parsed = extractJson(raw) as { ok?: unknown; reason?: unknown } | null;
    if (parsed && typeof parsed.ok === 'boolean') {
      result = {
        keyStatus: parsed.ok ? 'verified' : 'failed',
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
    } else {
      result = { keyStatus: 'failed', reason: 'verification output malformed' };
    }
  } catch (e) {
    // fail closed — a key we cannot re-verify must not stay revealed-able
    result = { keyStatus: 'failed', reason: (e as Error).message };
  }
  questionsRepo.setKeyStatus(db, row.id, result.keyStatus);
  return result;
}
