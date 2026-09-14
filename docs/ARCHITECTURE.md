# 架构说明

本文档说明 `trae-dashboard-enhancer.user.js` 的核心流程与设计取舍，便于维护和面试讲解。

## 定位

Tampermonkey 用户脚本，单文件、原生 JavaScript、无运行时依赖。脚本在 Trae、QwenWork、WorkBuddy 三个用量页面运行，通过拦截页面已发起的 API 请求获取数据（Trae、WorkBuddy），或从页面 DOM 提取已渲染的数据（QwenWork），在页面内注入增强面板。

## 支持平台

| 平台 | 域名与路径 | 数据获取方式 | 面板主题 |
|------|-----------|------------|---------|
| Trae | `www.trae.cn/dashboard*` / `trae.cn/dashboard*` | API 拦截 + 自动翻页 | 深色（`#1a1a2e`） |
| QwenWork | `qwenwork.cn/app/settings/usage*` / `www.qwenwork.cn/app/settings/usage*` | DOM 文本提取 | 浅色（白色） |
| WorkBuddy | `www.workbuddy.cn/profile/plans-usage*` / `workbuddy.cn/profile/plans-usage*` | API 拦截 + 自动翻页 | 浅色（`#F5F7FA` 底 + `#00C29A` 强调） |

脚本按 `window.location.hostname` 与 `pathname` 自动识别平台。识别失败时脚本直接退出，不做任何注入。

## 平台适配表

三个平台的差异全部收敛在脚本顶部的 `PLATFORMS` 表中，每项声明：

| 字段 | 作用 |
|------|------|
| `detect()` | 识别当前平台 |
| `storageKey` | 本地存储键，三个平台互不复用 |
| `themeClass` | 面板主题 class，`''` 表示沿用默认深色 |
| `usageApi(url)` | 判断某个请求是否用量明细接口（决定是否记录请求体、是否触发自动翻页） |
| `watchApi(url)` | 判断某个响应是否值得解析 |
| `extract(payload)` | 从响应中取出记录数组与总条数 |
| `normalize(raw)` | 把平台原始记录转成统一字段 |
| `continueBody(body, page)` | 构造下一页请求体 |
| `defaultBody()` | 拦截未命中时主动采集所用的默认参数 |
| `extras(payload, store)` | 平台特有的附加信息（如 Trae 的权益包） |
| `postFetch()` | 首次采集方式。有此项则以它为主（QwenWork），否则走主动 API 采集 |
| `note` | 面板底部的口径说明 |

新增平台只需追加一项，不需要改动统计与渲染逻辑。

## 核心流程

### 通用路径

1. `init()` 安装 `fetch` / `XMLHttpRequest` 拦截器，等待页面加载后渲染面板，并启动 DOM 监听。
2. 命中 `watchApi` 的响应交给 `mergePayload()`：解析 → 归一化 → 按记录 ID 去重合并 → 落盘。
3. `computePagination()` 由请求体中的分页参数（`pageNum` / `page_num` / `page`）与接口给出的总条数推导总页数；总页数大于当前页时，`fetchAllPages()` 自动拉取剩余分页，每页间隔 300ms。
4. `computeStats()` 基于会话数据计算总消耗、今日、近 7 天、本月、模型分布、使用端分布与每日趋势。
5. `renderDashboard()` 按数据指纹判断是否需要重绘，把统计结果渲染为卡片、条形图和柱状图。

### Trae 路径

1. 页面发起用量请求时被拦截，响应进入 `mergePayload()`。
2. 分页字段为 `page_num`，自动翻页时按请求体里已有的分页字段名递增。
3. 首次未命中时的回退阶梯：点击页面上的时间范围按钮 → 主动调用用量接口（复用页面真实请求的参数与请求头，拿不到时用 `defaultBody()` 的默认参数）。

### QwenWork 路径

QwenWork 的用量接口返回 404，没有可拦截的数据源，走 `postFetch()`：

1. `clickQwenworkUsedTab()` 定位并点击「已使用」，轮询等待数据渲染（最多 10 秒）。
2. `findQwenworkDataContainer()` 从该入口逐层向上找到含日期时间文本的容器。
3. `parseRecordsFromQwenworkDOM()` 按行解析出时间、来源、详情、积分变更，只保留消耗（负向变动），并给每条记录生成**内容 ID**（`时间 + 来源 + 详情 + 金额`，不含出现序号）。
4. `fetchAllQwenworkPagesFromDOM()` 反复点击「下一页」并解析，直到某页没有新增记录；采集完把分页退回第 1 页。
5. 结果写入 `qwenwork_usage_data`。

