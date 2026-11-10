import { makeConfig } from './apps/server/src/config.js';
import { runGraphifyExtract } from './apps/server/src/graph/extract.js';

const cfg = makeConfig();
const subjectPath = 'C:\\Users\\user\\Documents\\Y2 stuff\\studi0\\data\\subjects\\st2334';

console.log('cfg.graphModel', cfg.graphModel, 'budget', cfg.graphTokenBudget, 'bin', cfg.graphifyBin);

const started = Date.now();
const result = await runGraphifyExtract({
  cfg,
  subjectPath,
  log: (line: string) => console.log(line),
  onProgress: (done: number, total: number) => console.log(`PROGRESS ${done}/${total}`),
});
console.log('RESULT', JSON.stringify(result), 'elapsed_s', Math.round((Date.now() - started) / 1000));
