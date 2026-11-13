# 2026-11-13 三平台新版复核

复核日期：2026-11-13
复核对象：`trae-dashboard-enhancer.user.js` v1.15.0（线上已发布版本）
结论：**不需要为兼容性改版**。v1.15.0 依赖的 33 项锚点/字段在 2026-11-12/13 的三平台构建里全部存在；本次只做了 3 项健壮性修补与文档纠正，发布为 v1.15.1。

## 1. 复核对象与证据

三平台的线上包在 v1.15.0 发布（2026-11-11）之后都重新构建过：

| 平台 | 复核入口 | 构建文件 | Last-Modified（UTC） |
| --- | --- | --- | --- |
| Trae | `www.trae.cn/dashboard` | `static/js/async/dashboard/page.7fa478c4a0.js` | 2026-11-13 12:47 |
| WorkBuddy | `www.workbuddy.cn/profile/{plans,credits}-usage` | `assets/index-CEHdvlyj.js` | 2026-11-13 07:29 |
| QwenWork | `qwenwork.cn/app/settings/usage` | `assets/usage-CroM8EOE.js` | 2026-11-12 16:37 |

本机安装版本：TRAE CN `3.4.7`、WorkBuddy `5.11.3`（2026-11-13 已从 5.11.2 升级）。

方法：拉取线上 HTML 与 JS bundle，逐项核对平台识别、挂载点、接口路径、请求体字段与响应字段；再用 Playwright 加载完整 userscript，配本地 mock 页面与假接口跑端到端回归。未使用真实登录账号。

## 2. 逐平台核对

### Trae

- 挂载点 `[data-testid="user-entitlement-usage-management-content"]` 仍在，credits 与 legacy 两个分支都会渲染它；旧 `[id$="-content-usage"]` 保留为回退。
- 用量页仍用 hash 切换（`/dashboard#usage`，`dashboardTabs` 的 key 仍是 `usage`）。
- 接口仍是 `/trae/api/v1/pay/query_user_usage_group_by_session`；请求体仍为秒级 `start_time` / `end_time`、`page_size`、`page_num`，credits 计费才带 `usage_type:[7]`。
- 响应字段 `user_usage_group_by_sessions` / `credits_float` / `model_name` / `usage_time` / `usage_group_details` / `user_input_preview` 均未变。
- 新增的 `usageManagementRestructure` 远端配置只影响用量区展示（隐藏 endpoint 余额、priority tooltip），不影响采集。

### WorkBuddy

- `main.plans-usage` 与 `main.credits-usage` 两个挂载点都在；「积分概览 / 消耗明细」tab 文本未变。
- 用量接口仍是 `/billing/meter/get-user-request-usage`；v1 `pageNum/pageSize` 与 v2 `version:2 + pageToken` 的代码都在。
- 响应字段 `requestId` / `requestTime` / `credit` / `model` / `client` / `appType` 未变；产品枚举仍是 codebuddy / docs / ima / netdisk / meeting。
- 新增礼包、补偿、H5 布局、用量导出等功能，不改变脚本的账号级消耗口径。

### QwenWork

- `#usage-history-heading`、`role="tablist" aria-label="积分历史类型"`、`[aria-label*="积分历史视图"]` 都还在。
- 视图切换改用 Radix Select，选项为 `role="option"`；脚本的 `[role="option"]` 选择器能命中。
- 「积分消耗 / 积分扣减 / 获得积分 / 过期积分」文本、游标分页的「上一页 / 下一页」、`YYYY-MM-DD HH:mm` 日期格式都未变。
- 页面已有 `/user/billings`、`/user/billings/sessions` 等接口；脚本仍走 DOM 是为了与历史逐笔记录保持同一口径，不是接口不可用。

## 3. 本次修正

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| QwenWork 解析固定按四行取值 | 新版来源列条件渲染，缺来源/详情时金额错位，整行丢失并连累后续行（实测 2.50 + 1.25 只统计到 1.25） | 先按日期行切段，每段独立判断金额位置（前 3 个叶子内从后往前找纯金额），来源/详情缺省也能入库；正常四行记录 ID 不变 |
| Trae 主动请求硬编码 `usage_type:[7]` | legacy 计费账号首屏没有捕获到页面请求时，直连可能被过滤成空 | 从 `cn_credits_billing_status` 记录 `is_credits_billing`（兼容 `data` 包装）；明确为 false 时省略该字段，状态未知时保持旧行为 |
| WorkBuddy 只借用最近一次 `/billing/` 请求头 | 新增礼包/补偿接口可能不带 `X-Enterprise-Id`，覆盖掉企业版请求头 | 单独缓存带 `x-enterprise-id` 的请求头，主动采集时补回 |
| 文档仍写 QwenWork「接口 404 / 没有可用接口」 | 与新版页面事实不符 | 修正 README FAQ 与代码注释，新增本复核文档 |

## 4. 回归验证

Playwright + 本地 mock 页面，11 组场景全部通过：

1. Trae 新版 `data-testid` 挂载；请求体 `start_time` / `end_time` 为秒级，`page_size=20`、`page_num=1`、`usage_type=[7]`；2 条记录 / 3.75，`user_input_preview` 未落盘。
2. Trae 计费状态未知：保持旧行为，带 `usage_type=[7]`。
3. Trae legacy（`is_credits_billing=false`）：请求体省略 `usage_type`，仍取到 2 条 / 3.75。
4. WorkBuddy `plans-usage` v1：2 条 / 2.00，产品与使用端分布正确。
5. WorkBuddy `credits-usage` v2：首屏响应带 `nextPageToken` 后自动改发 `version:2 + pageToken`，3 条 / 2.25，第二次请求没有 `pageNum`。
6. WorkBuddy 企业头：先发带 `ent-9` 的 billing 请求，再发不带企业头的礼包请求，点击「刷新数据」后用量请求仍带 `x-enterprise-id: ent-9`。
7. QwenWork 新版四行结构：2 条 / 3.75。
8. QwenWork「分类明细 → 原始流水」切换：切换后 2 条 / 3.75。
9. QwenWork 两页游标分页：3 条 / 4.25，采集后回到第 1 页。
10. QwenWork 边界：缺来源修复后 2 条 / 3.75（修复前只统计到 1.25）；空详情与拆分日期行也能解析，3 条 / 4.25。
11. 旧版 QwenWork「已使用」页面：2 条 / 3.75，旧路径未回归。

`node --check trae-dashboard-enhancer.user.js` 通过。

## 5. 仍需线上复核

- 真实登录态下的接口鉴权、跨域、限流与视觉对齐（本复核未使用账号数据）。
- Trae 的 `usageManagementRestructure` 配置是否会在所有账号下保留 `data-testid`。
- WorkBuddy 服务端是否接受 `pageSize=200`（v1）以及 `credits-usage` 在普通浏览器（非 `?embed=1`）下是否可达。
- QwenWork 真实页面的来源列是否始终渲染（脚本已兼容缺省，但线上样本仍需确认）。
- 桌面端若使用内置本地页面而非线上 bundle，需要单独确认。
