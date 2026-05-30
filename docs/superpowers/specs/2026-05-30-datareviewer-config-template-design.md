# DataReviewer：标注配置模板导入 + 重新标注 + 断点续跑 — 设计文档

- **日期**：2026-05-30
- **目标文件**：`index.html`（浏览器单文件版；Flask 版本次不改）
- **状态**：已与用户确认设计，待评审 spec → 进入实现计划

---

## 1. 背景与现状

`C:\Project\DataReviewer` 是一个玉石图片标注**核对**工具，有两个版本：

- **`index.html`**（浏览器单文件版，本次改造对象）：零依赖、可双击打开 / GitHub Pages 根 URL 直达 / 完全离线。功能含：选 CSV + 图片文件夹、自动识别图片列、抽样（随机 / 分层 / AQL 推荐）、分包给多人（任务包 JSON）、核对（通过 / 不通过 / 存疑 + 字段微调）、数据问题校验、合并导出 CSV。进度存浏览器 `localStorage`。
- **Flask 版**（`app.py` + `db.py` + `templates/review.html` + `static/review.js`）：较简单，SQLite 持久化。**本次不改。**

**现存的"写死"**：`index.html` 内 `FIELD_SCHEMA`（约 427–511 行）与 `METAFIELDS`（约 513–518 行）是从某份 Label Studio XML 标注配置**硬编码**进来的玉石专用字段（主类别 / 子类别联动 / 颜色 / 透明度 / 质地 / 瑕疵多选互斥等），含选项 `hint`、`visibleWhen` 联动、`type:multiple`、`exclusiveValue` 互斥、`required` 必填。换标注项目就得改源码。

## 2. 需求（用户确认）

1. **配置模板导入**：把写死的 schema 改成**运行时导入标注配置模板**，支持 **Label Studio XML** 与**自有 JSON 模板**两种格式。
2. **重新标注**：在"核对"之外新增"重新标注"功能，**纠错式（预填原值）**与**盲标式（清空从零）**两种，**界面可切换**。
3. **配置随分包分发**：多人分包时把配置**嵌进任务包 JSON**，检察员导入即自动继承。
4. **断点续跑**：刷新 / 意外关闭后能继续。**Tier1 轻量（全浏览器）+ Tier2 一键（Chrome/Edge File System Access API）自动回退**。
5. **对比功能**：把"原数据（原始标注）"与"新数据（重标 / 核对修正后）"放一起对比，逐字段 diff、改动高亮；支持单条对比与整批 diff 汇总。

## 3. 范围

- **In scope**：仅 `index.html`。配置解析（XML + JSON）、配置驱动渲染/校验/导出、配置导入 UI + 持久化 + 任务包嵌入、重标模式（纠错/盲标）+ 独立存储 + 重标导出、断点续跑 Tier1+Tier2、去除两处与字段名耦合的硬编码、Playwright 冒烟测试 + fixtures。
- **Out of scope**：Flask 版改造；Label Studio 中非 `Choices/TextArea/Image` 的控件（`RectangleLabels`/`Polygon`/`Audio` 等区域标注）；服务端持久化；账号系统。
- **向后兼容硬约束**：不导配置 = 行为与现状**完全一致**；老 `review:` 进度、老任务包（无 `config` 字段）、老 `sample:` 键全部照常工作。

## 4. 实现路径决策

**方案 A — 在 `index.html` 内就地扩展，保持单文件（采用）**
把全局常量 `FIELD_SCHEMA`/`METAFIELDS` 改为 `state.config` 驱动；配置解析、重标、续跑三块逻辑写在同一个 `<script>`，靠分区注释 + 纯函数组织。
- 优点：保住"双击即开 / 零部署 / 离线"这一浏览器版立身之本；改动集中、易回滚。
- 代价：文件约 1370 → ~2100 行。

**方案 B — 拆分多 JS 文件（否决）**：`file://` 下 ES module 受 CORS 限制（双击打开即报错），破坏单文件零部署，与版本设计初衷冲突。

→ **采用 A**。

---

