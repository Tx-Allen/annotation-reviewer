# DataReviewer — CSV 横向对比页 + 排除原因增强(设计)

日期:2026-06-01 · 状态:已批准(用户确认设计与方向)

## 目标
1. 新增独立页面 `compare.html`:上传**旧 CSV** 与**新 CSV**,按键列对齐,横向对比、高亮改动、分出新增/删除行,并可导出差异 CSV。
2. 增强 index.html 既有的「✗ 不属于本集 (E)」软排除:排除时**记录原因**,并能**导出被排除清单 CSV**。

两个功能互不依赖,但同属一次交付。**全程向下兼容**:不改 localStorage 既有键格式;`excluded:` 值只新增可选 `reason` 字段(旧值无 reason 照常工作)。

---

## 功能一:`compare.html`(独立单文件)

零依赖、可双击 / `file://` / Cloudflare Pages、深浅色跟随,与 index.html 同风格。**自包含**:内联复用 index.html 那套已加固的 CSV 工具(`parseCSV` 分隔符嗅探 + 字段边界引号、`csvToObjects` 重复表头去重 + 公式前缀对称去除、`csvQuote` 公式注入防护),不与 index.html 共享外部脚本(保持各自单文件离线可用)。

### 界面
- 顶部:`旧 CSV` 文件框、`新 CSV` 文件框、**对齐键下拉**(两文件公共列;默认 `annotation_id`,无则首列)、分隔符自动识别(逗号/Tab)。
- 两份都加载后**自动对比**。汇总条:`改动 X · 新增 Y · 删除 Z · 相同 W`;并列出**只在一边出现的列**(新增列/删除列)。
- 主表(横向并排):每行一个键值,逐**公共字段**一个单元格,显示 `旧 → 新`;改动单元格高亮。行按状态着色并分组排序:改动 → 新增 → 删除 → 相同。
- 控件:`只看差异`开关(默认开,隐藏「相同」行);醒目按钮 **⬇ 导出差异CSV**(`.btn-export` 风格)。

### 对齐与判定
- 按所选键列把两文件行各自建 `Map<key, row>`(键重复则保留首个并提示)。
- 键同时在新旧 → `matched`;逐公共字段比较 `String(old) !== String(new)` → 改动单元格;有任一字段改动 → 行状态 `changed`,否则 `same`。
- 仅新有 → `added`;仅旧有 → `removed`。

### 导出差异 CSV
- 仅含 `changed + added + removed` 行。列:`<键列>, __status(changed/added/removed)`,然后每个公共字段输出**新值**列 `field` + **旧值**列 `__old_field`。
- 全部经 `csvQuote`(公式注入防护);BOM 头同 index.html(`downloadFile`)。

### 接入
- index.html 启动页加入口按钮「🔀 对比两份CSV」→ 相对链接 `compare.html`(file:// 与 Pages 都通)。

---

## 功能二:排除原因 + 导出被排除清单(index.html)

### 数据
- `excluded:<csvName>:<id>` 值由 `{by, at}` 扩展为 `{by, at, reason}`(`reason` 可空)。**向下兼容**:旧值读出 `reason` 为 undefined,显示「未填」。

### 交互
- 在**未排除**的行点「✗ 不属于本集」或按 `E`:弹出**紧凑原因选择**(预设 chip:模糊不清 / 重复 / 与主体无关 / 标注错误 / 其他;可附一句备注;`Esc` 取消)。选一个预设或点「排除」即写入 `{by, at, reason}` 并排除、前进到下一条。
- 在**已排除**的行点按钮/`E`:直接取消排除(恢复),不弹原因。
- 详情面板「上次/状态」区显示该行的排除原因(若有)。

### 导出被排除清单
- 导出工具栏加按钮「导出被排除清单」(次要 `.btn-link`)。导出当前 CSV 命名空间下所有 `excluded:` 行:列 `<键列/annotation_id>, image(文件名), reason, by, at`。无被排除项则提示。

---

## 部署
- `deploy-pages.yml`:`paths` 增加 `compare.html`;暂存步骤增加 `cp compare.html dist/`。push 即 index.html + compare.html 一起直传。
- 本地手动暂存目录 `~/.cf-deploy/datareviewer/` 同步放 compare.html(以备手动直传)。

## 测试(Playwright,缓存 chromium)
- compare.html:两份合成 CSV 经真实文件框载入 → 改动高亮、新增/删除识别、计数正确、`只看差异`过滤、导出差异 CSV 内容与 `__old_*` 正确;空/畸形输入不崩;盲猴点击无未捕获错误。
- index.html:排除写入 reason、再点恢复、导出被排除清单内容正确;旧 `excluded` 值(无 reason)兼容;入口链接存在。
- 回归:`dr-fulltest` / `dr-fixtest` 仍全绿(index.html 仅新增入口按钮 + 排除增强,不动既有流程)。

## 非目标(YAGNI)
- 不做三方及以上文件对比;不做模糊/相似匹配(仅精确键或行序);不做单元格级编辑(对比页只读);硬删磁盘文件不做(仍软排除)。
