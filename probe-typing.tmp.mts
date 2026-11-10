import { makeConfig } from './apps/server/src/config.js';
import { typeGraphFile, graphAsk } from './apps/server/src/graph/typing.js';

const cfg = makeConfig();
const subjectPath = 'C:\\Users\\user\\Documents\\Y2 stuff\\studi0\\data\\subjects\\st2334';

const started = Date.now();
const outcome = await typeGraphFile(subjectPath, graphAsk(cfg), (m) => console.log(m));
console.log('TYPED', JSON.stringify(outcome), 'elapsed_s', Math.round((Date.now() - started) / 1000));
