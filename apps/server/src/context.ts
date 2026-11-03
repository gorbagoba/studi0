import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { EventBus } from './http/sse.js';
import type { JobQueue } from './pipeline/queue.js';
import type { OpencodeManager } from './teacher/opencode.js';
import type { OneshotFn } from './util/oneshot.js';
import type { RunPipelineFn } from './pipeline/runner.js';
import type { FeedQuestionsFn } from './teacher/practiceFeed.js';

/**
 * Wires one app instance together. `oneshot`, `runPipeline` (via the queue) and
 * `feedQuestions` are ctx properties — tests swap them for stubs.
 */
export interface Ctx {
  cfg: Config;
  db: Db;
  events: EventBus;
  queue: JobQueue;
  oc: OpencodeManager;
  oneshot: OneshotFn;
  /** headless teacher runs (--agent studi0-teacher) — course setup lesson generation */
  teacherRun: OneshotFn;
  runPipeline: RunPipelineFn;
  feedQuestions: FeedQuestionsFn;
}
