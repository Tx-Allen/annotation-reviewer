# DataReviewer 优化审计 + 实现记录 (2026-05-31)

多视角 + 对抗校验审计(37 个 agent,30 条确认、0 误报)。本次会话已实现绝大部分,余项作 backlog。

## ✅ 本次已实现(均经 Playwright file:// 冒烟 + 回归)

### P0 数据安全
- `safeSet()` 配额安全写包裹 saveReview/saveReannot;写爆 → 不前进、保留草稿、底部红条强提示导出备份;启动 >~80% 预警。
- 备份**导出/导入修复**:exportProgress 改用 downloadJSON(无 BOM)、importProgress 剥 BOM;两者纳入 `draft:`/`excluded:` 键(原来自己导的备份永远导不回 + 草稿不进备份)。
- `selectIndex`/J·K 翻页前先 `saveDraftCurrent()`,改一半翻页不再丢;保存后清 `state.edits` 防止把已存行回写成草稿。
- 重复 `annotation_id` 检测:`ensureUniqueIds()` 加后缀隔离 + 顶部告警(原来多行共用进度键、互相覆盖)。
- XSS:renderList 的 `fn`/`annotation_id` 经 `escAttr`,并加固 escAttr(转义 `>` `'`);恶意文件名不再注入。

### P1 性能 + 吞吐
- **内存状态索引** `state.idx`(status/reannot/issues/excluded):renderList/passesFilter/rowStatus/hasIssues 读内存,保存只更新单行(根治几千行每次按键 O(N) 读 localStorage 的卡顿;去掉 save 时多余 renderList)。
- 图片 object-URL **LRU(≤50)** 回收,长会话不再内存暴涨。
- **数字键 1–9 直选选项**(annotate/重标):活动字段高亮 + 选项前带数字;单选自动跳下一字段;选项卡点击复用 `applyChoice`。

### 删除/排除图片
- 「✗ 不属于本集 (E)」按钮 + 快捷键 E;`excluded:<csv>:<id>` 软排除(不动磁盘原图);列表/导航/全部导出都排除;「🚫 已排除」过滤器可一键恢复。

### 移动端
- 汉堡按钮 ☰ + 侧栏抽屉(off-canvas,点外部/选条目收起);窄屏 `detail-body` 上下堆叠、工具条换行、加大触控区。

### P2 互通/运维/可达性
- `_headers`:CSP / nosniff / X-Frame-Options DENY / Referrer-Policy / index.html no-cache。
- **LS-JSON 导出**(Label Studio 可导入的 tasks+predictions)。
- 灯箱**滚轮缩放 + 拖拽 + 双击 + Esc**(看裂/棉/黑点细节)。
- `:focus-visible` 聚焦环;主题/快捷核对按钮 aria-label + aria-pressed。
- `exportAnnotateCSV` 用 `config.image_field` 作图片列名。
- 直传部署 CI:`.github/workflows/deploy-pages.yml`(**待加 secrets**:CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID;若连了 git 集成先断开)。

## ⬜ Backlog(审计提到、本次未做)
- annotate「上一条带过来」(同质批量预填)+ Ctrl+Z 撤销上次保存。
- resume/session 仅按 csvName 命名 → 同名不同数据集会串;改为按内容(header+行数 hash)。
- importProgress 非原子 + 不比时间戳:按 reviewed_at/annotated_at 保留较新、覆盖前提示。
- 列表**虚拟滚动**(目前几千 `<li>` 全进 DOM;已靠内存索引大幅缓解,极大数据集再上虚拟化)。
- 拉框(bbox)/打点(point):canvas 叠加 + 归一化坐标 + 导出扩展列(独立大功能)。