**内容 ID 与存量迁移**：记录的 `session_id` 不含出现序号——序号取决于当次解析的内容构成，页面新增记录后序号会漂移，同一记录就会拿到新 ID 被当成新记录重复入库。写入时若发现存量 ID 与按字段重算的标准 ID 不一致，会统一重算并按 ID 去重，把历史重复收敛掉。代价是「同一分钟内来源、详情、金额完全相同的两笔」会合并为一条（罕见，且 DOM 重复行与真实重复无法区分）。

**分页与页码**：列表按时间倒序，新记录总在第 1 页。因此采集前先把分页退回第 1 页（页面可能停留在上次遗留的页码上）；首页没有新记录时，更早的页也不可能有新记录，直接跳过翻页；采集完再把分页退回第 1 页，避免用户下次进来看到的不是最新记录。

### WorkBuddy 路径

1. 拦截 `POST /billing/meter/get-user-request-usage`，请求体形如 `{startTime, endTime, pageNum, pageSize}`。
2. `normalize()` 只保留 `requestId / credit / model / requestTime / client / agentPurpose`，**刻意丢弃 `input` 与 `inputTrunc`**（对话提示词原文）。
3. 首次进入页面时 `bootstrapPlatform()` 主动请求最近 30 天、`pageSize=200` 的数据；页面自身发起的请求（默认 7 天）也会被合并，因此面板覆盖的是两者的并集。
4. 自动翻页沿用原请求的 `pageSize`——改 `pageSize` 会同时改变偏移量，导致中间数据被跳过。

## 主要函数

- `DataStore`：读写 `GM_getValue` / `GM_setValue`，按平台存储键隔离。
- `mergePayload()`：解析、归一化、按记录 ID 去重合并、落盘，并在需要时触发自动翻页。
- `fetchAllPages()`：循环请求后续分页；同签名任务用内存中的 `_pagingInFlight` 集合防重入（该状态不落盘）。
- `computePagination()`：从请求体与响应推导当前页、每页条数与总页数；接口未给总条数时退化为「自发现翻页」。
- `setupNetworkInterceptor()`：包装 `window.fetch` 与 `XMLHttpRequest.prototype`，只处理 `watchApi` 命中的请求。
- `readSession()`：把任意平台的记录对象映射为统一字段（`id / credit / time / model / client`），并在此完成数值转换。
- `computeStats()`：模型与使用端维度按积分累加；日期维度按「分」（×100 整数）累加进 `dailyMap`，再派生今日 / 近 7 天 / 本月 / 趋势，保证卡片与柱状图整数口径一致。
- `renderDashboard()` / `renderBreakdown()` / `renderTrendChart()`：注入统计卡片、条形图与 7 天趋势图；按 `dataset.renderKey` 跳过无变化的重绘。
- `renderSubBreakdown()`：为未分类的聚合条目渲染下级明细（原生 `<details>`，默认收起）。展开状态存在内存的 `_openSubs` 集合里，按「平台 + 维度 + 条目」为键，重绘后恢复。
- `findMountTarget()` / `placePanel()` / `ensureMount()`：定位并校正面板插入点。前两者负责「插到哪里」与「按什么宽度插」，`ensureMount()` 负责 SPA 场景下的懒校正。
- `observePageChanges()`：用 `MutationObserver` 监听 DOM；面板被框架移除时重建，未落位到理想插入点时顺手校正。
- `bootstrapPlatform()` / `triggerTimeRangeButtons()`：拦截未命中时的回退方案。

## 数据模型

本地存储按平台隔离，Trae 的结构为：

```json
{
  "usage_sessions": [],
  "entitlement": {},
  "billing_status": {},
  "meta": { "platform": "trae", "lastUpdate": 0, "lastUrl": "" }
}
```

三个平台都只写 `usage_sessions` 与 `meta`（Trae 额外写 `entitlement` 与 `billing_status`，来自权益与账单接口），都不保存原始响应体。

