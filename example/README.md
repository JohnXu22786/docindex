# Example workspace

`workspace/` is a small, realistic document corpus you can point `dsh-doc-index`
at to try the plugin right away:

| File | Content |
| --- | --- |
| `docs/training-guide.md` | A markdown handbook (heading + sections). |
| `docs/benchmarks.txt` | Plain-text notes with keywords. |
| `notes/chinese-notes.md` | A Chinese document (tests CJK n-gram search). |

## Try it

### CLI (no dsh needed)

```bash
# from this bundle root: build once, then index the example workspace
npm run build
node dist/src/cli.js scan --root example/workspace --db example/index.db

# keyword search
node dist/src/cli.js query "reward" --db example/index.db --root example/workspace

# Chinese search (highlights + line numbers included)
node dist/src/cli.js query "推理模型" --db example/index.db --root example/workspace
```

### In dsh

Add the bundle to a profile and point it at this workspace:

```yaml
- id: doc-index
  config:
    roots:
      - ./example/workspace     # absolute/paths/project/example/workspace
    dbPath: ./example/index.db
    update: watch
```

Then ask the model to `doc_scan`, then `doc_query "policy reward model"` or
`doc_query "推理模型"` — it will return hits with file paths, line numbers,
snippets and scores.

> The `.docindex` directory inside a workspace is excluded by default, so the
> index itself is never scanned.
