# 架构说明

本文档说明 `trae-dashboard-enhancer.user.js` 的核心流程与设计取舍，便于维护和面试讲解。

## 定位

Tampermonkey 用户脚本，单文件、原生 JavaScript、无运行时依赖。脚本在 Trae 和 QwenWork 用量页面运行，通过拦截页面已发起的 API 请求获取数据（Trae），或从页面 DOM 提取已渲染的数据（QwenWork），在页面内注入增强面板。

## 支持平台

| 平台 | 域名 | 数据获取方式 | 面板主题 |
|------|------|------------|---------|
| Trae | `www.trae.cn/dashboard*` | API 拦截 + 自动翻页 | 深色（`#1a1a2e`） |
| QwenWork | `qwenwork.cn/app/settings/usage*` | DOM 文本提取 | 浅色（白色） |

脚本通过 `window.location.hostname` 自动检测当前平台，并适配 API 解析、数据提取和面板样式。

## 核心流程

### Trae 路径

1. `init()` 安装 fetch / XMLHttpRequest 拦截器，等待页面加载后渲染面板，并启动 DOM 监听。
2. 页面发起用量 API 请求时，拦截器读取响应并调用 `DataStore.mergeApiResponse()` 合并数据。
3. 若响应包含分页字段，`fetchAllPages()` 自动请求剩余分页，每页间隔 300ms。
4. `computeStats()` 基于会话数据计算总消耗、今日、近 7 天、本月、模型 breakdown 与每日趋势。
5. `renderDashboard()` 创建或复用容器，把统计结果渲染为卡片、条形图和柱状图。
6. 数据为空时按顺序回退：点击页面按钮触发新请求 → 主动调用用量 API → 从 DOM 文本提取数字。

### QwenWork 路径

1. `init()` 安装拦截器（用于未来可能的 API 支持），等待页面加载后渲染面板。
2. 页面加载完成后，`fetchUsageData()` 检测到 QwenWork 域名，跳过 API 调用。
3. `extractDataFromDOM()` 定位页面中"已使用"按钮的祖先容器，从中解析积分消耗记录。
4. 解析出时间、来源、详情、积分变更等字段，构造会话对象存入 `DataStore.sessions`。
5. `computeStats()` 和 `renderDashboard()` 复用 Trae 的统计和渲染逻辑。
6. 面板自动添加 `qwenwork-theme` class，应用浅色主题样式。

## 主要函数

- `DataStore`：读写 `GM_getValue/GM_setValue`，合并 API 响应，按 `session_id` 去重，触发自动翻页。
- `isQwenWork`：布尔标志，根据 `window.location.hostname` 判断当前平台。
- `setupNetworkInterceptor()`：包装 `window.fetch` 与 `XMLHttpRequest.prototype`，Trae 下处理用量 API，QwenWork 下跳过。
- `fetchAllPages()`：循环请求后续分页，等待 300ms 后继续，全部完成后重新渲染。
- `computeStats()`：模型维度按积分累加；日期维度按「分」（×100 整数）累加进 `dailyMap`，再派生今日 / 近 7 天 / 本月 / 趋势，保证卡片与柱状图整数口径一致。
- `renderDashboard()` / `renderModelBreakdown()` / `renderTrendChart()`：注入统计卡片、模型条形图和 7 天趋势图。QwenWork 下自动添加 `qwenwork-theme` class。
- `getOrCreateContainer()`：Trae 下在 `main`、`.dashboard-content` 等容器下创建面板；QwenWork 下直接插入 `body` 全宽显示。
- `observePageChanges()`：用 `MutationObserver` 监听 DOM，路由切换导致面板被移除时自动重建。
- `fetchUsageData()` / `extractDataFromDOM()` / `triggerApiCalls()`：拦截器未命中时的三级回退方案。QwenWork 下以 DOM 提取为主。

## 数据模型

### Trae（API 来源）

本地存储为一个 JSON 对象：

```json
{
  "api_responses": [],
  "usage_sessions": [],
  "entitlement": {},
  "billing_status": {}
}
```

会话数据中脚本主要使用以下字段：

- `session_id`：会话去重键。
- `credits_float` / `amount_float`：单次消耗积分。
- `usage_time`：时间戳或日期字符串，脚本兼容毫秒、秒和可解析字符串。
- `model_name`：模型维度聚合键。

### QwenWork（DOM 来源）

QwenWork 的 `/api/v1/usage_records` 接口返回 404，脚本从页面 DOM 中提取数据。会话对象由 DOM 解析构造：

```json
{
  "session_id": "dom-{timestamp}-{index}",
  "credits_float": 2.04,
  "usage_time": "2026-08-16T13:13:00",
  "model_name": "网页版",
  "detail": "公众号安利文章"
}
```

- `session_id`：由时间戳 + 序号生成，保证唯一。
- `credits_float`：从页面文本中解析的积分变更值（取绝对值）。
- `usage_time`：从页面文本中解析的日期时间字符串。
- `model_name`：来源字段（如"网页版"）。

## 主题系统

脚本通过 CSS class 实现双主题：

- **默认深色主题**：`#1a1a2e` 深蓝背景，`#4fc3f7` 蓝色数值，适用于 Trae 深色页面。
- **浅色主题**（`qwenwork-theme`）：白色背景、`#2563eb` 蓝色数值、`#6b7280` 灰色标签，适用于 QwenWork 白色页面。

所有样式通过 `GM_addStyle` 注入，浅色主题通过 `#trae-enhancer-root.qwenwork-theme` 选择器覆盖默认样式。

## 设计取舍

- **拦截 API 而不是抓取 DOM（Trae）**：API 响应结构稳定、包含全量字段和分页信息，比解析页面文本更可靠。
- **DOM 提取作为 QwenWork 的主方案**：QwenWork 的 API 返回 404，数据通过 SSR 直接渲染在页面中，DOM 提取是唯一可行方案。
- **使用 GM 本地存储**：刷新页面或切换路由后数据不丢，且不把用户数据上传到任何服务器。
- **自动翻页加 300ms 延迟**：官方页面默认只展示部分数据；延迟请求避免对服务端造成压力。
- **同时包装 fetch 与 XHR**：页面两种请求方式都可能触发，只拦截一种会漏数据。
- **多级回退**：拦截器可能因页面加载顺序、框架封装方式而漏掉请求，回退策略保证面板不空白。
- **MutationObserver 重建面板**：Trae 是 SPA，路由切换后注入节点可能被框架清空。
- **时间范围统一走本地自然日**：今日、近 7 天、本月与趋势图共用 `dailyMap`，避免时间戳阈值与日期字符串过滤混用导致不一致。
- **双主题适配**：通过 CSS class 覆盖实现，不增加 JS 运行时开销。

## 已知限制

- 依赖 Trae 内部 API 路径（`/trae/api/v1/pay/`、`/trae/api/v2/pay/` 等），官方调整接口后需要同步更新。
- 对全局 `fetch` 和 `XMLHttpRequest` 做了 monkey-patch，若目标页面升级后依赖原始函数身份，可能需要调整。
- QwenWork 的 DOM 提取依赖页面文本结构，若 QwenWork 调整用量页面布局，提取逻辑需要同步更新。
- QwenWork 仅展示当前页面已加载的积分记录，无法自动翻页获取历史数据。
- 当前没有自动化测试，改动后建议在真实 Trae 和 QwenWork 用量页面做一次回归验证。
