# dsh-doc-index

[![npm version](https://img.shields.io/npm/v/dsh-doc-index)](https://www.npmjs.com/package/dsh-doc-index)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[中文说明](./README.zh.md)

A **dsh bundle** that turns a workspace into a searchable local knowledge base:
it builds a semantic document index over your local Markdown / plain text /
PDF / DOCX / PPTX / XLSX files, and lets you (or an agent) query it with
natural language or keywords — getting back the matched documents, snippets
**with exact line numbers** and relevance scores.

- Lexical retrieval: SQLite **FTS5** (`node:sqlite`, no native deps) with a
  custom CJK n-gram tokenizer for proper Chinese search.
- Semantic retrieval: a **provider slot** with a zero-dependency local
  embedder by default, and an optional neural `transformers` provider.
- Results are fused with **Reciprocal Rank Fusion (RRF)**.
- **Incremental** updates: only changed files are re-indexed (with an optional
  file watcher), and a full rebuild is always available as a fallback.
- Capacity and exclusion controls keep the index bounded and targeted.
- Ships a dsh service (`ctx.docIndex`) + four model-facing tools
  (`doc_scan`, `doc_query`, `doc_reindex`, `doc_stats`) **and** a standalone
  CLI (`docindex`).

The bundle follows the standard dsh distribution format: the `package.json`
declares `dsh.bundle.patch` pointing at `cordis.patch.yml`, and the entry
module is a Cordis `Service` with `static inject` / `static Config` — the same
shape as `@deepseek-ai/dsh-session-query-sqlite`, but re-implemented for
workspace documents and searchable through your own tools.

---

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite`).
- To run inside **dsh**, a working DeepSeek Harness install that provides
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` and
  `@deepseek-ai/schemastery` (the plugin declares them as peer dependencies).

> **Note:** `node:sqlite` is still marked experimental by Node and prints a
> warning on startup. It is fully functional; run with
> `--disable-warning=ExperimentalWarning` to silence it.

---

## Install & integrate into dsh

From your profile directory (or anywhere in the harness), add the bundle and
mount it via a patch layer:

```bash
dsh plugin add <path-to-this-package>
```

The package is also on npm for the standalone CLI:

```bash
npm install -g dsh-doc-index   # provides the `docindex` CLI
npm install dsh-doc-index      # or add it as a project dependency
```

The shipped `cordis.patch.yml` inserts one plugin row:

```yaml
- insert:
    - id: doc-index
      name: dsh-doc-index
```

With no extra configuration it indexes the current working directory into
`$DSH_HOME/doc-index/index.db` (`DSH_HOME` is `~/.dsh` by default) and starts
watching it for changes.

Override any option from your profile's `cordis.patch.yml` — a later patch
layer **replaces the whole `config`** for a row, so restate every key you care
about:

```yaml
- id: doc-index
  config:
    roots:
      - /path/to/your/workspace
      - /another/vault
    dbPath: /path/to/index.db
    update: watch
    embedding:
      provider: transformers   # needs `npm i @huggingface/transformers`
    excludes:
      - vendor/
      - '*.tmp'
```

Once loaded, the four tools become available to the model, and any other
plugin can use the `ctx.docIndex` service:

```ts
const hits = await ctx.docIndex.query({ query: 'RLHF and llama.cpp' })
// hits[0].path, hits[0].line, hits[0].snippet, hits[0].score
```

---

## Standalone CLI

The same engine is available on the command line:

```bash
# index the current directory (or --root multiple times; --db to choose the db)
docindex scan
docindex scan --root ./docs --root ./specs

# search
docindex query "flux pipeline timeout" --top 5
docindex query "向量数据库" --mode semantic --json

# rebuild
docindex reindex --full

# inspect
docindex stats
```

Run `docindex --help` for the full option list. Env overrides:
`DOCINDEX_DB`, `DOCINDEX_ROOTS` (path-separator separated).

---

## Model-facing tools

| Tool | Purpose |
| --- | --- |
| `doc_scan` | Index/refresh/prune the workspace (incremental). Optional `path` to scope to a subtree, `force` to ignore change detection. |
| `doc_query` | Search. `query` (required), `topK`, `mode` (`auto`/`lexical`/`semantic`), `highlight`, `snippetChars`. Returns path + line + snippet + score per hit. |
| `doc_reindex` | Rebuild. `full` clears the index first; `path` scopes a rebuild. |
| `doc_stats` | Index statistics (docs, segments, embedded, size, roots). |

---

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `roots` | `[]` → `process.cwd()` | Workspace root(s) to scan. |
| `dbPath` | `''` → `$DSH_HOME/doc-index/index.db` | SQLite database path (`:memory:` allowed). |
| `openAt` | `startup` | When to open the DB: `startup`, `first-use`, `never`. |
| `update` | `watch` | Keep the index current: `watch` (fs.watch + debounce) or `manual`. |
| `watchDebounceMs` | `1500` | Debounce for the watch-driven rescan. |
| `excludes` | `[]` | Extra gitignore-style patterns (see notes below). |
| `includeHidden` | `false` | Index dot-files/directories. |
| `followSymlinks` | `false` | Follow directory symlinks (cycles are broken). |
| `maxDocs` | `20000` | Max documents in the index. |
| `maxSegments` | `300000` | Max stored text segments. |
| `maxEmbeddedSegments` | `50000` | Max segments that receive an embedding vector. |
| `maxFileBytes` | `5 MB` | Skip files larger than this. |
| `maxDepth` | `64` | Max directory depth below a root (0 = unlimited). |
| `maxWalkedFiles` | `200000` | Max candidate files collected per scan (the internal examined-file budget is 4×). If the walk is truncated by this cap, **no pruning happens** on that run. |
| `tokenizer.cjkN` | `2` | CJK n-gram depth: `1` (unigrams), `2` (+bigrams), `3` (+trigrams). |
| `segmentChars` | `400` | Approx. max chars per indexed segment. |
| `snippetChars` | `240` | Max snippet length returned per hit. |
| `textExtensions` | `[]` | Extra extensions (e.g. `.csv`) treated as plain UTF-8 text. |
| `search.topK` | `10` | Default hits per query (1–50). |
| `search.minScore` | `0` | Filter fused results below this normalized score. |
| `search.mode` | `auto` | `auto`, `lexical`, or `semantic`. |
| `search.highlight` | `true` | Wrap matched terms in `**…**`. |
| `search.matchOp` | `and` | Combine query runs with `and` or `or`. |
| `search.rrfK` | `60` | RRF constant. |
| `search.semanticWeight` | `0.5` | Weight of the semantic list in RRF (lexical gets `1 - w`). |
| `embedding.provider` | `ngram` | `none`, `ngram`, or `transformers`. |
| `embedding.dim` | `256` | ngram embedder dimension. |
| `embedding.model` | `''` | transformers model id (default: multilingual MiniLM). |
| `embedding.device` / `cacheDir` / `quantized` | `auto` / HF cache / `true` | transformers provider options. |
| `journalMode` | `wal` | SQLite journal mode. |

---

## Semantic embeddings (the provider slot)

DeepSeek exposes no official embedding API, so dsh-doc-index ships a pluggable
`EmbeddingProvider` slot:

- **`ngram` (default, zero dependencies)** — a deterministic feature-hashing
  embedder over CJK n-grams + latin words. It runs fully offline, needs no
  model download, and gives a real vector space. It acts as a **reranker**:
  semantic candidates are restricted to segments that share a token with the
  query, so a query with no match returns no results instead of fabricated
  hits. For true learned-semantics matching (including cross-lingual recall),
  switch the provider (below).
- **`transformers` (optional)** — loads a small ONNX encoder through
  `@huggingface/transformers`. Install it, then
  `embedding.provider: 'transformers'`. The default model is multilingual, so
  Chinese works out of the box.
- **`none`** — disables the semantic path (lexical only).
- A host app can also implement and inject a custom provider for, e.g., a
  remote HTTP embedding API.

If a requested provider cannot be built (e.g. the optional
`@huggingface/transformers` package is missing), the engine **degrades
gracefully**: it logs a warning and continues with lexical-only search.
`doc_query` marks the result `degraded` when semantic search was intended but
unavailable.

---

## How retrieval works

1. **Segments** — each document is split into chunks (~`segmentChars`), each
   keeping the 1-based source line where it starts, so every hit cites a line.
2. **Tokenizer** — latin words are lowercased; CJK runs are expanded into
   n-grams (`你好世界` → `你 好 世 界 你好 好世 世界` at depth 2). The same
   tokens are stored in FTS5 and rebuilt from the query, so Chinese keyword
   search just works. Queries match an ideographic run with `OR` over its
   n-grams (so 苹果手机 also matches documents containing 苹果 or 手机),
   combined across runs with `AND` (or `OR`).
3. **Lexical** — FTS5 `bm25()` ranked matches.
4. **Semantic** — query embedding vs. stored segment embeddings via cosine
   (bounded by `maxEmbeddedSegments`; vectors stored in SQLite).
5. **Fusion** — the two ranked lists are merged with Reciprocal Rank Fusion
   and normalized to `[0, 1]`.

---

## Excludes, binaries and capacity

- Default excludes table: `node_modules/`, `.git/`, `.svn/`, `.hg/`,
  `.cache/`, `.next/`, `.nuxt/`, `.output/`, `dist/`, `build/`, `coverage/`,
  `.DS_Store`, `*.pyc/pyo`, `*.exe/dll/so/dylib/o/obj`, `Thumbs.db`,
  `.docindex/`. `excludes` adds gitignore-style patterns (`**`, `*`, `?`,
  `[...]`, leading `!` negation, trailing `/` for dirs, leading `/` anchors).
- Unknown extensions are content-sniffed; binary-looking files are skipped
  (`binary`). PDFs without a usable text layer are skipped with a
  `no-text-layer` reason (they need OCR). Empty files are skipped (`empty`).
- When `maxDocs`/`maxSegments` are reached, new documents are skipped
  (`max-docs` / `max-segments`) and reported in `doc_scan` output.

---

## Development

```bash
npm install          # installs TypeScript + dsh type packages (dev only)
npm run build        # tsc -> dist/
npm test             # build + run the full test suite (node:test, no extra deps)
```

The core (`src/engine.ts`, `src/db.ts`, `src/embedding.ts`, …) has **zero
runtime dependencies** and is fully covered by unit tests: tokenization,
ignore rules, extraction (text/PDF/OOXML), discovery, incremental updates,
CJK search, RRF ranking, snippet highlighting, capacity limits, and graceful
degradation when no embedding model is available.

See `example/` for a small sample workspace.

## License

[MIT](LICENSE)

Found a bug or want a new extractor? Open an issue at
[github.com/JohnXu22786/docindex](https://github.com/JohnXu22786/docindex/issues).