## 5. 详细设计

### 5.1 总体架构与数据流

```
启动页 ──选 CSV / 图片夹 / [新]配置(XML|JSON, 可选) ──┐
任务包 ──pack.config 自带配置 ──────────────────────┤→ state.config
                                                    │   无配置 → 内置 DEFAULT_CONFIG(= 现玉石 schema)
                                                    ▼
            state.schema = state.config.fields  ── 驱动 renderFields / validateRow / 导出
            state.metaFields = state.config.meta_fields (+ 自动收集未覆盖列)
                                                    ▼
   主界面 ┬─ 模式 核对  → review:csv:id   {status,note,edits}      → 核对导出(不变)
          └─ 模式 重标  → reannot:csv:id  {annotator,mode,values}  → 重标导出(新增)
                                                    ▼
       session:current(会话指针, Tier1) + IndexedDB 文件句柄(Tier2) → 断点续跑
```

**核心重构**：所有读全局 `FIELD_SCHEMA` 的函数（`validateRow`、`hasIssues`、`renderFields`、`suggestSample` 等）改读 `state.schema`；`METAFIELDS` 用法改读 `state.metaFields`。`FIELD_SCHEMA` 的内容迁入内置常量 `DEFAULT_CONFIG`。

### 5.2 配置数据结构（内存态，统一中间表示）

无论 XML 还是 JSON 导入，都归一化为此结构（即 `state.config`）：

```js
{
  version: 1,
  kind: 'annotation-config',
  name: '玉石标注 v1',          // 显示名
  image_field: 'image',         // 可选：图片所在 CSV 列提示
  fields: [
    { key, label, type:'single'|'multiple'|'text',
      required:bool,
      exclusiveValue?:string,                 // 仅 multiple
      visibleWhen?:{ field, value },          // 联动显隐
      options:[ { value, hint } ] },          // single/multiple 用；text 不需要
  ],
  meta_fields: [ { key, label } ],            // 只读展示
}
```

### 5.3 配置格式 (a)：Label Studio XML 映射

解析器 `parseLSXML(xmlText) -> config`，用浏览器内置 `DOMParser`。映射规则：

| LS 标签 / 属性 | → config |
|---|---|
| `<Choices name choice="single\|multiple" required="true">` | `field{ key:name, type:(choice\|\|'single'), required:(required==='true') }` |
| `<Choice value="…" hint="…">` | `options[].{value, hint}` |
| `visibleWhen="choice-selected" whenTagName=X whenChoiceValue=Y` | `visibleWhen:{ field:X, value:Y }` |
| `<Choice value exclusive="true">`（**工具扩展属性**，非 LS 原生） | 该字段 `exclusiveValue = value` |
| `<TextArea name=…>` | `field{ key:name, type:'text' }` |
| `<Image value="$col">` | `config.image_field = col`（去掉 `$`） |
| **label 取值优先级** | `<Choices title>` → 紧邻其前的 `<Header value>` → `name` |

- `<Image>` / `<Header>` 等非字段控件不产生 field（`Header` 仅用于取 label）。
- 不识别的控件（`RectangleLabels` 等）→ 跳过并在解析结果里附 `warnings:[]`，UI 提示"已忽略 N 个不支持的控件"。
- 解析失败（XML 非法、无任何可用字段）→ 抛带原因的错误，UI 红字显示，**不静默吞**。

### 5.4 配置格式 (b)：自有 JSON 模板

- `parseJSONTemplate(text) -> config`：`JSON.parse` 后校验 `kind==='annotation-config'`、`fields` 为非空数组、每个 field 有 `key`/`type`、`single|multiple` 有 `options`。校验不过抛错。
- `configToJSON(config) -> string`：把当前 `state.config` 序列化为上述模板（含 `DEFAULT_CONFIG` 也能导出）。
- 启动页提供「**导出当前配置为 JSON**」按钮 → 下载 `annotation-config-<name>.json`，便于手改后再导入。

### 5.5 默认 / 回退 / 自动 meta