`DataStore` 在同一页面会话内**只读一次 GM 存储**，后续读写都走内存副本，`set()` 写穿到 GM 存储。原因：Tampermonkey 的 `GM_setValue / GM_getValue` 是同步的，写后读立即可见；而 ScriptCat 的数据操作是**异步**的（写入经 IPC 落到 IndexedDB），同步的 `GM_getValue` 返回的缓存副本可能滞后于刚才的写入。没有这层缓存时，一次采集中连续多次「读 → 合并 → 写」会让后面的合并读到前面的合并之前的数据，同一批记录被当成新记录反复追加。已知取舍：同一平台的两个标签页各自持有副本，后写入的会覆盖先写入的。

`usage_sessions` 中的记录经 `readSession()` 归一后使用以下字段：

- `id`：去重键，依次尝试 `session_id` / `requestId` / `record_id` / `_recordKey`。
- `credit`：单条消耗积分，依次尝试 `credits_float` / `amount_float` / `credits` / `credit`，读取时统一转成数值。
- `time`：时间，依次尝试 `usage_time` / `created_at` / `requestTime` / `time`，兼容毫秒、秒与字符串。
- `model`：模型维度聚合键，依次尝试 `model_name` / `model` / `source`。
- `client`：使用端。**只有记录本身带该字段时才参与「使用端分布」统计**，否则 Trae 的记录会被归入一个多余的「未知使用端」桶。

各平台的落盘字段：

- Trae：原样保留接口返回的会话对象（`credits_float`、`usage_time`、`model_name`、`session_id`、`usage_group_details` 等），仅剔除 `user_input_preview`（用户输入预览，面板从不展示）。
- QwenWork：`{session_id, model_name, session_name, usage_time, credits_float}`，`session_id` 由「时间 + 来源 + 详情 + 金额 + 出现序号」构成，确定性生成，跨刷新可稳定去重。
- WorkBuddy：`{session_id, model_name, usage_time, credits_float, client, purpose}`，不含任何对话内容。

## 主题系统

面板的样式分成两层：**一套共用的组件规范 + 三张主题变量表**。组件 CSS 里不出现任何写死的颜色，全部走 CSS 变量；切换平台只是换一张变量表。

| 变量 | 含义 |
| --- | --- |
| `--tee-bg` / `--tee-surface` / `--tee-track` | 面板底色 / 内层卡片底色 / 用量条轨道 |
| `--tee-border` | 描边（面板与内层卡片共用） |
| `--tee-text` / `--tee-text-dim` / `--tee-text-mute` | 主文字 / 标签 / 脚注 |
| `--tee-accent` | 数值与强调文字 |
| `--tee-bar-from` / `--tee-bar-to` | 用量条与趋势柱的渐变两端 |
| `--tee-btn-bg` / `--tee-btn-hover` / `--tee-btn-fg` | 按钮三态 |
| `--tee-radius` / `--tee-radius-in` / `--tee-radius-btn` | 面板 / 内层 / 按钮圆角 |
| `--tee-font` / `--tee-value-size` | 字体栈 / 数值字号 |
| `--tee-max-width` | 面板最大宽度，运行时由页面内容列的实际约束注入 |

三张变量表的取值不是凭感觉定的，而是**从各页面自身的实测 token 反推**（底色、描边、圆角、强调色、字体栈、数值字号都用 `getComputedStyle` 量过）：

| | Trae | QwenWork | WorkBuddy |
| --- | --- | --- | --- |
| 底色 | `rgba(224,226,242,.04)` | `#FFFFFF` | `#FFFFFF` |
| 内层卡片 | `rgba(224,226,242,.06)` | `rgba(20,20,20,.04)` | `#F5F7FA` |
| 圆角（面板／内层） | 6px / 6px | 16px / 12px | 24px / 16px |
| 强调色 | `#32F08C` | `#5B4DFF` | `#00836A` |
| 字体栈 | SF Pro → 系统栈 | system-ui 栈 | 系统栈 |

一处刻意的偏离：WorkBuddy 的品牌色 `#00C29A` 在白底上的对比度不足以支撑正文级文字，因此**数值文字使用加深后的 `#00836A`**，而用量条等非文字元素仍用品牌色。可读性优先于颜色的逐字对齐。

样式通过 `GM_addStyle` 一次注入。**间距声明必须带 `!important`**（原因见下方「设计取舍」）。

## 面板挂载

面板插入「页面自身的滚动容器内部、内容区最顶端」，从而与页面共用同一条滚动条；面板自身不设 `overflow`，不会产生内层滚动条。

各平台的定位方式不同，用一张表描述（`mountSelectors`）：

