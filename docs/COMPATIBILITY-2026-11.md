# 2026-11 三平台改版兼容性审查

审查日期：2026-11-11
审查对象：`trae-dashboard-enhancer.user.js` v1.14.1（工作区中的未提交版本）
结论：**需要更新，且已按「新版优先、旧版回退」完成 v1.15.0 适配**。

## 1. 审查方法与证据

没有在真实登录页上操作账号，而是用当前线上前端包与已安装客户端做静态核对，再用本地 mock 页面跑端到端回归：

- 直接拉取三个平台的线上 HTML 与 JS bundle，检索平台识别路径、用量接口、请求体字段、DOM 锚点。
- 核对本机已安装版本：WorkBuddy `5.11.2`（2026-11-10 安装）、TRAE CN `3.4.7`。
- 用 Playwright 加载完整 userscript（真实 `innerText` / 布局 / `fetch`），配本地 mock 页面与假接口跑 5 组场景。

未覆盖：真实登录态下的接口鉴权、服务端分页上限、页面视觉对齐。这些仍需要在三个已登录页面上人眼复核。

## 2. 发现与处理

| 平台 | 原假设 | 2026-11 现状 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| Trae | 面板挂到 `[id$="-content-usage"]`，兜底 `[role="tabpanel"]` | 新版 dashboard 把用量区改成单页 section，旧 id 不存在；`[role="tabpanel"]` 只命中「已申请订单」等无关区块 | 面板可能不出现，或插进别人的 Tab | 优先 `[data-testid="user-entitlement-usage-management-content"]`，旧 id 回退；移除 `[role="tabpanel"]` |
| Trae | 主动采集请求体用 `'YYYY-MM-DD HH:mm:ss'` | `query_user_usage_group_by_session` 的 `start_time` / `end_time` 改为秒级数字 | 首屏/直接打开 `#usage` 时默认请求被服务端拒绝 | `defaultBody()` 改秒级数字；区间补拉继续由 `matchRequestShape()` 跟随页面实际形态 |
| Trae | 用量接口名固定小写 | 生成客户端仍请求 `/trae/api/v1/pay/query_user_usage_group_by_session` | 低（`watchApi` 的 `/trae/api/v1/pay/` 已覆盖） | `usageApi` 改为大小写/下划线不敏感，避免大写方法名漏记请求体 |
| QwenWork | 入口文案是「已使用」，数据容器从入口向上找 | 新版改为「积分历史」section，tab 为「积分消耗 / 获得积分 / 过期积分」；入口不存在 | `postFetch()` 从第一步就找不到容器，整页 0 条 | 用 `#usage-history-heading` 与 `role="tablist"` 的 aria-label 定位；「已使用」保留回退 |
| QwenWork | 列表每行四行文本，`innerText` 足够 | 新版窄屏把时间/来源放进 `hidden sm:block`，另加 `sm:hidden` 的「来源 · 时间」摘要行 | 窄屏没有日期行，解析 0 条；若强行读隐藏文本又会多一行导致金额错位 | 桌面继续 `innerText`；无日期行时按叶子节点收集并跳过 `sm:hidden` 摘要行 |
| QwenWork | 只有一种列表 | 新增「分类明细 / 原始流水」两种视图，默认原始流水；页面明确提示两种视图可能重复 | 用户切换视图后，session 级聚合与逐笔记录会重复计数 | 固定切到「原始流水」（与旧版逐笔口径一致）；切换失败则本次跳过采集 |
| QwenWork | 分页有页码 1 可点 | 新版游标分页只有「上一页 / 下一页」 | 采集后回不到第 1 页，下次可能从中间页开始 | `returnToFirstPage()` 增加连续点「上一页」直到禁用的回退 |
| QwenWork | 用量接口返回 404，没有数据源 | 新版已有 `/user/billings`、`/user/billings/sessions` 等计费接口 | 旧文档结论过期；未来可改为接口采集 | 本次仍走 DOM（避免与历史逐笔数据混算），在文档中标注为后续评估项 |
| WorkBuddy | 只匹配 `/profile/plans-usage`，挂 `main.plans-usage` | 新版新增 `/profile/credits-usage`（`main.credits-usage`，桌面端常带 `?embed=1`） | 新版「积分用量」页不注入 | `@match`、`detect()`、`pagePaths`、`mountSelectors` 同时覆盖两个入口 |
| WorkBuddy | 企业版 v2 用 `nextPageToken` | 线上包仍是 `version: 2 + pageToken`，接口路径不变 | 无（v1.14.0 已适配） | 本次回归再次覆盖两页 token 翻页 |

## 3. 变更清单

- `trae-dashboard-enhancer.user.js`
  - Trae：新版 `data-testid` 挂载点；`defaultBody()` 秒级时间；`usageApi` 大小写/下划线不敏感。
  - QwenWork：新入口/容器定位；窄屏叶子文本回退；固定「原始流水」视图；游标分页回第 1 页；「获得积分」正数不再回退成消耗；`未命名任务` / 短横线等展示占位符归一，避免同一笔记录换 ID。
  - WorkBuddy：`credits-usage` 路由与挂载点；企业版 v2 保持页面自己的 `pageSize`。
  - 版本号 `1.15.0`。
- `CHANGELOG.md`：新增 1.15.0 条目。
- `README.md`：支持平台表、新版适配说明、兼容性与工作原理同步。
- `docs/ARCHITECTURE.md`：QwenWork/Trae/WorkBuddy 路径、挂载表、显示条件、验证记录同步。

## 4. 验证结果

Playwright + 本地 mock 页面，5 组场景全部通过：

1. Trae 新版 `data-testid` 容器：面板挂到该容器而非无关 tabpanel；实际请求体 `start_time` / `end_time` 为秒级数字，`page_size=20`、`page_num=1`、`usage_type=[7]`；面板总额与 2 条记录一致。
2. WorkBuddy `plans-usage` v1：`main.plans-usage` 挂载、`pageNum/pageSize` 请求、2.00 总额。
3. WorkBuddy `credits-usage` v2：`main.credits-usage` 挂载、首屏 v1 响应带 `nextPageToken` 后自动改发 `version:2 + pageToken`、两页去重后 8.00 总额、产品/使用端分布正确。
4. QwenWork 新版：桌面 `innerText` 与窄屏叶子回退都得到 3.75 / 2 条；「分类明细 → 原始流水」切换后得到 1.25 / 1 条。
5. 旧版 QwenWork「已使用」页面：仍得到 0.50 / 1 条，旧路径未回归。

## 5. 仍需线上复核

- Trae 新版 `data-testid` 是否在所有账号/套餐下都渲染；`dashboardTabs` 配置变化时 `#usage` 是否仍存在。
- WorkBuddy 服务端是否真正接受 `pageSize=200`（可能被钳小；脚本会按实际返回条数修正总页数），以及 `credits-usage` 在普通浏览器（非 `?embed=1`）下是否可达。
- QwenWork 真实页面是否确实同时渲染「积分历史」section 与「原始流水」菜单项；Radix 菜单项的 `role` 是否稳定为 `menuitem`。
- 真实登录态下的接口鉴权、跨域与限流；本审查未使用账号数据。
