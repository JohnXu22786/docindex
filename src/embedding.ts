/**
 * Embedding provider slot.
 *
 * The bundle ships two providers:
 *
 *   - `ngram` (default, zero dependencies): a deterministic feature-hashing
 *     embedder over CJK n-grams + latin words. It gives a real vector space
 *     where texts sharing tokens are close, works fully offline, and needs no
 *     model download. It is a lexical-semantic baseline — for neural
 *     embeddings install `@huggingface/transformers` and switch the provider.
 *   - `transformers` (optional): a lightweight neural encoder loaded on demand
 *     through `@huggingface/transformers` (ONNX). Enable with
 *     `npm i @huggingface/transformers` and `embedding.provider = "transformers"`.
 *   - `none`: disables the semantic path entirely (lexical only).
 *
 * DeepSeek exposes no official embedding API, so this slot is how a future
 * remote provider (e.g. an HTTP API) can be plugged in by the host app.
 */
import type { TokenizeOptions } from './tokenize.ts'
import { tokenize } from './tokenize.ts'
import { fnv1a } from './util.ts'

export type EmbeddingProviderKind = 'none' | 'ngram' | 'transformers'

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind
  /** ngram: vector dimensionality (default 256). */
  dim?: number
  /** ngram: CJK n-gram depth forwarded to the tokenizer. */
  cjkN?: number
  /** transformers: HuggingFace model id. */
  model?: string
  /** transformers: 'auto' | 'cpu' | 'gpu' | 'wasm'. */
  device?: string
  /** transformers: model cache directory (defaults to HF cache). */
  cacheDir?: string
  /** transformers: quantize to int8 when possible. */
  quantized?: boolean
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind
  /** Vector length; 0 when the provider is disabled. */
  readonly dim: number
  /** Embed a batch of texts (parallel-ready). */
  embed(texts: readonly string[]): Promise<Float32Array[]>
  dispose(): void
}

/** Cosine similarity between two equal-length float32 vectors. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Create an embedding provider from config. May throw when the model loads. */
export async function createEmbeddingProvider(config: EmbeddingConfig): Promise<EmbeddingProvider> {
  if (config.provider === 'ngram') {
    return new NgramEmbedder(config)
  }
  if (config.provider === 'transformers') {
    return createTransformersProvider(config)
  }
  return NoopProvider
}

const NoopProvider: EmbeddingProvider = {
  kind: 'none',
  dim: 0,
  async embed() {
    return []
  },
  dispose() {
    /* nothing to release */
  },
}

/**
 * Zero-dependency local embedder.
 *
 * Each text is tokenized to CJK n-grams + words; every token is mapped with
 * feature hashing (FNV-1a) into a `dim`-dimensional signed vector weighted by
 * sublinear term frequency, then L2-normalized. `cosine` of two such vectors is
 * a bag-of-tokens kernel — cheap, deterministic, language-aware for CJK.
 */
export class NgramEmbedder implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = 'ngram'
  readonly dim: number
  private readonly config: EmbeddingConfig

  constructor(config: EmbeddingConfig) {
    const dim = config.dim ?? 256
    if (!Number.isInteger(dim) || dim < 16 || dim > 8192) {
      throw new Error(`embedding.dim must be an integer in [16, 8192], got ${dim}`)
    }
    this.dim = dim
    this.config = config
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const options: TokenizeOptions = { cjkN: (this.config.cjkN ?? 2) as 1 | 2 | 3 }
    return texts.map((text) => {
      const vec = new Float32Array(this.dim)
      const { tokens } = tokenize(text, options)
      // Count term frequencies for sublinear weighting.
      const counts = new Map<string, number>()
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const [token, count] of counts) {
        const idx = fnv1a(token, 0x811c9dc5) % this.dim
        const sign = (fnv1a(token, 0x01000193) & 1) === 0 ? 1 : -1
        // Sublinear TF keeps common tokens from dominating.
        const weight = 1 + Math.log(1 + count)
        vec[idx]! += sign * weight
      }
      normalizeInPlace(vec)
      return vec
    })
  }

  dispose(): void {
    /* stateless */
  }
}

function normalizeInPlace(vec: Float32Array): void {
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!
    sum += v * v
  }
  const norm = Math.sqrt(sum)
  if (norm === 0) return
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
}

/** Default neural model (multilingual so CJK works out of the box). */
export const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/**
 * Optional neural provider backed by `@huggingface/transformers`.
 *
 * The package is intentionally NOT a hard dependency; loading it here lets the
 * engine degrade to lexical-only when it is absent rather than breaking boot.
 */
async function createTransformersProvider(config: EmbeddingConfig): Promise<EmbeddingProvider> {
  let transformers: typeof import('@huggingface/transformers')
  try {
    transformers = await import('@huggingface/transformers')
  } catch (error) {
    const message =
      'embedding.provider = "transformers" requires the optional package `@huggingface/transformers` ' +
      '(npm i @huggingface/transformers). Falling back to lexical-only search.'
    throw new Error(message, { cause: error })
  }
  const { pipeline, env } = transformers
  if (config.cacheDir) {
    env.cacheDir = config.cacheDir
  }
  const device = config.device && config.device !== 'auto' ? config.device : undefined
  const pipe = (await pipeline('feature-extraction', config.model || DEFAULT_MODEL, {
    dtype: config.quantized === false ? 'fp32' : 'q8',
    device,
  })) as (inputs: readonly string[], options: { pooling?: string; normalize?: boolean }) => Promise<unknown>

  let knownDim = 0
  const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
    const raw = await pipe(texts, { pooling: 'mean', normalize: true })
    const rows = normalizeInference(raw)
    if (knownDim === 0 && rows.length > 0 && rows[0]!.length > 0) knownDim = rows[0]!.length
    return rows
  }

  return {
    kind: 'transformers',
    get dim(): number {
      return knownDim || 0
    },
    async embed(texts) {
      return embed(texts)
    },
    dispose() {
      // The pipeline object holds no long-lived native handles that we
      // must close explicitly in the transformers.js API.
    },
  }
}

/** Normalize a raw inference result into an array of float32 vectors. */
function normalizeInference(raw: unknown): Float32Array[] {
  const rows = Array.isArray(raw) ? raw : [raw ?? []]
  return rows.map((row) => {
    if (Array.isArray(row)) {
      return Float32Array.from(row.flat(Infinity) as number[])
    }
    const data = (row as { data?: ArrayLike<number> }).data
    if (data && typeof data.length === 'number') {
      return Float32Array.from(Array.from(data))
    }
    return Float32Array.from(row as number[])
  })
}