- 内置 `DEFAULT_CONFIG`：把现有玉石 `FIELD_SCHEMA` + `METAFIELDS` 原样转成 5.2 结构。`state.config` 默认 = `DEFAULT_CONFIG`。**不导配置时渲染、校验、导出与现状逐字节一致。**
- **自动 meta 列**：渲染详情时，CSV 中既不在 `fields` 也不在 `meta_fields` 的列，自动当只读 meta 展示（泛化现有 `METAFIELDS`，无需手列），保证任意 CSV 的额外列都可见。

### 5.6 配置导入 UI + 持久化 + 任务包嵌入

- 启动页新增 **第 ⓪ 步「选标注配置（.xml/.json，可选）」**：
  - 不选 → 内置玉石默认。
  - 选了 → 实时显示「✓ 解析出 N 个字段（M 个联动 / K 个多选）」或红字错误。
  - 顶部状态条：「当前配置：<name>（N 字段）· [换] · [重置为默认]」。
- **持久化**：导入成功写 `localStorage['config:last'] = configJSON`；下次进启动页自动载回（仍可换）。
- **任务包嵌入**：分包生成 pack 时写 `pack.config = state.config`；检察员 `enterPackMode` 时 `state.config = pack.config || DEFAULT_CONFIG`（老包无 config → 默认）。

### 5.7 重新标注模式

- **UI 切换**：主界面顶部加**模式开关 `核对 | 重新标注`**。进入重标显**子开关 `纠错(预填) | 盲标(清空)`** + `显示/隐藏原标注` 折叠。
- **数据模型**（与核对解耦，互不覆盖）：
  - `reannotKey(id) = 'reannot:' + state.csvName + ':' + id`
  - 值：`{ annotator, mode:'correct'|'blind', values:{ <fieldKey>:<value|序列化多选> }, note, annotated_at }`
  - 一条记录可同时有 `review:`（核对）与 `reannot:`（重标）。
- **纠错式**：`renderFields` 在重标模式下预填 = 已存 `reannot.values[k]` ?? 原始 `r[k]`；所有 schema 字段可改；保存写**整套 values**（含未改字段，构成完整"修正后标签"）。
- **盲标式**：预填为空；原标注默认折叠隐藏（点开可比对，供复标 / IAA）；保存同样写整套 values；原值与重标值都保留。
- **底栏**：重标模式按钮替换为 `保存重标 (Enter) / 跳过`；核对模式维持 `通过 / 不通过 / 存疑`。
- **列表 / 筛选**：已重标项加标记；重标模式下筛选器追加「已重标 / 未重标」。
- **顺带去硬编码**（消除与具体字段名的耦合）：
  1. ✓/✗/! 快捷核对按钮从"绑死 `object_type` 字段"挪到**字段面板顶部固定区**（核对模式常驻，不依赖字段名）。
  2. 多选提示文案改为按字段 `exclusiveValue` 动态生成（有则提示"「X」与其他互斥"，无则仅"可多选"）。

### 5.8 断点续跑（Tier1 + Tier2 自动回退）

- **Tier1（全浏览器）**：
  - 每次保存 / 切条 / 切模式 / 切筛选写 `session:current = { csvName, reviewer, configName, imageColumn, filter, mode, subMode, lastAnnoId, packMode, totalRows, savedAt }`（`sampleIds` 已存于现有 `sample:csvName`，会话指针引用之）。
  - 重开后启动页顶部出现「**继续上次：<csv> · 已审 X/Y · 上次看到 #123**」横幅。用户重选回**同名** CSV + 图片夹（名字不符给警告但允许继续）→ 精确恢复抽样集、`filter`、`mode/subMode`、定位到 `#lastAnnoId`。
  - 进度本就在 `localStorage`，不丢。