| 平台 | 定位依据 | 结果宽度 |
| --- | --- | --- |
| Trae | `[id$="-content-usage"]`（用量 Tab 内容区） | 701px，与页面内容列一致 |
| QwenWork | `.rounded-2xl`（页面卡片）→ 向上找到内容列 | 800px，宽度约束由页面读取 |
| WorkBuddy | `main.plans-usage` | 738px，与页面各区块一致 |

以 `.` 开头的选择器视为「卡片类 landmark」：借它定位内容列，再把面板放到该内容列的父容器最顶端，同时把内容列的 `max-width` 注入 `--tee-max-width`，保证面板与页面卡片同宽居中。其余视为「容器类 landmark」，直接插为该容器的首个子节点。

三个页面都是 SPA，理想插入点常在首帧之后才渲染出来，因此挂载采用**懒校正**：落位之前每次 DOM 变化与渲染都调用一次 `ensureMount()`（落位后由 `_mountSettled` 立即返回，开销可忽略），落位即停止检查。

## 显示条件

面板只在「用量页」显示。SPA 切路由时 `pathname` 与 `hash` 都会变，而脚本只在启动时判定过一次平台，因此显示与否必须用**实时值**重新判断（`isOnUsagePage()`），判断依据也由适配表声明：

| 平台 | `pagePath`（pathname 前缀） | `pageHash`（hash 须包含） |
| --- | --- | --- |
| Trae | `/dashboard` | `usage`（各 Tab 用 hash 切换） |
| QwenWork | `/app/settings/usage` | — |
| WorkBuddy | `/profile/plans-usage` | — |

不在用量页时：移除面板且不重建（`renderDashboard()` 与 `MutationObserver` 都有这道闸门）；回到用量页时由观察器自动恢复。数据采集不受影响，仍在后台继续，因此回到用量页时看到的是最新数据。

### 数据重置与诊断

面板页脚提供两个自救入口：

- **重置本页数据**：确认后清空当前平台的 `usage_sessions` 并刷新页面，采集流程会重新走一遍。本地数据全部可以由页面重建，因此这是无损操作，用于存储数据异常时的自救。
- **复制诊断信息**：把本地存储的按日聚合与全部记录的内容明细复制到剪贴板。数据存在油猴的存储里而非页面 localStorage，页面控制台读不到，这个入口是获取报错所需数据的唯一途径（不要求用户打开 DevTools）。

## 设计取舍

