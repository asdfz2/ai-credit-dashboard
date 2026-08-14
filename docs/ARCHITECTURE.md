# 架构说明

本文档说明 `trae-dashboard-enhancer.user.js` 的核心流程与设计取舍，便于维护和面试讲解。

## 定位

Tampermonkey 用户脚本，单文件、原生 JavaScript、无运行时依赖。脚本只在 Trae 用量页面运行，通过拦截页面已发起的 API 请求获取数据，在页面内注入增强面板。

## 核心流程

1. `init()` 安装 fetch / XMLHttpRequest 拦截器，等待页面加载后渲染面板，并启动 DOM 监听。
2. 页面发起用量 API 请求时，拦截器读取响应并调用 `DataStore.mergeApiResponse()` 合并数据。
3. 若响应包含分页字段，`fetchAllPages()` 自动请求剩余分页，每页间隔 300ms。
4. `computeStats()` 基于会话数据计算总消耗、今日、近 7 天、本月、模型 breakdown 与每日趋势。
5. `renderDashboard()` 创建或复用容器，把统计结果渲染为卡片、条形图和柱状图。
6. 数据为空时按顺序回退：点击页面按钮触发新请求 → 主动调用用量 API → 从 DOM 文本提取数字。

## 主要函数

- `DataStore`：读写 `GM_getValue/GM_setValue`，合并 API 响应，按 `session_id` 去重，触发自动翻页。
- `setupNetworkInterceptor()`：包装 `window.fetch` 与 `XMLHttpRequest.prototype`，只处理 Trae 相关 URL。
- `fetchAllPages()`：循环请求后续分页，等待 300ms 后继续，全部完成后重新渲染。
- `computeStats()`：聚合时间范围、模型维度、日期维度的积分与调用次数。
- `renderDashboard()` / `renderModelBreakdown()` / `renderTrendChart()`：注入统计卡片、模型条形图和 7 天趋势图。
- `getOrCreateContainer()`：在 `main`、`.dashboard-content`、`#app > div` 等容器下创建面板根节点。
- `observePageChanges()`：用 `MutationObserver` 监听 DOM，路由切换导致面板被移除时自动重建。
- `fetchUsageData()` / `extractDataFromDOM()` / `triggerApiCalls()`：拦截器未命中时的三级回退方案。

## 数据模型

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

## 设计取舍

- **拦截 API 而不是抓取 DOM**：API 响应结构稳定、包含全量字段和分页信息，比解析页面文本更可靠。
- **使用 GM 本地存储**：刷新页面或切换路由后数据不丢，且不把用户数据上传到任何服务器。
- **自动翻页加 300ms 延迟**：官方页面默认只展示部分数据；延迟请求避免对服务端造成压力。
- **同时包装 fetch 与 XHR**：页面两种请求方式都可能触发，只拦截一种会漏数据。
- **多级回退**：拦截器可能因页面加载顺序、框架封装方式而漏掉请求，回退策略保证面板不空白。
- **MutationObserver 重建面板**：Trae 是 SPA，路由切换后注入节点可能被框架清空。

## 已知限制

- 依赖 Trae 内部 API 路径（`/trae/api/v1/pay/`、`/trae/api/v2/pay/` 等），官方调整接口后需要同步更新。
- 对全局 `fetch` 和 `XMLHttpRequest` 做了 monkey-patch，若目标页面升级后依赖原始函数身份，可能需要调整。
- 当前没有自动化测试，改动后建议在真实 Trae 用量页面做一次回归验证。
