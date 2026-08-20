# dsh-doc-index

[![npm version](https://img.shields.io/npm/v/dsh-doc-index)](https://www.npmjs.com/package/dsh-doc-index)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[English](./README.md)

一个 **dsh bundle**：将工作区变为可检索的本地知识库。它会对本地的
Markdown / 纯文本 / PDF / DOCX / PPTX / XLSX 文档建立语义索引，并支持用自然
语言或关键词查询——返回命中文档、**带精确行号**的片段与相关度分数。

- 词法检索：SQLite **FTS5**（`node:sqlite`，无原生依赖）＋自研 CJK 分词器，
  让中文搜索开箱即用。
- 语义检索：**provider 插槽**——默认自带宽容零依赖的本地嵌入器，也支持按需
  接入神经网络的 `transformers` provider。
- 结果以 **RRF（倒数排名融合）** 融合。
- **增量更新**：仅对变更文件重索引（可选文件监听），并保留全量重建兜底。
- 容量与排除规则可控，索引规模有界、目标明确。
- 提供 dsh 服务（`ctx.docIndex`）＋四个模型可调用工具（`doc_scan`、
  `doc_query`、`doc_reindex`、`doc_stats`），**同时**提供独立 CLI（`docindex`）。

该 bundle 遵循 dsh 标准分发格式：`package.json` 声明 `dsh.bundle.patch` 指向
`cordis.patch.yml`，入口模块是带 `static inject` / `static Config` 的 Cordis
`Service`——与 `@deepseek-ai/dsh-session-query-sqlite` 同形态，但为工作区文档
重新实现，并通过自有工具提供检索能力。

---

## 环境要求

- Node.js **>= 22.5**（使用内置 `node:sqlite`）。
- 要运行在 **dsh** 中，需要一个可提供 `@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 的 DeepSeek Harness
  环境（这些被声明为 peer 依赖）。

> **说明：** Node 将 `node:sqlite` 标记为实验特性，启动时会有提示（不影响功能）。
> 可用 `--disable-warning=ExperimentalWarning` 关闭。

---

## 安装接入 dsh

在 profile 目录（或 Harness 任意位置）添加 bundle 并通过补丁层挂载：

```bash
dsh plugin add <本包路径>
```

本包也已发布到 npm，可独立使用 CLI：

```bash
npm install -g dsh-doc-index   # 提供 `docindex` CLI
npm install dsh-doc-index      # 或作为项目依赖加入
```

自带的 `cordis.patch.yml` 只插入一行插件：

```yaml
- insert:
    - id: doc-index
      name: dsh-doc-index
```

不额外配置时，它会把当前工作目录索引到 `$DSH_HOME/doc-index/index.db`
（`DSH_HOME` 默认 `~/.dsh`），并开始监听变更。

如需自定义，在 profile 的 `cordis.patch.yml` 里覆盖（后层补丁会**整体替换**
该行的 `config`，请把关心的键全部写上）：

```yaml
- id: doc-index
  config:
    roots:
      - /path/to/your/workspace
      - /another/vault
    dbPath: /path/to/index.db
    update: watch
    embedding:
      provider: transformers   # 需要 `npm i @huggingface/transformers`
    excludes:
      - vendor/
      - '*.tmp'
```

加载后，四个工具即可被模型调用，其他插件也可使用 `ctx.docIndex` 服务：

```ts
const hits = await ctx.docIndex.query({ query: 'RLHF and llama.cpp' })
// hits[0].path, hits[0].line, hits[0].snippet, hits[0].score
```

---

## 独立 CLI

同一套引擎也可以在命令行使用：

```bash
# 索引当前目录（可用 --root 多次；--db 指定库）
docindex scan
docindex scan --root ./docs --root ./specs

# 检索
docindex query "flux pipeline timeout" --top 5
docindex query "向量数据库" --mode semantic --json

# 重建
docindex reindex --full

# 查看统计
docindex stats
```

`docindex --help` 查看全部参数。环境变量：`DOCINDEX_DB`、`DOCINDEX_ROOTS`
（按路径分隔符拆分）。

---

## 模型工具

| 工具 | 用途 |
| --- | --- |
| `doc_scan` | 增量扫描/刷新/清理工作区（可选 `path` 限定子树，`force` 忽略变更检测）。 |
| `doc_query` | 检索。`query`（必填）、`topK`、`mode`（`auto`/`lexical`/`semantic`）、`highlight`、`snippetChars`。每条命中返回 路径＋行号＋片段＋分数。 |
| `doc_reindex` | 重建。`full` 先清空索引；`path` 限定范围重建。 |
| `doc_stats` | 索引统计（文档数、片段数、嵌入数、体积、根目录）。 |

---

## 配置参考

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `roots` | `[]` → `process.cwd()` | 扫描的工作区根目录。 |
| `dbPath` | `''` → `$DSH_HOME/doc-index/index.db` | SQLite 路径（可用 `:memory:`）。 |
| `openAt` | `startup` | 打开库的时机：`startup` / `first-use` / `never`。 |
| `update` | `watch` | `watch`（fs.watch＋防抖）或 `manual`。 |
| `watchDebounceMs` | `1500` | 监听重扫的防抖毫秒。 |
| `excludes` | `[]` | 额外的 gitignore 风格排除规则（见下）。 |
| `includeHidden` | `false` | 是否索引点号开头的文件/目录。 |
| `followSymlinks` | `false` | 是否跟随目录符号链接（自动断环）。 |
| `maxDocs` | `20000` | 最大文档数。 |
| `maxSegments` | `300000` | 最大文本片段数。 |
| `maxEmbeddedSegments` | `50000` | 最多获得向量的片段数。 |
| `maxFileBytes` | `5 MB` | 大于此字节数的文件跳过。 |
| `maxDepth` | `64` | 根目录下最大目录深度（0 表示不限制）。 |
| `maxWalkedFiles` | `200000` | 单次扫描最多收集的候选文件数（内部检查文件预算为其 4 倍）。若因此被截断，则本次扫描**不做删除**。 |
| `tokenizer.cjkN` | `2` | CJK n-gram 深度：`1`（一元）/`2`（＋二元）/`3`（＋三元）。 |
| `segmentChars` | `400` | 单个索引片段约最大字符数。 |
| `snippetChars` | `240` | 每条命中的最大片段长度。 |
| `textExtensions` | `[]` | 额外按纯文本处理的扩展名（如 `.csv`）。 |
| `search.topK` | `10` | 每次查询默认命中数（1–50）。 |
| `search.minScore` | `0` | 过滤低于此归一化分数的结果。 |
| `search.mode` | `auto` | `auto` / `lexical` / `semantic`。 |
| `search.highlight` | `true` | 是否对命中词加 `**…**` 标记。 |
| `search.matchOp` | `and` | 查询各「组」之间用 `and` 还是 `or`。 |
| `search.rrfK` | `60` | RRF 常数。 |
| `search.semanticWeight` | `0.5` | 语义列表在 RRF 中的权重（词法为 `1 - w`）。 |
| `embedding.provider` | `ngram` | `none` / `ngram` / `transformers`。 |
| `embedding.dim` | `256` | ngram 嵌入器维度。 |
| `embedding.model` | `''` | transformers 模型 id（默认多语言 MiniLM）。 |
| `embedding.device` / `cacheDir` / `quantized` | `auto` / HF 缓存 / `true` | transformers 相关选项。 |
| `journalMode` | `wal` | SQLite 日志模式。 |

---

## 语义嵌入（provider 插槽）

DeepSeek 未提供官方 embedding API，因此本插件内置可插拔的
`EmbeddingProvider` 插槽：

- **`ngram`（默认，零依赖）**：基于 CJK n-gram ＋拉丁词的确定性特征哈希嵌入器，
  完全离线、无需下载模型，提供一个「共享 token 越近」的向量空间，作用相当于
  **重排序器**：语义候选被限定为与查询有 token 重合的片段，因此无匹配的查询
  会返回空结果而非“噪声命中”。需要真正学到语义（含跨语言召回）时切换 provider。
- **`transformers`（可选）**：通过 `@huggingface/transformers` 加载小型 ONNX
  编码器。安装后设置 `embedding.provider: 'transformers'`；默认模型为多语言，
  中文可直接使用。
- **`none`**：关闭语义路径（仅词法）。
- 宿主应用也可自实现并注入自定义 provider（例如远程 HTTP embedding 接口）。

若请求的 provider 无法构建（例如缺少可选的 `@huggingface/transformers`），
引擎会**优雅降级**：记警告并以纯词法继续。`doc_query` 会在「需要语义但不可用」
时把结果标记为 `degraded`。

---

## 检索原理

1. **片段**：每篇文档按约 `segmentChars` 切分为若干片段，每个片段记录起始的
   1 基行号，因此每条命中都可定位到行。
2. **分词**：拉丁词统一小写；CJK 连续段展开为 n-gram（深度 2 时
   `你好世界` → `你 好 世 界 你好 好世 世界`）。索引侧与查询侧使用同一套
   分词，中文关键词检索开箱即用。查询时，一个表意字串内部用 `OR` 匹配其
   n-gram（于是“苹果手机”也能命中只含“苹果”或“手机”的文档），字串/词之间用
   `AND`（或 `OR`）组合。
3. **词法**：FTS5 `bm25()` 排序命中。
4. **语义**：查询向量与库内片段向量做余弦相似度（受 `maxEmbeddedSegments`
   约束；向量存于 SQLite）。
5. **融合**：两份排序结果用 RRF 合并，并归一化到 `[0, 1]`。

---

## 排除规则、二进制与容量

- 默认排除表：`node_modules/`、`.git/`、`.svn/`、`.hg/`、`.cache/`、
  `.next/`、`.nuxt/`、`.output/`、`dist/`、`build/`、`coverage/`、
  `.DS_Store`、`*.pyc/pyo`、`*.exe/dll/so/dylib/o/obj`、`Thumbs.db`、
  `.docindex/`。`excludes` 追加 gitignore 风格规则（支持 `**`、`*`、`?`、
  `[...]`、`!` 取反前缀、目录尾 `/`、锚定前缀 `/`）。
- 未知扩展名按内容嗅探，疑似二进制则跳过（`binary`）。无文本层的 PDF 以
  `no-text-layer` 跳过（需 OCR）。空文件以 `empty` 跳过。
- 达到 `maxDocs`/`maxSegments` 后新文档会以 `max-docs`/`max-segments` 跳过，
  并在 `doc_scan` 输出中报告。

---

## 开发

```bash
npm install          # 仅安装 TypeScript 与 dsh 类型包（dev）
npm run build        # tsc -> dist/
npm test             # 构建并运行完整测试（node:test，无额外依赖）
```

核心（`src/engine.ts`、`src/db.ts`、`src/embedding.ts` 等）**零运行时依赖**，
并有完整单元测试覆盖：分词、忽略规则、抽取（文本/PDF/OOXML）、发现、增量
更新、中文检索、RRF 排序、片段高亮、容量限制，以及「无嵌入模型时优雅降级」。

示例工作区见 `example/`。

## 许可证

[MIT](LICENSE)