- **拦截 API 而不是抓取 DOM（Trae、WorkBuddy）**：API 响应结构稳定、包含全量字段和分页信息，比解析页面文本更可靠。
- **DOM 提取作为 QwenWork 的主方案**：其接口返回 404，页面数据由 SSR 直接渲染，DOM 提取是唯一可行方案。
- **平台适配表而不是 `if/else` 分支**：三个平台在数据来源、字段、主题、分页方式上各不相同，用一张表描述差异，避免条件判断散落到统计与渲染代码里。
- **统一字段读取而不是各平台各写一套**：`readSession()` 一次性完成字段回退与数值转换，既兼容历史存量数据，也让「字符串金额被拼接」这类隐患无处藏身。
- **匿名化优先**：接口会带回用户内容（WorkBuddy 的对话提示词 `input` / `inputTrunc`、Trae 的输入预览 `user_input_preview`），脚本在归一化阶段就丢弃这些字段。原始响应体也不再留存——那份数据没有读取方，却会把用户内容复制一份进本地存储。
- **使用 GM 本地存储**：刷新页面或切换路由后数据不丢，且不把用户数据上传到任何服务器。
- **翻页状态只放内存**：持久化的翻页标志会在异常中断后永久为真，导致自动翻页静默失效；内存态天然具备自愈能力。
- **自动翻页加 300ms 延迟**：官方页面默认只展示部分数据；延迟请求避免对服务端造成压力。
- **按数据指纹决定是否重绘**：定时重绘会打断用户选中文本，也浪费 CPU。
- **模型维度按接口的 group 归属，而不是按会话归属**：一次对话可能横跨多个模型（实测 37 条会话中有 7 条各含 2 个模型），会话级的 `model_name` 只代表其中一个。Trae 的 `usage_group_details` 给出了每个模型各自的消耗，且各 group 金额之和与会话金额一致，因此按 group 归属既准确又不改变总数。没有该字段的平台回退到会话级模型名。
- **管理器无关**：只依赖标准 GM API，且凡由宿主实现的接口都做「存在性检查 + 兜底」——`GM_addStyle` 未实现时退回原生 `<style>` 注入；GM 存储按「写入可能异步、读到的可能滞后」的最保守语义设计（见 `DataStore` 的内存缓存）。理由：用户可能使用任意脚本管理器，绑定某一家等于放弃其余用户。
- **间距声明必须带 `!important`**：目标站点的样式表里存在带 `!important` 的全局重置，会把注入面板的 `margin` / `padding` 清零（连内联样式里的也躲不过）。面板的间距一律写 `!important`，选择器则一律限定在 `#trae-enhancer-root` 内，只作用于自己。新增样式时若发现「写了间距却没生效」，优先怀疑这一条——实测同一属性加 `!important` 后由 `0px` 变为 `30px`，不加则无效。
- **不让文字标签溢出容器**：趋势图的数值标签原先绝对定位在柱顶上方，靠父容器的顶部留白避让。这种「溢出 + 留白」的组合在父样式被外部影响时会直接压到标题上。渲染时必须确保为溢出部分预留的留白真的生效。
- **只在「模型已无处安放」时才折叠**：可展开的下级只保留一种——模型名未标注（`-` 或缺失）的桶按记录详情细分。它的下级是「每日积分过期」「透支扣减」这类并非模型的条目，在别处没有对应位置。反例是使用端桶：桶里的记录都带模型名，而模型已在「各模型积分消耗」中各自成行，再叠一层折叠属于重复呈现，已被移除。
- **占位桶不充当它不属于的维度**：使用端一览只保留真实存在的客户端标识。接口没给使用端而只给了模型的记录，归入模型统计即可；若还以「未知使用端」的身份在使用端一览里列一行，同一笔积分看起来就被计算了两遍。摘出去之后必须在本节说明差额去向，否则这一节会静默地加不出总数。
- **未分类聚合条目可下钻但默认收起**：把多种来源合并成一行的条目本身是有价值的信息（它说明存在无法归类的消耗），不该被过滤掉，但也不该把构成摊在默认视图里。当某个桶的可用维度为空、只能由一个脚本自造的占位名兜底时，不渲染折叠控件。
- **占位文案由平台声明**：模型名完全缺失时的展示文案各平台不同（Trae 页面在未指定模型时显示 `auto`），因此放在适配表的 `modelPlaceholder` 里，而不是写死在统计逻辑中。
- **原样呈现采集结果**：接口给什么就展示什么。模型名为 `-`（页面用它表示未公布）时保持 `-`，不改写成「过期积分」之类的推断性说法——那会让人误以为检测到了积分过期。只有接口完全没给值时才使用「（未标注）」占位。
- **多级回退**：拦截器可能因页面加载顺序或框架封装方式而漏掉请求，回退策略保证面板不空白。
- **MutationObserver 重建面板**：Trae 是 SPA，路由切换后注入节点可能被框架清空。
- **时间范围统一走本地自然日**：今日、近 7 天、本月与趋势图共用 `dailyMap`，避免时间戳阈值与日期字符串过滤混用导致不一致。字符串时间统一转成 ISO 风格再解析，避免 `"YYYY-MM-DD HH:mm:ss"` 在部分环境解析失败。

## 已知限制

- Trae 依赖内部 API 路径（`/trae/api/v1/pay/`、`/trae/api/v2/pay/` 等），官方调整接口后需要同步更新。
- WorkBuddy 依赖 `/billing/meter/get-user-request-usage` 的字段结构；该接口返回的 `input` 字段属于内部实现细节，若官方移除不影响脚本。
- 对全局 `fetch` 和 `XMLHttpRequest` 做了 monkey-patch，若目标页面升级后依赖原始函数身份，可能需要调整。
- QwenWork 的 DOM 提取依赖页面文本结构，若 QwenWork 调整用量页面布局，提取逻辑需要同步更新。
- WorkBuddy 主动采集固定取最近 30 天，更早的历史不会进入面板。
- Trae 的会话对象不含 `session_name`（2026-09-13 实测），因此「模型桶 → 按详情细分」这一维度在 Trae 上不可用；该平台目前也不会出现未分类的模型桶，故不渲染折叠控件。若将来出现 `-` 或空模型名的记录，需要考虑改用 `usage_group_details[].model_display_name` 作为下级维度。
- 当前没有自动化测试，改动后建议在三个平台的真实用量页面各做一次回归。回归重点是三条恒等式：总积分 = 各模型之和、近 7 天 = 趋势柱之和、今日 = 趋势图末柱。
