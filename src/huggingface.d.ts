/**
 * Minimal ambient typing for the optional `@huggingface/transformers` package.
 *
 * The bundle does not depend on it; when the user installs it to enable neural
 * embeddings the real types are used, and when they don't this declaration
 * lets the code still type-check and degrade gracefully at runtime.
 */
declare module '@huggingface/transformers' {
  export interface TransformersEnv {
    cacheDir?: string
    allowRemoteModels?: boolean
  }
  export const env: TransformersEnv
  export function pipeline(
    task: string,
    model?: string,
    options?: { dtype?: string; device?: string },
  ): Promise<unknown>
}
