# Changelog

All notable changes to **dsh-doc-index** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-20

### Added

- Lexical retrieval via SQLite FTS5 (`node:sqlite`, no native deps) with a
  custom CJK n-gram tokenizer.
- Semantic retrieval through a provider slot: a zero-dependency local embedder
  by default, optional neural `transformers` provider.
- Reciprocal Rank Fusion (RRF) hybrid ranking.
- Incremental scanning (only changed files re-indexed), optional file watcher,
  full rebuild fallback.
- Hit citations with exact line numbers, relevance scores and highlighted
  snippets.
- Capacity and exclusion controls (gitignore-style) to keep the index bounded.
- A dsh service (`ctx.docIndex`) + four tools (`doc_scan`, `doc_query`,
  `doc_reindex`, `doc_stats`) plus a standalone `docindex` CLI.

[0.1.0]: https://github.com/JohnXu22786/docindex/releases/tag/v0.1.0