- **Tier2（Chrome/Edge，特性探测 `'showOpenFilePicker' in window`）**：
  - 导入时多一个「记住文件，下次一键恢复」选项 → 用 `showOpenFilePicker`（CSV）/`showDirectoryPicker`（图片夹）取句柄，存入 **IndexedDB**（句柄可结构化克隆持久化）。
  - 重开点「**一键恢复**」→ `handle.queryPermission/requestPermission({mode:'read'})` → 读回 CSV 文本 + 遍历目录句柄重建 `imageMap` → 跳 `#lastAnnoId`，**连文件都不用重选**。
  - API 不支持 / 用户拒权 / 句柄失效 → 捕获后**静默回退 Tier1**（显示重选横幅）。
- **防误关**：当前条目未保存改动写轻量草稿 `draft:csv:id`，意外关闭再开恢复手头这条；正式保存后清除草稿。

### 5.9 导出

- **核对导出（保持不变）**：`exportMergedCSV(scope)` 的 `sample|reviewed|full` 三档 + `__review_status/_reviewer/_note/_at` 列 + 合并 `review.edits`。
- **重标导出（新增）** `exportReannotCSV(scope)`：遍历有 `reannot:` 的行，每个 schema 字段输出**重标值**，追加 `__reannot_annotator / __reannot_mode / __reannot_at / __reannot_changed`（改动字段名列表）；改动字段的原值留存于 `__orig_<字段>` 列（无损，供 IAA / 回溯）。侧栏加「**导出重标结果**」按钮。
- **进度备份 JSON（扩展）**：`exportProgress/importProgress` 与 `refreshStateInfo` 的键前缀从仅 `review:` 扩展为 `review:` / `reannot:` / `sample:` / `session:`（现仅备份 `review:`，会漏掉重标与会话）。

### 5.10 校验 / 联动 / 数据问题

- `validateRow(r, edits)` 已是 schema 驱动，改读 `state.schema` 即可；必填、合法选项、`exclusiveValue` 互斥、`visibleWhen` 该空却有值等检查继续生效。
- 重标模式下亦对 `reannot.values` 跑同一套校验，保证重标结果合规。

### 5.11 对比视图（原数据 vs 新数据）

把"原数据"（CSV 原始标注 `r[字段]`）与"新数据"（**最终值** = `reannot.values[字段]` 若有，否则核对 `review.edits[字段]`，再否则原值）并排对比，逐字段 diff。

- **单条对比**（详情面板）：加「对比」开关，字段区每行显示两列 `原值 | 新值`：不同 → 高亮（改动），相同 → 灰显；多选字段按集合比较并提示"＋增 / －删 了哪些值"。盲标模式下尤其有用（边盲标边随时点开比对）。
- **批量对比**（数据集级）：新增「对比」视图 / 筛选 —— 只列"新数据 ≠ 原数据"的条目；侧栏给每个字段的改动计数（如 `object_type` 改了 X 条、`defects` 改了 Y 条），点字段名 → 只看该字段有改动的条目。
- **导出**：批量对比可一键导出"仅改动" CSV，每个改动字段并列 `__orig_<字段>`（原）与字段列（新），复用 §5.9 的 `__orig_` 列约定。
- **来源开关**：对比的"新数据"默认取最终值；可切到"仅重标值"或"仅核对修正值"，便于分别审重标质量与核对改动。

---

## 6. 影响面（index.html 内待改/新增清单）

**改（去全局 schema 耦合）**：`FIELD_SCHEMA`→`DEFAULT_CONFIG` 常量；`validateRow`、`hasIssues`、`renderFields`、`suggestSample`、`renderList` 中 `FIELD_SCHEMA`/`METAFIELDS` 引用 → `state.schema`/`state.metaFields`；`renderFields` 内 `object_type` 特判与多选互斥文案 → 泛化。`state` 增 `config/schema/metaFields/mode/subMode`。

**新增（纯函数优先，便于测试）**：`parseLSXML`、`parseJSONTemplate`、`configToJSON`、`normalizeConfig`、`autoMetaFields`、`reannotKey/loadReannot/saveReannot`、`renderFieldsForMode`、`exportReannotCSV`、`saveSession/loadSession/clearSession`、`idbPutHandles/idbGetHandles`（Tier2）、`resumeFromHandles`、`draft` 读写、`diffRowFinal`（原值 vs 最终值）、`renderCompareFields`、`datasetDiffSummary`、`exportChangedOnlyCSV`。

