import path from 'node:path';

const MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim, ONNX q8 quantized
const EMBED_BATCH = 32;

/** minimal shape of the feature-extraction pipeline we use (typed loosely — lib ships thin .d.ts) */
type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipePromise: Promise<Extractor> | null = null;
let loadError: Error | null = null;

// repo-local model cache: models must not land in random global caches
const modelsDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', '.models');

async function getPipeline(): Promise<Extractor> {
  if (loadError) throw loadError;
  if (!pipePromise) {
    // lazy: importing this module (and every test/startup path) must not load ONNX
    pipePromise = (async () => {
      const tf = await import('@huggingface/transformers');
      return (await tf.pipeline('feature-extraction', MODEL, {
        dtype: 'q8',
        cache_dir: modelsDir,
      })) as unknown as Extractor;
    })();
    pipePromise.catch(() => undefined); // consumed below; never an unhandled rejection
  }
  try {
    return await pipePromise;
  } catch (e) {
    // memoize the failure: a broken install must not re-attempt (and re-log) per call
    loadError = e instanceof Error ? e : new Error(String(e));
    pipePromise = null;
    throw loadError;
  }
}

/**
 * Embed texts with MiniLM: mean pooling + L2 normalize (cosine = dot product).
 * Batched at EMBED_BATCH; throws when the model cannot load — callers fall back.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await pipe(batch, { pooling: 'mean', normalize: true });
    const dim = res.dims[res.dims.length - 1] ?? 384;
    for (let r = 0; r < batch.length; r++) {
      out.push(new Float32Array(res.data.subarray(r * dim, (r + 1) * dim)));
    }
  }
  return out;
}
