# 2026-11-22 三平台新版复核

复核日期：2026-11-22
复核对象：`trae-dashboard-enhancer.user.js` v1.15.1（线上已发布版本）
结论：**正常加载路径仍然兼容**；但 2026-11-20/21 的构建里有两处新引入的细节会让边界路径失效，已在 v1.15.2 修正。

## 1. 复核对象与证据

三平台在 v1.15.1 发布后再次构建：

| 平台 | 复核入口 | 构建文件 | Last-Modified（UTC） |
| --- | --- | --- | --- |
| Trae | `www.trae.cn/dashboard` | `static/js/async/dashboard/page.c5752c3616.js` | 2026-11-20 11:21 |
| WorkBuddy | `www.workbuddy.cn/profile/{plans,credits}-usage` | `assets/index-_u4ccNUI.js` | 2026-11-20 14:06 |
| QwenWork | `qwenwork.cn/app/settings/usage` | `assets/index-B4boo8ps.js` → `assets/usage-page-OVShUNkt.js` | 2026-11-21 13:15 |

本机安装版本：TRAE CN `3.4.7`、WorkBuddy `5.11.3`。

方法：拉取线上 HTML 与 JS bundle，逐项核对平台识别、挂载点、接口路径、请求体字段、响应字段与交互角色；再用 Playwright 加载完整 userscript，配本地 mock 页面跑回归。未使用真实登录账号。

## 2. 逐平台核对

### Trae

- `[data-testid="user-entitlement-usage-management-content"]` 仍在；credits 与 legacy 两个分支都会渲染（本次新增了 Doubao 订阅额度展示，不影响挂载）。
- 用量页仍用 `/dashboard#usage` hash；`data-testid` 容器仍在用量区顶部。
- 接口仍是 `/trae/api/v1/pay/query_user_usage_group_by_session`；请求体仍是秒级 `start_time` / `end_time`、`page_size`、`page_num`，credits 计费才带 `usage_type:[7]`。
- 响应字段 `user_usage_group_by_sessions` / `credits_float` / `model_name` / `usage_time` / `usage_group_details` 未变。
- Doubao 订阅是独立的额度展示，不改变 Trae 会话消耗接口；本次不做产品维度扩展。

### WorkBuddy

- `main.plans-usage` 与 `main.credits-usage` 两个挂载点都在；「积分概览 / 消耗明细」tab 文本未变。
- 用量接口仍是 `/billing/meter/get-user-request-usage`；v1 `pageNum/pageSize` 与 v2 `version:2 + pageToken` 的代码都在。
- 响应字段 `requestId` / `requestTime` / `credit` / `model` / `client` / `appType` 未变；产品枚举未变。
- 新增 `get-enterprise-user-usage`（企业配额）与月度配额展示，详情表仍走 `get-user-request-usage`。
- 新增 `sessionStorage.profile-enterpriseId`：axios 拦截器会给每个请求补 `X-Enterprise-Id`。脚本首屏主动采集若还没有 billing 请求可借，会拿不到企业维度，本次补了兜底读取。

### QwenWork

- 页面改为代码分包：入口 `index-B4boo8ps.js`，用量页实际在 `usage-page-OVShUNkt.js`；脚本只依赖 DOM，不受分包影响。
- `#usage-history-heading`、`role="tablist" aria-label="积分历史类型"`、`[aria-label*="积分历史视图"]`、日期格式 `YYYY-MM-DD HH:mm` 都未变。
- 行结构仍是「时间 / 来源 / 详情 / 金额」，`hidden sm:block` 与 `sm:hidden` 的响应式结构未变，上一版的按日期切段解析继续适用。
- **视图菜单的角色变了**：2026-11-21 版菜单选项从 `menuitem` / `option` 变成 `role="menuitemradio"`（选中态用 `aria-checked`）。旧选择器匹配不到，页面不在「原始流水」时切换失败，按设计跳过采集，面板显示 0 条。
- 默认视图仍是 `transactions`（原始流水），所以正常刷新不受影响；用户手动切到「分类明细」或后续版本改默认值时才会触发。

## 3. 本次修正

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| QwenWork 视图菜单选项是 `menuitemradio` | 需要切换视图时匹配不到选项，本次采集被跳过，面板 0 条 | `findRawItem` 选择器加入 `[role="menuitemradio"]`；mock 验证修复前 0 条、修复后 2 条 / 3.75 |
| WorkBuddy 企业 ID 在 sessionStorage | 首屏没有 billing 请求可借时，主动采集可能按个人口径请求 | 读取 `sessionStorage.profile-enterpriseId` 作为 `X-Enterprise-Id` 兜底；仍以页面请求头为准 |

## 4. 回归验证

Playwright + 本地 mock 页面，6 组场景全部通过：

1. QwenWork `menuitemradio` 视图切换：修复前 0 条，修复后 2 条 / 3.75，触发按钮文本变为「原始流水」。
2. QwenWork 四行结构与缺来源边界：2 条 / 3.75（缺来源归「未知来源」，不影响金额）。
3. WorkBuddy `plans-usage` v1：2 条 / 2.00，产品与使用端分布正确。
4. WorkBuddy `credits-usage` v2：3 条 / 2.25，第二次请求为 `version:2 + pageToken`、无 `pageNum`。
5. WorkBuddy sessionStorage 企业头：设置 `profile-enterpriseId=ent-9` 后刷新，用量请求带 `x-enterprise-id: ent-9`。
6. Trae 请求体：`start_time` / `end_time` 秒级，`page_size=20`、`page_num=1`；credits 带 `usage_type:[7]`，legacy 不带。

`node --check trae-dashboard-enhancer.user.js` 通过。

## 5. 仍需线上复核

- 真实登录态下的接口鉴权、跨域、限流与视觉对齐（本复核未使用账号数据）。
- QwenWork 真实页面在「分类明细」状态下脚本能否稳定切回「原始流水」；本次只验证了角色与点击路径。
- WorkBuddy 企业账号首屏是否真的会在 billing 请求之前触发主动采集；sessionStorage 兜底键名是否在所有版本一致。
- Trae Doubao 订阅是否会在用量接口里产生独立记录；若会，面板当前会按 Trae 会话统一统计，需要产品口径确认。