**UI 新增**：启动页 ⓪ 配置导入行 + 导出配置按钮 + 续跑横幅 + 一键恢复按钮；主界面 模式开关 + 子模式开关 + 原标注折叠 + 重标底栏 + 重标筛选项 + 导出重标按钮 + 对比开关 + 批量对比视图(改动计数侧栏) + 导出仅改动按钮。

## 7. 错误处理

- 配置解析失败：红字显示具体原因（缺标签 / 非法 JSON / 无字段），不进入主界面。
- 不支持控件：解析继续，提示忽略数量。
- Tier2 权限拒绝 / 句柄失效：回退 Tier1，不报错弹窗轰炸。
- 续跑时 CSV 名 / 行数不符：警告横幅，允许用户确认后继续或放弃。
- 重标 / 核对值非法：数据问题横幅照常提示，不阻断保存（与现状一致，留痕由人判断）。

## 8. 测试策略

- **fixtures/**：`sample.csv`（~8 行，含联动/多选/缺值/非法值各样本）、`config.xml`（LS 配置，含 single/multiple/visibleWhen/exclusive/TextArea）、`config.json`（等价 JSON 模板）、`imgs/`（几张占位图，文件名匹配 CSV）。
- **Playwright 冒烟**（用本地 `local-browser-matrix` 技能，跑 `file://index.html`）：
  1. 不导配置 → 断言默认玉石字段渲染（回归保护）。
  2. 导入 `config.xml` → 断言字段数 / 联动显隐 / 多选互斥 / TextArea 渲染。
  3. 导入 `config.json` → 与 XML 等价。
  4. 切「重新标注 / 纠错」→ 改字段 → 保存 → 断言 `reannot:` 写入；切「盲标」→ 原值隐藏、预填空。
  5. 导出重标结果 → 断言含 `__reannot_*` 与 `__orig_*` 列。
  6. 模拟刷新（重载页面）→ Tier1 横幅出现 → 重选 fixtures → 断言定位回 `lastAnnoId`、模式恢复。
  7. 对比视图：构造原值与重标值不同的条目 → 断言单条 diff 高亮、批量对比只列改动项、改动计数正确、导出"仅改动" CSV 含 `__orig_<字段>`。
- **解析器纯函数**：可在页面内 `window.__test` 暴露后用 Playwright `evaluate` 直接断言 `parseLSXML/parseJSONTemplate` 输出。
- 记录进 `test-ledger`（本地 TestRail）。

## 9. 风险与缓解

- **文件膨胀**：~2100 行单文件 → 分区注释 + 纯函数 + 函数级聚合；不拆文件（保单文件部署）。
- **Tier2 浏览器差异**：仅 Chromium 支持 → 特性探测 + 自动回退 Tier1，无支持也完整可用。
- **大图片夹遍历**：目录句柄重建 `imageMap` 与现有 folder-input 行为一致，逐 `getFile`，规模与现状相当。
- **配置与既有进度错配**（换了配置但 `localStorage` 还有旧值）：校验会把不在新 schema 的值标为数据问题，可见可改；不自动删旧进度。

## 10. 验收标准

1. 不导配置时，所有现有功能（抽样 / 分包 / 核对 / 导出）行为不变。
2. 能导入 LS XML 与 JSON 两种配置并正确渲染（含联动 / 多选 / 互斥 / 必填 / TextArea）。
3. 配置随任务包分发，检察员导入即用对的配置；老包回退默认。
4. 重标模式纠错 / 盲标可切换，独立存储，能导出含 `__reannot_*`/`__orig_*` 的结果。
5. 刷新 / 关闭后：Tier1 重选文件即回到上次位置与模式；Chrome/Edge 下 Tier2 一键恢复连文件都不用重选；不支持环境自动回退。
6. Playwright 冒烟全绿。
7. 对比功能：单条逐字段 diff 高亮、批量列出"新 ≠ 原"并给改动计数、可导出仅改动 CSV。
