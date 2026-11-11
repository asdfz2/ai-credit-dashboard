// ==UserScript==
// @name         Trae / QwenWork / WorkBuddy 用量仪表盘增强
// @namespace    https://github.com/asdfz2/Trae_Qwen-dashboard-enhancer
//               ↑ namespace 刻意不跟随仓库名：脚本管理器以 namespace + name 识别脚本，
//                 改掉它会让已安装用户出现新旧两个脚本并存。它只是个隐形标识，保持稳定即可。
// @version      1.15.0
// @description  在 Trae、QwenWork、WorkBuddy 用量页面添加积分消耗总数、各模型积分消耗、产品/使用端分布、近 7 天趋势，并支持自选日期范围筛选统计
// @author       asdfz2
// @license      MIT
// @homepage     https://github.com/asdfz2/ai-credit-dashboard
// @supportURL   https://github.com/asdfz2/ai-credit-dashboard/issues
// @downloadURL  https://raw.githubusercontent.com/asdfz2/ai-credit-dashboard/main/trae-dashboard-enhancer.user.js
// @updateURL    https://raw.githubusercontent.com/asdfz2/ai-credit-dashboard/main/trae-dashboard-enhancer.user.js
// @match        https://www.trae.cn/dashboard*
// @match        https://trae.cn/dashboard*
// @match        https://qwenwork.cn/app/settings/usage*
// @match        https://www.qwenwork.cn/app/settings/usage*
// @match        https://www.workbuddy.cn/profile/plans-usage*
// @match        https://workbuddy.cn/profile/plans-usage*
// @match        https://www.workbuddy.cn/profile/credits-usage*
// @match        https://workbuddy.cn/profile/credits-usage*
// @icon         https://www.trae.cn/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_info
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    try {
        /* ================================================================== *
         * 0. 常量与通用工具
         * ================================================================== */

        const VERSION = '1.15.0';

        // 需要排查问题时把 DEBUG 改成 true，控制台会输出完整流程日志
        const DEBUG = false;
        const TAG = '[用量增强]';

        const log = (msg, ...args) => { if (DEBUG) console.log(TAG + ' ' + msg, ...args); };
        const warn = (msg, ...args) => console.warn(TAG + ' ' + msg, ...args);
        const fail = (msg, ...args) => console.error(TAG + ' ' + msg, ...args);

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        const num = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };

        // 取第一个「存在且非空」的字段值。
        // 这里刻意判 undefined / null / '' 而不是用 ||，否则合法的 0 会被回退到备用字段。
        const pick = (obj, keys) => {
            if (!obj) return undefined;
            for (let i = 0; i < keys.length; i++) {
                const v = obj[keys[i]];
                if (v !== undefined && v !== null && v !== '') return v;
            }
            return undefined;
        };

        const pad2 = (n) => String(n).padStart(2, '0');

        // 日期一律走本地自然日，不用 new Date('YYYY-MM-DD') / toISOString，避免 UTC 偏移
        const fmtDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
        const fmtDateTime = (d) => fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());

        // QwenWork DOM 提取共用的日期时间匹配。日期分隔符可为 - 或 /，日期与时间之间可为空格或 T，秒可省略
        const DATETIME_LOOSE_RE = /\d{4}[-/]\d{2}[-/]\d{2}[T\s]+\d{2}:\d{2}/;
        const DATETIME_LINE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})[T\s]+(\d{2}:\d{2})(?::\d{2})?$/;
        // 有些渲染方式会把「日期」和「时间」拆成两行
        const DATE_ONLY_LINE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
        const TIME_ONLY_LINE_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

        // 各平台会话字段别名。归一到同一套读取逻辑，同时兼容本地已有的历史数据。
        const FIELD = {
            id: ['session_id', 'requestId', 'record_id', '_recordKey'],
            credit: ['credits_float', 'amount_float', 'credits', 'credit'],
            time: ['usage_time', 'created_at', 'requestTime', 'request_time', 'time'],
            model: ['model_name', 'model', 'source']
        };

        const readSession = (s) => ({
            id: String(pick(s, FIELD.id) || ''),
            credit: num(pick(s, FIELD.credit)),
            time: pick(s, FIELD.time),
            model: String(pick(s, FIELD.model) || ''),
            // 只有平台真的提供了使用端字段时才参与「使用端分布」统计，
            // 否则 Trae 的会话会被算成一个「未知使用端」桶
            client: (s && Object.prototype.hasOwnProperty.call(s, 'client'))
                ? String(s.client || '')
                : undefined,
            // Buddy One 的产品维度（WorkBuddy / 腾讯文档 / ima / 腾讯网盘…）。
            // 旧记录没有这个字段，读取时保留 undefined，避免被空值覆盖。
            product: (s && Object.prototype.hasOwnProperty.call(s, 'product'))
                ? String(s.product || '')
                : undefined,
            purpose: String((s && (s.agentPurpose || s.purpose)) || ''),
            // 记录里可用的次级标识，用于把「未分类」聚合条目摊开
            detail: String(pick(s, ['session_name', 'detail']) || '')
        });

        // 采集到什么就展示什么：页面用短横线表示「未公布」，就原样展示短横线，不改写成别的说法
        const DASH_MODEL_RE = /^[—\-\u2014\u2013]+$/;
        // 模型名完全缺失时的占位文案。各平台可覆盖（Trae 页面在未指定模型时显示 auto）
        let MODEL_PLACEHOLDER = '（未标注）';

        // 未分类的聚合条目：模型名或使用端缺失时归入这些桶
        const FALLBACK_LABELS = ['未知使用端', '未知来源', '未知模型', '未分类'];
        const isFallbackLabel = (name) => {
            const n = String(name);
            return n === MODEL_PLACEHOLDER || FALLBACK_LABELS.indexOf(n) !== -1 || DASH_MODEL_RE.test(n);
        };

        // Buddy One 的产品维度：接口返回的 appType 是产品内部标识，展示名以官方文案为准。
        // 同一个产品在不同版本里出现过多种写法（docs / doc / tencentdocs），统一到一套标签。
        const PRODUCT_LABELS = {
            workbuddy: 'WorkBuddy',
            codebuddy: 'WorkBuddy',
            docs: '腾讯文档',
            doc: '腾讯文档',
            tencentdocs: '腾讯文档',
            ima: 'ima',
            drive: '腾讯网盘',
            netdisk: '腾讯网盘',
            netdrive: '腾讯网盘',
            meeting: '腾讯会议'
        };
        const productLabel = (key) => {
            const raw = String(key || '').trim();
            if (!raw) return '';
            return PRODUCT_LABELS[raw.toLowerCase()] || raw;
        };

        // 这些是脚本自己造的占位名，不是页面上真实存在的标识。
        // 若某个桶的下级只有一个占位项，展开没有任何信息量，干脆不渲染折叠控件。
        const PLACEHOLDER_LABELS = ['（无详情）', '未知来源', '未知使用端', '未知模型', '未分类'];
        const isPlaceholderLabel = (name) => {
            const n = String(name);
            return n === MODEL_PLACEHOLDER || PLACEHOLDER_LABELS.indexOf(n) !== -1;
        };

        // 展开状态按「平台 + 维度 + 条目」记录，重绘后恢复，避免用户每刷新一次就要重新点开
        const _openSubs = new Set();

        const CONFIG = {
            refreshInterval: 60000,
            maxAutoPages: 100,
            maxSessions: 5000,
            pageDelayMs: 300
        };

        // 数组顺序是采集顺序，不等于时间顺序（第 1 页最新，自动翻页把更早的接在后面）。
        // 上限截断必须先按时间排，否则 slice(-max) 丢掉的可能是较新的记录。
        const sessionTime = (s) => {
            const ts = parseTime(readSession(s).time);
            return ts > 0 ? ts : 0;
        };

        const trimSessionsByTime = (sessions) => {
            if (!Array.isArray(sessions) || sessions.length <= CONFIG.maxSessions) {
                return { sessions: sessions, trimmed: false };
            }
            sessions.sort((a, b) => sessionTime(a) - sessionTime(b));
            return { sessions: sessions.slice(-CONFIG.maxSessions), trimmed: true };
        };

        /* ================================================================== *
         * 1. 平台适配表
         *    每个平台声明：如何识别、数据放在哪个存储键、主题、命中哪些接口、
         *    如何把响应解析成会话、如何构造下一页请求、以及如何首次采集数据。
         * ================================================================== */

        const HOST = window.location.hostname;
        const PATH = window.location.pathname;

        const PLATFORMS = {
            /* ---------------- Trae：拦截 API + 自动翻页 ---------------- */
            trae: {
                id: 'trae',
                label: 'Trae',
                storageKey: 'trae_usage_data',
                themeClass: '',
                unitLabel: '会话',
                modelPlaceholder: 'auto（未标注）',
                // 2026-11 版 dashboard 把用量区改成单页 section，旧的 Tab 容器 id 已不存在。
                // 新页面给用量区留了稳定的 data-testid；`[role="tabpanel"]` 现在只会命中
                // 「已申请订单」这类无关区块，不能再当兜底，否则面板会插进别人的 Tab 里。
                mountSelectors: [
                    '[data-testid="user-entitlement-usage-management-content"]',
                    '[id$="-content-usage"]'
                ],
                detect: () => /(^|\.)trae\.cn$/.test(HOST) && PATH.indexOf('/dashboard') === 0,
                // 面板只在用量页显示。SPA 切路由时 pathname / hash 会变，显示与否要用实时值判断。
                // Trae 的各 Tab 通过 hash 切换（#usage / #account…），离开用量 Tab 即隐藏
                pagePath: '/dashboard',
                pageHash: 'usage',
                apiUrl: 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session',

                usageApi: (url) => !!url &&
                    /query_?user_?usage_?group_?by_?session/i.test(url),

                watchApi: (url) => !!url && ([
                    '/trae/api/v1/pay/',
                    '/trae/api/v2/pay/',
                    'user_current_entitlement_list',
                    'cn_credits_billing_status',
                    'web_user_pay_status',
                    'expired_ents'
                ].some((s) => url.indexOf(s) !== -1) ||
                    /query_?user_?usage_?group_?by_?session/i.test(url)),

                extract(payload) {
                    const root = (payload && payload.data && Array.isArray(payload.data.user_usage_group_by_sessions))
                        ? payload.data
                        : payload;
                    if (!root || !Array.isArray(root.user_usage_group_by_sessions)) return null;
                    return {
                        records: root.user_usage_group_by_sessions,
                        total: num(pick(root, ['total', 'count']))
                    };
                },

                // Trae 原样保留接口返回的会话对象（兼容本地已有存量数据）。
                // 其中 user_input_preview 是用户输入预览，面板从不展示，
                // 由 privateFields 统一负责从新老数据中清除。
                normalize: (raw) => raw,
                privateFields: ['user_input_preview'],

                extras(payload, store) {
                    let changed = false;
                    if (payload && Array.isArray(payload.user_entitlement_pack_list)) {
                        store.entitlement = payload;
                        changed = true;
                    }
                    if (payload && payload.is_credits_billing !== undefined) {
                        store.billing_status = payload;
                        changed = true;
                    }
                    return changed;
                },

                continueBody(body, page) {
                    const b = Object.assign({}, body || {});
                    // 实测真实分页字段是 page_num：早期用 page 会被服务端忽略、每页都返回第一页。
                    // 请求体里没有分页字段时也按 page_num 处理。
                    const field = ('page_num' in b) ? 'page_num' : (('page' in b) ? 'page' : 'page_num');
                    b[field] = page;
                    return b;
                },

                defaultBody() {
                    const end = new Date();
                    const start = new Date(end.getTime() - 29 * 86400000);
                    // 2026-11 版页面把起止时间改成「秒级数字」直接放进请求体。
                    // 旧版这里发的是 'YYYY-MM-DD HH:mm:ss' 字符串；没有捕获到页面请求时
                    // （首屏、直接打开 #usage），字符串会被新版接口拒掉。
                    return {
                        start_time: Math.floor(start.getTime() / 1000),
                        end_time: Math.floor(end.getTime() / 1000),
                        page_size: 20,
                        page_num: 1,
                        usage_type: [7]
                    };
                },

                // 自选区间的起止字段。该接口按本地时间字符串过滤，首尾各取整日边界，
                // 使「按日筛选」与面板口径一致（含结束日当天）
                rangeFields: (startDay, endDay) => ({
                    start_time: startDay + ' 00:00:00',
                    end_time: endDay + ' 23:59:59'
                }),

                step: 'click-then-fetch'
            },

            /* ---------------- QwenWork：DOM 文本提取 ---------------- */
            qwenwork: {
                id: 'qwenwork',
                label: 'QwenWork',
                storageKey: 'qwenwork_usage_data',
                themeClass: 'qwenwork-theme',
                unitLabel: '记录',
                // 插到第一张卡片所在「内容列」的最前面：与该列同宽（页面的 800px 内容列），
                // 且位于页面各分组之上，不会把「订阅套餐」这类小节标题与其卡片拆开
                mountSelectors: ['.rounded-2xl'],
                detect: () => /(^|\.)qwenwork\.cn$/.test(HOST) && PATH.indexOf('/app/settings/usage') === 0,
                pagePath: '/app/settings/usage',
                // QwenWork 用量接口返回 404，数据只能从页面 DOM 取
                apiUrl: null,
                usageApi: () => false,
                watchApi: () => false,
                extract: () => null,
                normalize: (raw) => raw,
                postFetch: async () => {
                    await bootstrapQwenwork();
                },
                note: '统计口径：页面「积分历史」中已加载的逐笔积分消耗记录。数据只存在本机浏览器。'
            },

            /* ---------------- WorkBuddy：拦截 API + 自动翻页 ---------------- */
            workbuddy: {
                id: 'workbuddy',
                label: 'WorkBuddy',
                storageKey: 'workbuddy_usage_data',
                themeClass: 'workbuddy-theme',
                unitLabel: '请求',
                // 2026-11 版把个人中心拆成「套餐与积分」(main.plans-usage) 与
                // 「积分用量」(main.credits-usage) 两个入口，后者常用于桌面端 iframe。
                mountSelectors: ['main.plans-usage', 'main.credits-usage'],
                detect: () => /(^|\.)workbuddy\.cn$/.test(HOST) &&
                    (PATH.indexOf('/profile/plans-usage') === 0 ||
                        PATH.indexOf('/profile/credits-usage') === 0),
                pagePaths: ['/profile/plans-usage', '/profile/credits-usage'],
                apiUrl: 'https://www.workbuddy.cn/billing/meter/get-user-request-usage',

                // 2026-10 起页面默认停在「积分概览」，只有切到「消耗明细」才挂载表格并发请求。
                // 因此不能再等页面自己发请求：首屏主动拉一次，页面请求只作为实时补充。
                bootstrapOnLoad: true,
                usageTabText: '消耗明细',
                reloadLabel: '刷新数据',
                // 面板增加「各产品积分消耗」一节；旧记录没有 product 字段时单独说明
                productDimension: true,
                // 鉴权头不只出现在用量接口上；同域的其它 billing 请求里也有，
                // 首屏没有用量请求时从这些请求借用（只放内存，不落盘）
                headerApi: (url) => !!url && url.indexOf('/billing/') !== -1,
                // 页面可能带着产品筛选（appTypes）发请求；面板口径是账号级，
                // 主动采集/区间补拉必须把这些筛选剥掉，否则只会拉到某一个产品
                stripRequestFields: ['appTypes', 'subscribeType'],
                // 页面默认 10 条/页；脚本自己从第 1 页开始请求，可以安全地抬高每页条数
                preferredPageSize: 200,
                // 企业版 v2 用 nextPageToken 翻页，没有 total；只在 WorkBuddy 上启用，
                // 避免其它平台请求体里恰好带 version: 2 时被误判
                tokenPagination: true,

                usageApi: (url) => !!url && url.indexOf('/billing/meter/get-user-request-usage') !== -1,

                // 只关心用量明细接口：其它 billing 接口的数据页面自己会展示，不做重复呈现
                watchApi: (url) => !!url && url.indexOf('/billing/meter/get-user-request-usage') !== -1,

                extract(payload) {
                    const d = payload && payload.data;
                    if (!d || !Array.isArray(d.data)) return null;
                    return {
                        records: d.data,
                        total: num(d.total),
                        // 企业版 v2 用 nextPageToken 翻页，没有 total
                        nextPageToken: d.nextPageToken ? String(d.nextPageToken) : ''
                    };
                },

                // 只保留统计需要的字段。
                // 接口同时返回 input / inputTrunc（用户提示词原文），这里刻意丢弃，不落盘。
                normalize(raw) {
                    if (!raw || typeof raw !== 'object') return null;
                    const product = typeof raw.appType === 'string' ? raw.appType.trim() : '';
                    const session = {
                        session_id: String(raw.requestId || '')
                    };
                    // 只写接口确实给出的字段。更新已有记录时 Object.assign 会保留
                    // 旧值；如果这里用 String(... || '') / num(undefined) 填默认值，
                    // 一条缺字段的返回就会把已有金额清零、客户端清空。
                    if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
                        session.model_name = String(raw.model);
                    }
                    if (raw.requestTime !== undefined && raw.requestTime !== null && raw.requestTime !== '') {
                        session.usage_time = String(raw.requestTime);
                    }
                    if (raw.credit !== undefined && raw.credit !== null && raw.credit !== '') {
                        session.credits_float = num(raw.credit);
                    }
                    if (raw.client !== undefined && raw.client !== null && raw.client !== '') {
                        session.client = String(raw.client);
                    }
                    if (raw.agentPurpose !== undefined && raw.agentPurpose !== null && raw.agentPurpose !== '') {
                        session.purpose = String(raw.agentPurpose);
                    }
                    // 只有接口真的给出 appType 时才写 product：
                    // 旧响应没有这个字段，写成空串会在合并时覆盖掉已经采集到的产品名
                    if (product) session.product = product;
                    return session;
                },

                continueBody(body, page) {
                    // 翻页必须沿用原来的 pageSize。改 pageSize 会同时改变偏移量：
                    // 例如首页按 10 条/页 取了 10 条，第 2 页若按 200 条/页 取，会直接跳过中间的数据。
                    const b = Object.assign({}, body || {});
                    b.pageNum = page;
                    return b;
                },

                defaultBody() {
                    const end = new Date();
                    const start = new Date(end.getTime() - 29 * 86400000);
                    return {
                        startTime: fmtDate(start) + ' 00:00:00',
                        endTime: fmtDate(end) + ' 23:59:59',
                        pageNum: 1,
                        pageSize: 200
                    };
                },

                rangeFields: (startDay, endDay) => ({
                    startTime: startDay + ' 00:00:00',
                    endTime: endDay + ' 23:59:59'
                }),

                // WorkBuddy 与 CodeBuddy 共用同一账号积分池；Buddy One 之后积分池
                // 又扩到腾讯文档 / ima / 腾讯网盘，因此面板口径是账号级。
                // 有产品字段时说明 Buddy One 口径，没有时保留旧文案，避免对未加入的用户说错话。
                note: (stats) => (stats && ((stats.productBreakdown || []).length > 0))
                    ? '统计口径：Buddy One 账号级用量，含 WorkBuddy / 腾讯文档 / ima / 腾讯网盘等产品；' +
                      '腾讯会议不消耗积分。数据只存在本机浏览器，不含对话内容。'
                    : '统计口径：账号级用量，含 WorkBuddy / CLI 等全部使用端。数据只存在本机浏览器，不含对话内容。'
            }
        };

        const PLATFORM = Object.keys(PLATFORMS)
            .map((k) => PLATFORMS[k])
            .find((p) => {
                try {
                    return p.detect();
                } catch (e) {
                    return false;
                }
            });

        // 不在支持的页面上，直接退出，不做任何注入
        if (!PLATFORM) return;

        // Trae 页面在未指定模型时显示 auto，占位文案与之对齐
        MODEL_PLACEHOLDER = PLATFORM.modelPlaceholder || MODEL_PLACEHOLDER;

        /* ================================================================== *
         * 2. 本地存储
         * ================================================================== */

        // 平台声明「永不落盘」的字段。除了在归一化时丢弃，还会对本地已有的存量记录做一次清理，
        // 否则旧版本写进去的用户内容会一直留在浏览器里。
        const PRIVATE_FIELDS = PLATFORM.privateFields || [];

        // 早期版本写入、现已废弃的存储键。它们没有读取方，但会在存量数据里继续占空间，
        // 因此每次落盘时顺手清掉（api_responses 曾用来存整份原始接口响应）。
        const RETIRED_STORE_KEYS = ['api_responses'];

        const DataStore = {
            // 同一页面会话内只读一次 GM 存储，后续读写都走这份内存副本。
            // Tampermonkey 的 GM_setValue/GM_getValue 是同步的，写后读立即可见；
            // 但 ScriptCat 的数据操作是异步的（写入经 IPC 落到 IndexedDB），同步的
            // GM_getValue 返回的缓存副本可能滞后于刚才的写入——一次采集中连续多次
            // 「读 → 合并 → 写」时，后面的合并会读到前面的合并之前的数据，
            // 同一批记录被当成新记录反复追加（千问统计翻倍的根因）。
            // 已知取舍：两个同平台标签页各自持有副本，后写的会覆盖先写的。
            cache: null,
            get() {
                if (this.cache === null) {
                    try {
                        const raw = GM_getValue(PLATFORM.storageKey, '{}');
                        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                        this.cache = (parsed && typeof parsed === 'object') ? parsed : {};
                    } catch (e) {
                        warn('本地数据解析失败，按空数据处理:', e);
                        this.cache = {};
                    }
                }
                return this.cache;
            },
            /**
             * 写入并返回成功状态。GM_setValue 在部分管理器（如 ScriptCat）上
             * 返回 Promise；这里保留同步布尔值，同时把 Promise 归一成
             * resolve(true) / resolve(false)，调用方按需 await。
             * @returns {boolean|Promise<boolean>}
             */
            set(store) {
                this.cache = store;
                try {
                    const result = GM_setValue(PLATFORM.storageKey, JSON.stringify(store));
                    if (result && typeof result.then === 'function') {
                        return result.then(() => true, (e) => {
                            warn('本地数据写入失败:', e);
                            return false;
                        });
                    }
                    return true;
                } catch (e) {
                    warn('本地数据写入失败:', e);
                    return false;
                }
            },
            sessions() {
                const s = this.get().usage_sessions;
                return Array.isArray(s) ? s : [];
            },
            count() {
                return this.sessions().length;
            }
        };

        /* ================================================================== *
         * 2.1 日期范围筛选状态
         *     区间用本地自然日 'YYYY-MM-DD' 表示，start / end 为 null 表示该侧不限。
         *     它是视图偏好而不是采集结果，所以单独占一个存储键：「重置本页数据」
         *     清空用量记录时不应连带把用户选的区间抹掉。
         * ================================================================== */

        const RANGE_KEY = PLATFORM.storageKey + '_range';

        // 预设芯片。「近 7 天」这类滚动区间只存 preset 标识，重新计算起止日，
        // 存具体日期的话隔天再打开就是「芯片写着近 7 天、统计的却是昨天那个窗口」
        const RANGE_PRESETS = [
            { id: '7d', label: '近 7 天' },
            { id: '30d', label: '近 30 天' },
            { id: 'month', label: '本月' },
            { id: 'all', label: '全部' }
        ];
        // 起止日期由用户手输时的 preset 标识，没有对应芯片，靠状态行显示区间
        const RANGE_CUSTOM = 'custom';

        const isRollingPreset = (id) => id === '7d' || id === '30d' || id === 'month';

        function presetRange(id) {
            const now = new Date();
            const todayStr = fmtDate(now);
            if (id === '7d' || id === '30d') {
                const start = new Date(now);
                start.setDate(start.getDate() - (id === '7d' ? 6 : 29));
                return { preset: id, start: fmtDate(start), end: todayStr };
            }
            if (id === 'month') {
                return {
                    preset: id,
                    start: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)),
                    end: todayStr
                };
            }
            return { preset: 'all', start: null, end: null };
        }

        let _range = { preset: 'all', start: null, end: null };

        // 自定义区间在输入框里的草稿值。面板按数据指纹重绘时会重建 DOM，
        // 靠它把用户已输入但尚未点「应用」的内容还原回去
        let _rangeDraft = { start: '', end: '' };

        // 存储里的起止日只接受形状正确、且真实存在的本地日期。这不是防御外部输入——
        // 这个键只有脚本自己写——而是手改过的存储会把任意字符串同时送进属性拼接与补拉
        // 请求体；2026-02-30 这类形状合法但日历不存在的值也会让区间窗口静默退化成「不限」。
        const safeDay = (v) => {
            if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
            return parseLocalDateKey(v) ? v : null;
        };

        function loadRange() {
            let saved = null;
            try {
                const raw = GM_getValue(RANGE_KEY, '');
                saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
            } catch (e) {
                saved = null;
            }
            const preset = saved && saved.preset;
            if (isRollingPreset(preset)) {
                _range = presetRange(preset);
            } else if (preset === RANGE_CUSTOM) {
                const rawStart = saved.start;
                const rawEnd = saved.end;
                const start = safeDay(rawStart);
                const end = safeDay(rawEnd);
                const hadStart = rawStart !== undefined && rawStart !== null && rawStart !== '';
                const hadEnd = rawEnd !== undefined && rawEnd !== null && rawEnd !== '';
                // 任一侧原本有值但无法解析，或起止倒序，都整体回落到「全部」。
                // 只丢掉坏的那一侧会让区间悄悄变宽/变窄，比不显示区间更难发现。
                if ((hadStart && !start) || (hadEnd && !end) || (start && end && start > end)) {
                    log('区间存储无效，回落到全部');
                    _range = presetRange('all');
                } else if (start || end) {
                    _range = { preset: RANGE_CUSTOM, start: start, end: end };
                } else {
                    _range = presetRange('all');
                }
            } else {
                _range = presetRange('all');
            }
            _rangeDraft = { start: _range.start || '', end: _range.end || '' };
        }

        function saveRange() {
            try {
                GM_setValue(RANGE_KEY, JSON.stringify(_range));
            } catch (e) {
                warn('区间筛选状态写入失败:', e);
            }
        }

        // 滚动区间只存 preset，起止日按「今天」重算。页面跨过午夜/月初后
        // _range 里的日期会过期；定时重绘前先补这一拍，避免芯片写着「近 7 天」
        // 实际还在统计昨天那个窗口。用户正在改草稿时不覆盖。
        function refreshRollingRange() {
            if (!isRollingPreset(_range.preset)) return false;
            const draftDirty = _rangeDraft.start !== (_range.start || '') ||
                _rangeDraft.end !== (_range.end || '');
            if (draftDirty) return false;
            const next = presetRange(_range.preset);
            if (next.start === _range.start && next.end === _range.end) return false;
            _range = next;
            _rangeDraft = { start: next.start || '', end: next.end || '' };
            saveRange();
            log('滚动区间已按今天重算:', next.start, '~', next.end);
            return true;
        }

        // 渲染指纹与持久化都用这一份签名：区间变了但记录数没变时也要重绘
        const rangeSignature = () => _range.preset + '|' + (_range.start || '') + '|' + (_range.end || '');

        const rangeLabel = (range) => {
            if (!range.start && !range.end) return '全部';
            return (range.start || '不限') + ' ~ ' + (range.end || '不限');
        };

        /**
         * 区间对应的时间窗口（毫秒）。起始取当天 00:00:00，结束取次日 00:00:00 的开区间，
         * 让「含结束日整天」与按日聚合的 dailyMap 口径一致。
         * @returns {{fromTs:number, toTs:number}|null} 起止都解析不了时返回 null（视为不筛选）
         */
        function rangeWindow(range) {
            const from = range.start ? parseLocalDateKey(range.start) : null;
            const to = range.end ? parseLocalDateKey(range.end) : null;
            if (!from && !to) return null;
            return {
                fromTs: from ? from.getTime() : -Infinity,
                toTs: to ? to.getTime() + 86400000 : Infinity
            };
        }

        /**
         * 按区间过滤本地记录。
         * 时间解析不出来的记录无法定位到哪一天，只能排除在区间统计之外，
         * 因此单独计数，由面板说明它们被略过的数量。
         */
        function applyRange(sessions, range) {
            const win = rangeWindow(range);
            if (!win) return { sessions: sessions, skippedNoTime: 0 };
            const kept = [];
            let skippedNoTime = 0;
            sessions.forEach((raw) => {
                const ts = parseTime(readSession(raw).time);
                if (ts <= 0) {
                    skippedNoTime++;
                    return;
                }
                if (ts >= win.fromTs && ts < win.toTs) kept.push(raw);
            });
            return { sessions: kept, skippedNoTime: skippedNoTime };
        }

        // 区间跨度（自然日，闭区间）。结束日按今天封顶：未来日期没有数据，
        // 计入分母只会把日均摊薄
        function rangeDayCount(range) {
            const from = range.start ? parseLocalDateKey(range.start) : null;
            const to = range.end ? parseLocalDateKey(range.end) : null;
            if (!from || !to) return 0;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const endTs = Math.min(to.getTime(), today.getTime());
            const days = Math.floor((endTs - from.getTime()) / 86400000) + 1;
            return days > 0 ? days : 0;
        }

        // 本地记录的起止日，用于判断所选区间是否落在已采集数据之外
        function collectedSpan(sessions) {
            let minTs = Infinity;
            let maxTs = -Infinity;
            sessions.forEach((raw) => {
                const ts = parseTime(readSession(raw).time);
                if (ts <= 0) return;
                if (ts < minTs) minTs = ts;
                if (ts > maxTs) maxTs = ts;
            });
            if (minTs === Infinity) return null;
            return { start: fmtDate(new Date(minTs)), end: fmtDate(new Date(maxTs)) };
        }

        /* ================================================================== *
         * 2.2 重置备份
         *     「重置本页数据」本质上是一次不可撤销的覆写。本地历史里早于平台保留
         *     窗口的那部分，页面之后再怎么重新采集也取不回来（补拉同样只能取回
         *     平台仍然保留的部分），所以重置前先把当前记录整份落到独立存储键，
         *     作为这一次重置的撤销点。
         * ================================================================== */

        const BACKUP_KEY = PLATFORM.storageKey + '_backup';

        // 形状不对或条数为空都按「没有备份」处理：这个键只由脚本自己写，
        // 真读不出来时宁可让页脚少一个按钮，也不要拿一份残缺数据去合并
        function readBackup() {
            let raw = '';
            try {
                raw = GM_getValue(BACKUP_KEY, '');
            } catch (e) {
                warn('重置备份读取失败:', e);
                return null;
            }
            if (!raw) return null;
            let parsed = null;
            try {
                parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            } catch (e) {
                warn('重置备份解析失败，按无备份处理:', e);
                return null;
            }
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.sessions) || !parsed.sessions.length) return null;
            return parsed;
        }

        /**
         * 写入重置备份。
         * @returns {boolean|Promise<boolean>} 是否写成功。失败时调用方必须中止重置——
         *                   没有撤销点的清空不能放行，宁可让用户手动去油猴存储里留一份。
         *                   部分管理器返回 Promise，调用方需要 await。
         */
        function writeBackup(sessions) {
            try {
                const result = GM_setValue(BACKUP_KEY, JSON.stringify({
                    platform: PLATFORM.id,
                    version: VERSION,
                    at: Date.now(),
                    sessions: sessions
                }));
                if (result && typeof result.then === 'function') {
                    return result.then(() => true, (e) => {
                        fail('重置备份写入失败:', e);
                        return false;
                    });
                }
                return true;
            } catch (e) {
                fail('重置备份写入失败:', e);
                return false;
            }
        }

        function clearBackup() {
            try {
                const result = GM_setValue(BACKUP_KEY, '');
                if (result && typeof result.then === 'function') {
                    return result.then(() => true, (e) => {
                        warn('重置备份清除失败:', e);
                        return false;
                    });
                }
                return true;
            } catch (e) {
                warn('重置备份清除失败:', e);
                return false;
            }
        }

        /**
         * 把备份合并回当前存储。按记录 ID 去重，且**不覆盖**当前已有的记录：
         * 备份是重置那一刻的旧值，而重置后重新采集到的同一会话可能已经是更新的
         * 一次消耗，回退成旧值等于用一次旧数据污染新数据。
         *
         * 写入失败时回滚内存副本并保留备份：没有落盘的「已补回」不能当成成功。
         * @returns {Promise<{added:number, total:number, trimmed:boolean, ok:boolean}>}
         */
        async function restoreBackup(backup) {
            const store = DataStore.get();
            if (!Array.isArray(store.usage_sessions)) store.usage_sessions = [];
            const before = store.usage_sessions.slice();

            const index = new Set();
            store.usage_sessions.forEach((s) => {
                const id = readSession(s).id;
                if (id) index.add(id);
            });

            let added = 0;
            backup.sessions.forEach((s) => {
                if (!s || typeof s !== 'object') return;
                const id = readSession(s).id;
                if (!id || index.has(id)) return;
                index.add(id);
                store.usage_sessions.push(s);
                added++;
            });

            // 备份里的记录接在数组尾部，追加顺序不等于时间顺序（分页会把更早的记录
            // 接在后面）。先按时间排一遍，再交给统一的上限截断，保证丢的是最旧的。
            store.usage_sessions.sort((a, b) => sessionTime(a) - sessionTime(b));
            const trimmed = trimSessionsByTime(store.usage_sessions);
            store.usage_sessions = trimmed.sessions;

            // 不动 store.meta.lastUpdate：它展示的是「数据更新时间」，
            // 补回一批旧记录不构成数据变新了，改它等于让面板显示一个假的更新时间
            const ok = await DataStore.set(store);
            if (!ok) {
                // DataStore.set 已经把 cache 指向这份未落盘的数据；回滚，
                // 避免面板显示一批实际写不进去的记录
                store.usage_sessions = before;
            }
            return {
                added: added,
                total: store.usage_sessions.length,
                trimmed: trimmed.trimmed,
                ok: ok
            };
        }

        /* ================================================================== *
         * 3. 数据合并
         * ================================================================== */

        let _lastApiRequest = { url: '', method: 'POST', body: {}, headers: {} };
        // 最近一次同域 billing 请求（不一定是用量接口）。新版页面首屏不请求用量明细，
        // 主动采集需要从这里借用 X-Client-Platform / X-Enterprise-Id 等请求头。
        // 只放内存，绝不写入本地存储。
        let _lastBillingRequest = { url: '', headers: {}, at: 0 };
        // 页面自己最近一次发出用量请求的时间：主动采集前用它判断是否还需要重复请求
        let _lastUsageCaptureAt = 0;
        let _rawFetch = null;
        let _interceptorInstalled = false;

        // 翻页占位放在内存里，不写入本地存储。
        // 历史缺陷：曾把 _autoFetching 持久化，翻页中途关标签页会导致它永久为真、自动翻页从此失效。
        const _pagingInFlight = new Set();

        const isSuccessPayload = (p) => {
            if (!p) return false;
            if (p.success === true) return true;
            if (p.code === undefined) return true;
            const code = (typeof p.code === 'string' && p.code.trim() !== '')
                ? Number(p.code)
                : p.code;
            return code === 0 || code === 200;
        };

        function sanitizeHeaders(headers) {
            const blocked = new Set([
                'content-length', 'host', 'connection', 'accept-encoding', 'cookie', 'set-cookie'
            ]);
            const out = {};
            Object.keys(headers || {}).forEach((key) => {
                if (blocked.has(String(key).toLowerCase())) return;
                out[key] = headers[key];
            });
            return out;
        }

        /**
         * 脚本自己发用量请求时用的请求头。
         * 优先复用量接口自己发过的那一份；首屏没有用量请求时，退到最近一次 billing 请求
         * （页面加载时会请求余额/资源等接口，X-Client-Platform 就在里面）。
         * 鉴权仍靠 credentials: 'include' 的 Cookie，这里只补齐平台标识类请求头。
         */
        function usageRequestHeaders() {
            const primary = (_lastApiRequest.headers && Object.keys(_lastApiRequest.headers).length)
                ? _lastApiRequest.headers
                : (_lastBillingRequest.headers || {});
            const sanitized = sanitizeHeaders(primary);
            // 统一小写，避免页面给的 content-type 与这里补的 Content-Type 同时出现
            const headers = {};
            Object.keys(sanitized).forEach((key) => {
                headers[String(key).toLowerCase()] = sanitized[key];
            });
            if (!headers['content-type']) headers['content-type'] = 'application/json';
            // 只有声明了 headerApi 的平台（WorkBuddy）才补这个平台标识；
            // Trae 是跨域接口，平白多一个自定义头会触发额外的 CORS 预检
            if (PLATFORM.headerApi && !headers['x-client-platform']) {
                headers['x-client-platform'] = 'web';
            }
            return headers;
        }

        function computePagination(total, requestBody, records, nextPageToken) {
            const b = requestBody || {};
            const currentPage = num(pick(b, ['pageNum', 'page_num', 'PageNumber', 'page', 'CurrentPage'])) || 1;
            const requestedPageSize = num(pick(b, ['pageSize', 'page_size', 'PageSize', 'limit'])) || records.length || 20;
            // 服务端可能把 pageSize 钳到更小的值。用首屏实际返回条数校正，
            // 否则按请求值算 totalPages 会少算页数，后面的数据永远拉不到。
            const pageSize = (records.length > 0 && records.length < requestedPageSize)
                ? records.length
                : requestedPageSize;
            // 企业版 v2 没有 total，用 nextPageToken 串下一页；不能再用 pageNum 自增，
            // 否则第二页开始就会请求同一份数据（服务端忽略 pageNum）
            if (PLATFORM.tokenPagination && (nextPageToken || num(b.version) === 2)) {
                return {
                    mode: 'token',
                    currentPage: 1,
                    pageSize,
                    total: 0,
                    totalPages: 0,
                    discovery: true,
                    nextPageToken: nextPageToken || ''
                };
            }
            const t = num(total);
            // 接口没给总条数时转为「自发现翻页」，靠空页 / 连续多页无新增终止
            const totalPages = t > 0
                ? Math.max(1, Math.ceil(t / Math.max(pageSize, 1)))
                : currentPage + CONFIG.maxAutoPages;
            return { mode: 'page', currentPage, pageSize, total: t, totalPages, discovery: t <= 0 };
        }

        /**
         * 合并一份用量响应。返回 { added, updated, parsed } 或 null（无法解析时）。
         * options.skipPagination 为真时不再触发翻页，避免翻页循环里递归翻页。
         */
        function mergePayload(url, payload, requestBody, options) {
            const opts = options || {};
            if (!isSuccessPayload(payload)) {
                log('响应非成功状态，忽略:', payload && payload.code);
                return null;
            }

            const store = DataStore.get();
            if (!Array.isArray(store.usage_sessions)) store.usage_sessions = [];

            const parsed = PLATFORM.extract(payload);
            let added = 0;
            let updated = 0;
            let shouldWrite = false;

            const recordsEqual = (a, b) => {
                try {
                    return JSON.stringify(a) === JSON.stringify(b);
                } catch (e) {
                    return false;
                }
            };

            if (parsed && parsed.records.length) {
                const index = new Map();
                store.usage_sessions.forEach((s, i) => {
                    const id = readSession(s).id;
                    if (id) index.set(id, i);
                });

                parsed.records.forEach((raw) => {
                    if (!raw || typeof raw !== 'object') return;
                    let session;
                    try {
                        session = PLATFORM.normalize(raw);
                    } catch (e) {
                        warn('单条记录解析失败，已跳过:', e);
                        return;
                    }
                    if (!session) return;
                    const id = readSession(session).id;
                    if (!id) return;
                    const prev = index.get(id);
                    if (prev === undefined) {
                        index.set(id, store.usage_sessions.length);
                        store.usage_sessions.push(session);
                        added++;
                    } else {
                        // 同一会话的最新版本覆盖旧值。更新也要触发落盘与重绘，
                        // 否则 WorkBuddy 的 product 回填、Trae 的会话金额变化只会留在内存里。
                        const next = Object.assign({}, store.usage_sessions[prev], session);
                        if (!recordsEqual(next, store.usage_sessions[prev])) {
                            store.usage_sessions[prev] = next;
                            updated++;
                        }
                    }
                });

                const trimmed = trimSessionsByTime(store.usage_sessions);
                store.usage_sessions = trimmed.sessions;
            }

            const extrasChanged = PLATFORM.extras ? PLATFORM.extras(payload, store) === true : false;

            // 清理存量数据里由旧版本写入的私有字段
            let scrubbed = false;
            if (PRIVATE_FIELDS.length) {
                store.usage_sessions.forEach((s) => {
                    if (!s || typeof s !== 'object') return;
                    PRIVATE_FIELDS.forEach((k) => {
                        if (Object.prototype.hasOwnProperty.call(s, k)) {
                            delete s[k];
                            scrubbed = true;
                        }
                    });
                });
            }

            if (added > 0 || updated > 0 || extrasChanged || scrubbed) shouldWrite = true;

            RETIRED_STORE_KEYS.forEach((k) => {
                if (Object.prototype.hasOwnProperty.call(store, k)) {
                    delete store[k];
                    shouldWrite = true;
                }
            });

            if (shouldWrite) {
                store.meta = Object.assign({}, store.meta, {
                    platform: PLATFORM.id,
                    lastUpdate: Date.now(),
                    lastUrl: url
                });
                DataStore.set(store);
            }

            if (!opts.skipPagination && parsed && parsed.records.length > 0) {
                const info = computePagination(parsed.total, requestBody, parsed.records, parsed.nextPageToken);
                if (info.mode === 'token') {
                    if (info.nextPageToken) fetchAllPages(url, requestBody, info);
                } else if (info.totalPages > info.currentPage) {
                    fetchAllPages(url, requestBody, info);
                }
            }

            return { added, updated, parsed };
        }

        async function fetchAllPages(baseUrl, requestBody, info) {
            const tokenMode = info.mode === 'token';
            const sig = (tokenMode ? 'token:' : 'page:') + JSON.stringify(requestBody || {});
            if (_pagingInFlight.has(sig)) {
                log('该时间范围已在翻页中，跳过');
                return;
            }
            _pagingInFlight.add(sig);
            const doFetch = _rawFetch || window.fetch.bind(window);
            const lastPage = Math.min(info.totalPages, info.currentPage + CONFIG.maxAutoPages);
            let token = info.nextPageToken || '';
            const seenTokens = new Set();
            let noNewStreak = 0;
            let lastPageSig = '';
            log('开始自动翻页: ' + (tokenMode ? 'pageToken 模式' : '当前 ' + info.currentPage + '/' + lastPage) +
                (info.discovery && !tokenMode ? '（自发现模式）' : ''));

            try {
                for (let step = 0; step < CONFIG.maxAutoPages; step++) {
                    let body;
                    if (tokenMode) {
                        if (!token || seenTokens.has(token)) break;
                        seenTokens.add(token);
                        // v2 只认 pageToken；pageNum 会被忽略或报错，必须去掉
                        body = Object.assign({}, requestBody, { pageToken: token });
                        delete body.pageNum;
                        if (num(body.version) !== 2) body.version = 2;
                    } else {
                        const page = info.currentPage + 1 + step;
                        if (page > lastPage) break;
                        body = PLATFORM.continueBody(requestBody, page);
                    }
                    let payload;
                    try {
                        const resp = await doFetch(baseUrl, {
                            method: 'POST',
                            credentials: 'include',
                            headers: usageRequestHeaders(),
                            body: JSON.stringify(body)
                        });
                        if (!resp.ok) {
                            warn('翻页请求失败，HTTP ' + resp.status + '，已停止');
                            break;
                        }
                        payload = await resp.json();
                    } catch (e) {
                        warn('翻页请求异常，已停止:', e);
                        break;
                    }
                    const r = mergePayload(baseUrl, payload, body, { skipPagination: true });
                    const pageRecords = (r && r.parsed && r.parsed.records) || [];
                    log('已取' + (tokenMode ? '下一页' : '第 ' + (info.currentPage + 1 + step) + ' 页') +
                        '，新增 ' + (r ? r.added : 0) + ' 条，更新 ' + (r ? r.updated : 0) + ' 条');
                    if (!r) break;
                    if (pageRecords.length === 0) {
                        log('本页没有记录，停止翻页');
                        break;
                    }

                    // 「本页没有新增」不等于「没有下一页」：本地可能已经有这一页
                    // （上次翻页中断），后面仍可能有新数据。分页是否结束只由
                    // total / pageToken / 空页决定；自发现模式允许连续几页重复再停。
                    if (!tokenMode) {
                        const pageSig = pageRecords.map((raw) => readSession(raw).id).join('|');
                        if (pageSig && pageSig === lastPageSig) {
                            log('接口返回了与上一页相同的数据，停止翻页');
                            break;
                        }
                        lastPageSig = pageSig;
                    }
                    if (r.added === 0) {
                        noNewStreak++;
                        if (!tokenMode && info.discovery && noNewStreak >= 3) {
                            log('连续 3 页无新增，停止自发现翻页');
                            break;
                        }
                    } else {
                        noNewStreak = 0;
                    }
                    if (tokenMode) {
                        token = (r.parsed && r.parsed.nextPageToken) || '';
                        if (!token) break;
                    }
                    await sleep(CONFIG.pageDelayMs);
                }
            } finally {
                _pagingInFlight.delete(sig);
            }
            renderDashboard();
        }

        /* ================================================================== *
         * 4. 网络拦截
         * ================================================================== */

        function parseRequestBody(body) {
            if (!body) return {};
            if (typeof body === 'string') {
                try {
                    return JSON.parse(body);
                } catch (e) {
                    return {};
                }
            }
            if (body instanceof URLSearchParams) {
                const obj = {};
                body.forEach((v, k) => { obj[k] = v; });
                return obj;
            }
            if (typeof body === 'object') return body;
            return {};
        }

        function normalizeHeaders(headers) {
            const out = {};
            if (!headers) return out;
            if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                headers.forEach((v, k) => { out[k] = v; });
            } else if (Array.isArray(headers)) {
                headers.forEach((pair) => { out[pair[0]] = pair[1]; });
            } else if (typeof headers === 'object') {
                Object.keys(headers).forEach((k) => { out[k] = headers[k]; });
            }
            return out;
        }

        function handleResponse(url, reqInfo, payloadPromise) {
            payloadPromise
                .then((payload) => {
                    mergePayload(url, payload, reqInfo && reqInfo.body);
                    renderDashboard();
                })
                .catch(() => { });
        }

        function setupNetworkInterceptor() {
            if (_interceptorInstalled) return;
            _interceptorInstalled = true;
            log('安装网络拦截器…');

            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                _rawFetch = originalFetch.bind(window);
                window.fetch = function (input, init) {
                    const url = typeof input === 'string' ? input : ((input && input.url) || '');
                    const headers = normalizeHeaders((init && init.headers) || (input && input.headers));
                    const reqInfo = {
                        url,
                        method: (init && init.method) || 'GET',
                        body: PLATFORM.usageApi(url) ? parseRequestBody(init && init.body) : {},
                        headers
                    };
                    if (PLATFORM.headerApi && PLATFORM.headerApi(url)) {
                        _lastBillingRequest = { url, headers, at: Date.now() };
                    }
                    if (PLATFORM.usageApi(url)) {
                        _lastApiRequest = reqInfo;
                        _lastUsageCaptureAt = Date.now();
                    }

                    const result = originalFetch.apply(this, arguments);
                    if (PLATFORM.watchApi(url)) {
                        handleResponse(url, reqInfo, result.then((resp) => resp.clone().json()));
                    }
                    return result;
                };
            }

            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

            XMLHttpRequest.prototype.open = function (method, url) {
                this._teeMethod = method;
                this._teeUrl = typeof url === 'string' ? url : ((url && url.url) || '');
                this._teeHeaders = {};
                return originalOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
                if (this._teeUrl && PLATFORM.headerApi && PLATFORM.headerApi(this._teeUrl) && this._teeHeaders) {
                    this._teeHeaders[String(key).toLowerCase()] = value;
                }
                return originalSetRequestHeader.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function (body) {
                const url = this._teeUrl;
                if (url && PLATFORM.headerApi && PLATFORM.headerApi(url)) {
                    _lastBillingRequest = { url, headers: this._teeHeaders || {}, at: Date.now() };
                }
                if (url && PLATFORM.watchApi(url)) {
                    const reqInfo = {
                        url,
                        method: this._teeMethod,
                        body: PLATFORM.usageApi(url) ? parseRequestBody(body) : {},
                        headers: this._teeHeaders || {}
                    };
                    if (PLATFORM.usageApi(url)) {
                        _lastApiRequest = reqInfo;
                        _lastUsageCaptureAt = Date.now();
                    }
                    this.addEventListener('load', function () {
                        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                        let payload;
                        try {
                            payload = this.responseType === 'json'
                                ? this.response
                                : JSON.parse(this.responseText);
                        } catch (e) {
                            warn('XHR 响应不是可解析的 JSON，已忽略:', e);
                            return;
                        }
                        try {
                            mergePayload(reqInfo.url, payload, reqInfo.body);
                            renderDashboard();
                        } catch (e) {
                            warn('XHR 用量响应处理失败:', e);
                        }
                    });
                }
                return originalSend.apply(this, arguments);
            };
        }

        /* ================================================================== *
         * 5. 主动采集（拦截未命中时的兜底）与按区间补拉
         * ================================================================== */

        // 区间控件下方那一行提示（补拉进度 / 补拉结果 / 输入校验）。只放内存：
        // 它描述的是「刚刚发生了什么」，落盘后下次打开会显示一条早已结束的进度
        let _rangeHint = { active: false, text: '' };
        // 最近一次区间补拉实际发出的 url 与请求体，同样只放内存。
        // 诊断信息靠它对照「页面自己发的参数」与「脚本替换后的参数」的形态差异
        let _lastRangeRequest = null;
        // 本次页面会话里已经补拉过的区间。补拉成功（包括确实 0 条）后记下，
        // 避免反复点同一个区间反复打接口；失败不记，允许用户重试。
        const _rangeFetched = new Set();

        // 用量接口的一次 POST 请求。主动采集与区间补拉共用，请求头复用页面自己发过的
        // 那一份（鉴权字段是现成的，脚本无从伪造）。
        // 返回 { ok, reason, added, updated }：reason 是给用户看的一句话，只描述请求层面发生了什么
        // （HTTP 状态、接口业务码、异常名），不带响应体——响应体里可能有用户输入。
        async function postUsageRequest(url, body) {
            const doFetch = _rawFetch || window.fetch.bind(window);
            const headers = usageRequestHeaders();
            try {
                const resp = await doFetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: JSON.stringify(body)
                });
                if (!resp.ok) {
                    warn('用量请求失败，HTTP ' + resp.status);
                    return { ok: false, reason: 'HTTP ' + resp.status };
                }
                const payload = await resp.json();
                if (!isSuccessPayload(payload)) {
                    warn('用量接口返回失败码:', payload && payload.code, payload && payload.msg);
                    return {
                        ok: false,
                        reason: '接口返回 code=' + (payload && payload.code !== undefined ? payload.code : '(无)')
                    };
                }
                const merged = mergePayload(url, payload, body);
                return {
                    ok: true,
                    reason: '',
                    added: merged ? merged.added : 0,
                    updated: merged ? merged.updated : 0
                };
            } catch (e) {
                warn('用量请求异常:', e);
                return { ok: false, reason: '请求异常 ' + ((e && e.name) || '') };
            }
        }

        // mergePayload 触发的自动翻页是即发即走的，请求方拿不到它的结束时机。
        // 翻页占位在内存的 _pagingInFlight 里，用它轮询到收敛（每页间隔 300ms，
        // 单轮上限 100 页，60 秒足够走完一轮）
        async function waitForPaging(timeoutMs) {
            const deadline = Date.now() + (timeoutMs || 60000);
            while (_pagingInFlight.size > 0 && Date.now() < deadline) {
                await sleep(400);
            }
        }

        /**
         * 构造脚本自己发出的请求体：以页面请求为模板，从第 1 页开始。
         * - WorkBuddy 的页面可能带产品筛选，主动采集要剥掉，保证账号级口径
         * - 从第 1 页开始请求时改 pageSize 不会造成偏移，可以抬到平台偏好值
         * - 企业版 v2 只认 pageToken，必须清掉 pageNum
         */
        function prepareUsageBody(base, injected) {
            const merged = Object.assign({}, base || {}, injected || {});
            const body = PLATFORM.continueBody(merged, 1);
            (PLATFORM.stripRequestFields || []).forEach((key) => { delete body[key]; });
            // 企业版 v2 的 pageSize 由页面自己决定（常见 10/20/50）。v2 请求刻意保持原值：
            // 抬高 pageSize 在 v2 上没有收益，还可能被服务端拒绝；v1 从第 1 页开始则安全。
            const tokenV2 = PLATFORM.tokenPagination && num(body.version) === 2;
            if (PLATFORM.preferredPageSize && !tokenV2) body.pageSize = PLATFORM.preferredPageSize;
            if (tokenV2) {
                body.pageToken = '';
                delete body.pageNum;
            }
            return body;
        }

        // 新版 WorkBuddy 把用量表收进了「消耗明细」tab。直连接口失败时，
        // 点一下这个 tab 让页面自己发请求，作为兜底（只点一次，避免反复触发埋点）
        let _usageTabClicked = false;
        // 主动采集进行中：重试循环不要同时去点 tab，避免两路请求互相干扰
        let _bootstrapInFlight = false;
        function openUsageTab() {
            if (!PLATFORM.usageTabText || _usageTabClicked) return false;
            const candidates = document.querySelectorAll('[role="tablist"] button, button');
            for (let i = 0; i < candidates.length; i++) {
                const btn = candidates[i];
                if ((btn.textContent || '').trim() !== PLATFORM.usageTabText) continue;
                try {
                    btn.click();
                    _usageTabClicked = true;
                    log('已切换到「' + PLATFORM.usageTabText + '」');
                    return true;
                } catch (e) {
                    warn('切换「' + PLATFORM.usageTabText + '」失败:', e);
                    return false;
                }
            }
            return false;
        }

        async function bootstrapPlatformInner(opts) {
            const force = !!(opts && opts.force);
            if (PLATFORM.postFetch) {
                try {
                    await PLATFORM.postFetch();
                } catch (e) {
                    warn('页面数据提取失败:', e);
                }
                renderDashboard();
                return { ok: true, added: 0 };
            }
            if (!PLATFORM.apiUrl || !PLATFORM.defaultBody) return { ok: false, reason: '平台未声明接口' };
            if (!force && DataStore.count() > 0) {
                log('已有本地数据，跳过主动采集');
                return { ok: true, skipped: true };
            }

            // 优先复用页面自己发过的请求（参数与鉴权头都是现成的），否则用平台默认参数
            const captured = (_lastApiRequest.url && _lastApiRequest.body &&
                Object.keys(_lastApiRequest.body).length) ? _lastApiRequest : null;
            const url = captured ? captured.url : PLATFORM.apiUrl;
            const base = captured ? captured.body : PLATFORM.defaultBody();
            const body = prepareUsageBody(base);
            if (!body || Object.keys(body).length === 0) {
                log('拿不到可用的请求参数，跳过主动采集');
                return { ok: false, reason: '拿不到可用的请求参数' };
            }

            log('主动采集:', url, body);
            const res = await postUsageRequest(url, body);
            // 先渲染第一页，再等分页跑完；否则大区间要等几十页才看得到数字
            renderDashboard();
            if (res.ok && PLATFORM.bootstrapOnLoad) {
                // 让自动翻页跑完再交回渲染，避免用户看到第一页就先下结论
                await waitForPaging(30000);
            }
            if (!res.ok && PLATFORM.usageTabText && openUsageTab()) {
                log('主动采集失败，已切到「' + PLATFORM.usageTabText + '」触发页面请求');
                await sleep(1500);
            }
            renderDashboard();
            return res;
        }

        async function bootstrapPlatform(opts) {
            if (_bootstrapInFlight) return { ok: false, reason: '正在采集' };
            _bootstrapInFlight = true;
            try {
                return await bootstrapPlatformInner(opts);
            } finally {
                _bootstrapInFlight = false;
            }
        }

        /**
         * 把区间起止值改成页面请求体里同名字段的形态。
         * 页面自己发出去的那份参数是唯一的格式依据：Trae 记录里的 time 是秒级数字，
         * 起止字段同样是数字，而 rangeFields 给的是 'YYYY-MM-DD HH:mm:ss' 字符串，
         * 类型不符时服务端直接拒掉请求（Trae 实测确认后改为此处跟随形态）。
         * 数字字段按已有值的量级还原成秒或毫秒。
         */
        function matchRequestShape(base, injected) {
            const out = Object.assign({}, injected);
            Object.keys(injected).forEach((key) => {
                const existing = base ? base[key] : undefined;
                if (typeof existing !== 'number') return;
                const ms = parseTime(injected[key]);
                if (!ms) return;
                out[key] = existing > 946684800000 ? ms : Math.floor(ms / 1000);
            });
            return out;
        }

        /**
         * 按所选区间主动向接口取数（Trae / WorkBuddy）。
         * 面板默认只覆盖页面自身请求触及的范围（通常最近 30 天），不补拉的话，
         * 选更早的区间等于在筛一份本来就不存在的数据。
         * QwenWork 没有可用接口（PLATFORM.rangeFields 缺失），只能筛本地已采集记录。
         */
        async function requestUsageRange(range) {
            if (!PLATFORM.rangeFields || !PLATFORM.apiUrl) return false;

            const span = collectedSpan(DataStore.sessions());
            // 单侧不限时补一个能请求的边界：结束侧取今天，起始侧取本地已有的最早记录日，
            // 一条记录都没有就退到最近 30 天——不造跨越上千年的窗口
            const startDay = range.start ||
                (span ? span.start : fmtDate(new Date(Date.now() - 29 * 86400000)));
            const endDay = range.end || fmtDate(new Date());
            const requestSig = (range.preset || RANGE_CUSTOM) + '|' +
                (range.start || '') + '|' + (range.end || '');

            if (_rangeFetched.has(requestSig)) {
                log('该区间本次会话已补拉过，跳过');
                return false;
            }

            // 区间已被本地数据覆盖时才跳过；「span 覆盖」不等于「这段真的采过」，
            // 所以要求区间内至少有一条本地记录。否则先补拉 1 月、再补拉 3 月后，
            // 选 2 月会被误判为已覆盖，静默显示 0。
            const localInRange = applyRange(DataStore.sessions(), range).sessions.length;
            if (span && localInRange > 0 &&
                startDay >= span.start && endDay <= span.end) {
                log('所选区间已被本地记录覆盖，跳过补拉');
                return false;
            }

            // 有 rangeFields 的平台必然声明了 defaultBody，参数缺失时用它兜底
            const base = (_lastApiRequest.body && Object.keys(_lastApiRequest.body).length)
                ? _lastApiRequest.body
                : PLATFORM.defaultBody();

            // 只替换起止与分页起点，其余参数沿用页面请求体（如 Trae 的 usage_type）。
            // WorkBuddy 的产品筛选（appTypes）在这里会被 prepareUsageBody 剥掉：
            // 面板是账号级口径，不能因为页面选了某个产品就把补拉限制在该产品内。
            const injected = PLATFORM.rangeFields(startDay, endDay);
            const body = prepareUsageBody(base, matchRequestShape(base, injected));
            const url = _lastApiRequest.url || PLATFORM.apiUrl;

            // 记下这次真正发出去的参数形态，供「复制诊断信息」排查字段格式问题
            _lastRangeRequest = { url: url, body: body };
            log('按区间补拉:', url, body);
            _rangeHint = { active: true, text: '正在拉取 ' + startDay + ' ~ ' + endDay + ' 的分页数据…' };
            renderDashboard(true);
            const res = await postUsageRequest(url, body);
            await waitForPaging();

            // 区间内本来就没有记录与补到了新数据是两回事，文案要分开：
            // 前者是「这段时间没消耗」，后者才是「数据已到位」
            if (res.ok) {
                _rangeFetched.add(requestSig);
                _rangeHint = {
                    active: false,
                    text: res.added > 0
                        ? '已按区间补拉，新增 ' + res.added + ' 条，本地共 ' + DataStore.count() + ' 条记录'
                        : (res.updated > 0
                            ? '已按区间补拉，刷新 ' + res.updated + ' 条已有记录，本地共 ' + DataStore.count() + ' 条记录'
                            : (localInRange > 0
                                ? '区间内已有记录均为最新，本地共 ' + DataStore.count() + ' 条记录'
                                : '该区间内没有消耗记录，本地共 ' + DataStore.count() + ' 条记录'))
                };
            } else {
                _rangeHint = {
                    active: false,
                    text: '区间补拉失败（' + res.reason + '），当前数字仅基于本地已采集的记录'
                };
            }
            renderDashboard(true);
            return res.ok;
        }

        // 所选区间是否超出本地数据覆盖范围，决定面板要不要提示「区间外没有数据」。
        // 能补拉的平台（有 rangeFields）不在这里提示——补拉结果由 _rangeHint 说明
        function rangeCoverage(range, sessions) {
            if (!range.start && !range.end) return null;
            if (PLATFORM.rangeFields) return null;
            const span = collectedSpan(sessions);
            if (!span) return '本地还没有任何用量记录，先在页面上加载一次数据';
            // 'YYYY-MM-DD' 定长零填充，字典序即日期序，不必再经 Date 解析（避免 UTC 偏移）
            const fromDay = range.start || span.start;
            const toDay = range.end || span.end;
            if (toDay < span.start || fromDay > span.end) {
                return '所选区间与本地已采集的记录（' + span.start + ' ~ ' + span.end +
                    '）没有交集，统计为 0';
            }
            if (fromDay < span.start) {
                return '该平台没有可用的用量接口，区间中早于 ' + span.start +
                    ' 的部分无法补拉，统计只含本地已采集的记录';
            }
            return null;
        }

        // 通过点击页面上的时间范围按钮，触发页面自己发起用量请求
        function triggerTimeRangeButtons() {
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            const selectors = [
                'button:not([disabled])',
                '[role="tab"]:not([disabled])',
                '.ant-radio-button-wrapper',
                '.el-radio-button__inner',
                '[class*="time"]',
                '[class*="range"]'
            ];
            for (const sel of selectors) {
                const buttons = document.querySelectorAll(sel);
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    if (txt.includes('30') || txt.includes('月') || txt.includes('近')) {
                        setTimeout(() => {
                            try {
                                btn.click();
                                window.scrollTo(scrollX, scrollY);
                                log('已点击时间范围按钮:', txt);
                            } catch (e) {
                                log('点击失败:', txt, e);
                            }
                        }, 500);
                        return;
                    }
                }
            }
        }

        /* ================================================================== *
         * 6. QwenWork 专用的 DOM 提取
         * ================================================================== */

        // 先在小范围交互元素里找，找不到再回退到全页扫描（避免每次都遍历整棵 DOM 读 innerText）。
        // 2026-11 版把「已使用」改成「积分消耗 / 获得积分 / 过期积分」三个 tab，
        // 默认停在「积分消耗」，因此这里要同时兼容新旧两种入口文案。
        function qwenworkTabText(el) {
            return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
        }

        function findQwenworkUsedTab() {
            const wanted = [
                '积分消耗', '积分扣减', '已使用',
                'Credits spent', 'Credits deducted', 'Used'
            ];
            const quick = document.querySelectorAll('[role="tab"], button, [role="button"]');
            for (const el of quick) {
                if (wanted.indexOf(qwenworkTabText(el)) !== -1) return el;
            }
            // 旧页面可能把入口渲染成带 tab 类名的普通节点；只对旧文案做全页兜底，
            // 避免把新页面表格里的「积分消耗」表头当成可点击入口。
            const old = document.querySelectorAll('[class*="tab"]');
            for (const el of old) {
                if (qwenworkTabText(el) === '已使用') return el;
            }
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (el.children.length === 0 && qwenworkTabText(el) === '已使用') {
                    return el.closest('[role="tab"]') || el.closest('button') || el;
                }
            }
            return null;
        }

        // 新页面的「积分历史」section 有稳定 id（usage-history-heading）与带
        // aria-label 的 tablist；优先用它，旧页面再从「已使用」入口向上找。
        function findQwenworkHistorySection() {
            const heading = document.getElementById('usage-history-heading');
            if (heading) {
                return heading.closest('section') || heading.parentElement;
            }
            const tablists = document.querySelectorAll('[role="tablist"]');
            for (const list of tablists) {
                const label = list.getAttribute('aria-label') || '';
                if (/积分历史|credit history/i.test(label)) {
                    let node = list;
                    for (let depth = 0; depth < 10 && node; depth++) {
                        const text = node.textContent || '';
                        if (DATETIME_LOOSE_RE.test(text) && text.length > 100) return node;
                        node = node.parentElement;
                    }
                    return list.parentElement;
                }
            }
            const usedTab = findQwenworkUsedTab();
            if (!usedTab) return null;
            let node = usedTab.parentElement;
            for (let depth = 0; depth < 15; depth++) {
                if (!node || node === document.body) break;
                const text = node.innerText || '';
                if (DATETIME_LOOSE_RE.test(text) && text.length > 100) {
                    log('QwenWork: 在第 ' + depth + ' 层找到数据容器 ' + node.tagName);
                    return node;
                }
                node = node.parentElement;
            }
            return node;
        }

        function findQwenworkDataContainer() {
            return findQwenworkHistorySection();
        }

        /**
         * 把容器里的文本按「叶子节点」拆成行。
         * 不用 innerText：新版列表在窄屏会把时间/来源隐藏进 `hidden sm:block`
         * 的 span 里，innerText 直接拿不到；而 `sm:hidden` 的「来源 · 时间」
         * 摘要行又会和时间行重复，按 class 跳过它。
         */
        function collectQwenworkLines(container) {
            const lines = [];
            const walk = (node) => {
                if (!node) return;
                if (node.nodeType === 3) {
                    const text = String(node.nodeValue || '').trim();
                    if (text) lines.push(text);
                    return;
                }
                if (node.nodeType !== 1) return;
                const tag = node.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'TEMPLATE') return;
                const cls = String(node.className || '');
                // 窄屏摘要行（source · time）只在移动端显示；时间与来源另有独立节点，
                // 再收一遍会让「时间/来源/详情/金额」的四行结构错位。
                if (/(^|\s)sm:hidden(\s|$)/.test(cls)) return;
                if (!node.firstElementChild) {
                    const text = String(node.textContent || '').trim();
                    if (text) lines.push(text);
                    return;
                }
                for (const child of node.childNodes) walk(child);
            };
            walk(container);
            return lines;
        }

        // 上一次解析的结构化统计，仅用于诊断输出（只记数量，不记内容）
        let _lastQwenworkParse = { dateLines: 0, amountLines: 0, textLength: 0 };

        // 读取金额。优先按原样解析，取不到再退回「从行内找第一个带符号的数字」
        function readSignedAmount(line) {
            const raw = String(line || '');
            // 有些格式化器输出 Unicode 减号（U+2212）或全角减号；先归一成 ASCII，
            // 否则下面的 parseFloat 会把它当成普通数字，负向金额被误判为正数。
            const compact = raw.replace(/[\u2212\uFF0D]/g, '-').replace(/[,，\s]/g, '');
            if (!compact) return NaN;
            // 金额行不应该是日期时间，避免把 2026-09-13 里的 -09 当成金额
            if (DATETIME_LOOSE_RE.test(compact)) return NaN;
            if (compact.length > 16) return NaN;

            const direct = parseFloat(compact);
            if (Number.isFinite(direct)) return direct;

            const signed = compact.match(/[+\-]\d+(?:\.\d+)?/);
            if (signed) return parseFloat(signed[0]);
            const plain = compact.match(/\d+(?:\.\d+)?/);
            return plain ? parseFloat(plain[0]) : NaN;
        }

        function parseRecordsFromQwenworkDOM(container) {
            const text = container ? (container.innerText || '') : '';
            const innerLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
            // 新版「积分历史」有响应式列：桌面/窄屏的可见行不同，统一按叶子节点收集
            // （能读到 display:none 的时间/来源，并跳过 sm:hidden 的摘要行）。
            // 旧页面沿用 innerText 的视觉行，避免隐藏的浮层/提示混进来。
            const isNewHistory = !!document.getElementById('usage-history-heading') ||
                !!document.querySelector('[role="tablist"][aria-label*="积分历史"]');
            const lines = isNewHistory ? collectQwenworkLines(container) : innerLines;
            _lastQwenworkParse = { dateLines: 0, amountLines: 0, textLength: text.length };

            const found = [];
            for (let i = 0; i < lines.length; i++) {
                let time = null;
                let base = i;

                const sameLine = lines[i].match(DATETIME_LINE_RE);
                if (sameLine) {
                    time = sameLine[1] + '-' + sameLine[2] + '-' + sameLine[3] + ' ' + sameLine[4];
                } else {
                    // 兼容「日期」与「时间」被拆成两行的渲染方式
                    const dateOnly = lines[i].match(DATE_ONLY_LINE_RE);
                    const timeOnly = lines[i + 1] || '';
                    if (dateOnly && TIME_ONLY_LINE_RE.test(timeOnly)) {
                        time = dateOnly[1] + '-' + dateOnly[2] + '-' + dateOnly[3] + ' ' + timeOnly;
                        base = i + 1;
                    }
                }
                if (!time) continue;
                _lastQwenworkParse.dateLines++;

                const amount = readSignedAmount(lines[base + 3]);
                if (!Number.isFinite(amount) || amount === 0) continue;
                _lastQwenworkParse.amountLines++;

                found.push({
                    time: time,
                    source: lines[base + 1] || '',
                    detail: lines[base + 2] || '',
                    amount: amount
                });
            }

            const negatives = found.filter((r) => r.amount < 0);
            // 「已使用」区域里的金额通常带负号。若页面改成渲染成正数，
            // 则回退按正数处理，避免整页一条都取不到。
            // 但新版「积分历史」有三个 tab（积分消耗 / 获得积分 / 过期积分），
            // 「获得积分」的金额天然是正数；没有负号时不能回退，否则会把收入算成消耗。
            if (isNewHistory && found.length > 0 && negatives.length === 0) {
                log('QwenWork: 新版积分历史未发现负向金额，可能不在「积分消耗」tab，本次跳过');
                return [];
            }
            const chosen = negatives.length > 0 ? negatives : found;
            if (found.length > 0 && negatives.length === 0) {
                log('QwenWork: 未发现带负号的金额，按正数处理 ' + found.length + ' 条');
            }

            // 记录用「时间 + 来源 + 详情 + 金额」作唯一标识，不引入出现序号。
            // 序号取决于当次解析的内容构成：页面新增记录后序号会漂移，
            // 同一记录就会拿到新 ID 被当成新记录重复入库（实测曾把两天的用量撑大近 1.5 倍）。
            // 代价是「同一分钟内来源、详情、金额完全相同的两笔」会合并为一条——
            // 这种情况罕见，且 DOM 重复行与真实重复无法区分，宁可少计不可多计。
            return chosen.map((r) => ({
                session_id: qwenworkId(r.time, r.source, r.detail, Math.abs(r.amount)),
                model_name: r.source || '未知来源',
                session_name: r.detail,
                usage_time: r.time,
                credits_float: Math.abs(r.amount)
            }));
        }

        // QwenWork 记录的内容 ID：同一「时间 + 来源 + 详情 + 金额」视为同一条。
        // 新版把空详情显示成「未命名任务」，旧版可能显示短横线；两者都不是真实详情，
        // 归一成空串，避免同一笔记录因为展示占位符变化而拿到新 ID。
        const qwenworkDetailKey = (v) => {
            const s = String(v || '').trim();
            return /^(?:未命名任务|Untitled(?: task)?|—|-|（无详情）)$/.test(s) ? '' : s;
        };
        const qwenworkSourceKey = (v) => {
            const s = String(v || '').trim();
            return /^(?:—|-|未知来源)$/.test(s) ? '' : s;
        };
        function qwenworkId(time, source, detail, amount) {
            return 'qw-' + time + '|' + (qwenworkSourceKey(source) || '未知来源') + '|' +
                qwenworkDetailKey(detail) + '|' + num(amount);
        }

        // QwenWork 的会话写入本地存储（历史缺陷：此前只存在内存里，刷新即丢）
        function mergeQwenworkRecords(records) {
            if (!records.length) return 0;
            const store = DataStore.get();
            if (!Array.isArray(store.usage_sessions)) store.usage_sessions = [];

            // 迁移：历史版本的 session_id 末尾带出现序号（|1、|2…）。序号会随页面内容漂移，
            // 同一记录可能被存成多条。这里按记录自身字段重算标准 ID 并按 ID 去重，
            // 把历史重复收敛掉（重算而不是正则裁剪，避免「整数金额被误当序号」的歧义）。
            let migrated = false;
            const used = new Set();
            const kept = [];
            store.usage_sessions.forEach((s) => {
                if (!s || typeof s !== 'object') return;
                const canonical = qwenworkId(s.usage_time, s.model_name, s.session_name, s.credits_float);
                if (s.session_id !== canonical) {
                    s.session_id = canonical;
                    migrated = true;
                }
                if (used.has(canonical)) {
                    migrated = true;
                    return;
                }
                used.add(canonical);
                kept.push(s);
            });
            if (migrated) store.usage_sessions = kept;

            const seen = new Set(store.usage_sessions.map((s) => readSession(s).id));
            let added = 0;
            records.forEach((r) => {
                if (seen.has(r.session_id)) return;
                seen.add(r.session_id);
                store.usage_sessions.push(r);
                added++;
            });

            if (added > 0 || migrated) {
                const trimmed = trimSessionsByTime(store.usage_sessions);
                store.usage_sessions = trimmed.sessions;
                store.meta = Object.assign({}, store.meta, {
                    platform: 'qwenwork',
                    lastUpdate: Date.now()
                });
                DataStore.set(store);
            }
            log('QwenWork: 新增 ' + added + ' 条，本地共 ' + store.usage_sessions.length + ' 条');
            return added;
        }

        // SPA 的首屏渲染时机不固定，入口可能比脚本晚出现，必须等，不能一上来就判定「找不到」
        async function waitForQwenworkTab(timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const tab = findQwenworkUsedTab();
                if (tab) return tab;
                await sleep(500);
            }
            return null;
        }

        // 等页面上真正渲染出可解析的记录
        async function waitForQwenworkRecords(timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            let records = [];
            while (Date.now() < deadline) {
                await sleep(500);
                const container = findQwenworkDataContainer();
                if (container) {
                    records = parseRecordsFromQwenworkDOM(container);
                    if (records.length > 0) return records;
                }
            }
            return records;
        }

        /**
         * Radix 的 DropdownMenu 触发器在 pointerdown 上打开，单纯 el.click() 不一定能唤起菜单。
         * 按真实鼠标顺序补一遍 pointer/mouse 事件，再补 click；普通按钮也能被 click 兜住。
         */
        function qwenworkUserClick(el) {
            if (!el) return false;
            const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
            try {
                if (typeof PointerEvent === 'function') {
                    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opts, {
                        pointerId: 1, pointerType: 'mouse', isPrimary: true
                    })));
                }
            } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) { }
            try {
                if (typeof PointerEvent === 'function') {
                    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, {
                        pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0
                    })));
                }
            } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, opts, { buttons: 0 }))); } catch (e) { }
            try { el.click(); return true; } catch (e) { return false; }
        }

        /**
         * 2026-11 版新增「分类明细 / 原始流水」两种视图，默认是「原始流水」，
         * 两种视图可能包含同一笔记录。旧脚本采集的是逐笔流水（时间/来源/详情/金额），
         * 因此固定切到「原始流水」；切换失败时宁可本次不采，也不要和已有流水混用口径。
         */
        async function ensureQwenworkTransactionView() {
            const triggers = [
                '[aria-label*="积分历史视图"]',
                '[aria-label*="Credit history view"]',
                '[aria-label*="credit history view"]'
            ];
            let trigger = null;
            for (const sel of triggers) {
                trigger = document.querySelector(sel);
                if (trigger) break;
            }
            if (!trigger) return true; // 旧页面没有视图切换

            const current = qwenworkTabText(trigger);
            if (/原始流水|Raw transactions|Transactions/i.test(current)) return true;

            const findRawItem = () => {
                const items = document.querySelectorAll(
                    '[role="menuitem"], [role="option"], [data-radix-collection-item]'
                );
                for (const item of items) {
                    if (/原始流水|Raw transactions|Transactions/i.test(qwenworkTabText(item))) return item;
                }
                return null;
            };

            // 菜单可能还没挂载（页面仍在 hydration）或第一次点击被吞掉；
            // 先看是否已经打开，再点开，最多重试 3 次。不要在菜单已打开时重复点触发器，
            // 那会把它关掉。
            for (let attempt = 0; attempt < 3; attempt++) {
                let item = findRawItem();
                if (item) {
                    qwenworkUserClick(item);
                    await sleep(800);
                    return true;
                }
                try {
                    if (!qwenworkUserClick(trigger)) throw new Error('click failed');
                } catch (e) {
                    warn('QwenWork: 打开「积分历史视图」菜单失败:', e);
                    return false;
                }
                await sleep(500);
                item = findRawItem();
                if (item) {
                    qwenworkUserClick(item);
                    await sleep(800);
                    return true;
                }
            }
            return false;
        }

        async function bootstrapQwenwork() {
            const tab = await waitForQwenworkTab(15000);
            if (tab) {
                try {
                    tab.click();
                    await sleep(500);
                } catch (e) {
                    warn('QwenWork: 点击「积分消耗」失败:', e);
                }
            } else {
                log('QwenWork: 未找到「积分消耗 / 已使用」入口');
            }

            if (!(await ensureQwenworkTransactionView())) {
                warn('QwenWork: 未能切到「原始流水」视图，本次跳过采集，避免与已有逐笔数据重复');
                return 0;
            }

            const records = await waitForQwenworkRecords(15000);
            if (records.length === 0) {
                warn('QwenWork: 未能在页面上解析出积分消耗记录（匹配日期行 ' +
                    _lastQwenworkParse.dateLines + ' 条，数据区文本长度 ' +
                    _lastQwenworkParse.textLength +
                    '）。把脚本里的 DEBUG 改为 true 后重新加载页面，可在控制台看到详细流程');
                return 0;
            }

            const wasComplete = !!(DataStore.get().meta && DataStore.get().meta.qwenworkComplete);
            const addedFirst = mergeQwenworkRecords(records);

            // 页面可能停留在上次采集遗留的页码上：先退回第 1 页再重新解析一次，
            // 保证拿到的是最新的记录（列表按时间倒序，新记录总在第 1 页）
            await returnToFirstPage();
            const fresh = await waitForQwenworkRecords(8000);
            const addedFresh = fresh.length > 0 ? mergeQwenworkRecords(fresh) : 0;

            // 首页（最新一页）没有新记录，且上次采集已经走到过最后一页，才跳过翻页。
            // 上次若中途中断（qwenworkComplete=false），即使首页无新增也要继续，
            // 否则缺失的旧页会永远补不回来。
            if (addedFirst + addedFresh === 0 && wasComplete) {
                log('QwenWork: 记录均已采集过，跳过翻页');
                return records.length;
            }

            let complete = false;
            try {
                complete = await fetchAllQwenworkPagesFromDOM();
            } catch (e) {
                warn('QwenWork 翻页失败:', e);
            }
            const store = DataStore.get();
            store.meta = Object.assign({}, store.meta, { qwenworkComplete: complete });
            await DataStore.set(store);
            log('QwenWork: 本次采集' + (complete ? '已到最后一页' : '未完成，下次继续'));
            return records.length;
        }

        async function fetchAllQwenworkPagesFromDOM() {
            let container = findQwenworkDataContainer();
            if (!container) {
                log('QwenWork: 未找到数据容器，跳过翻页');
                return false;
            }

            const firstRecords = parseRecordsFromQwenworkDOM(container);
            mergeQwenworkRecords(firstRecords);
            let lastSig = firstRecords.map((r) => r.session_id).join('|');

            let page = 1;
            let complete = false;
            let noNewStreak = 0;
            while (page < CONFIG.maxAutoPages) {
                const pagination = findPaginationContainer();
                if (!pagination) {
                    log('QwenWork: 未找到翻页控件，只有一页');
                    complete = true;
                    break;
                }
                const nextBtn = findNextPageButton(pagination);
                if (!nextBtn || nextBtn.disabled ||
                    nextBtn.classList.contains('disabled') ||
                    nextBtn.getAttribute('aria-disabled') === 'true') {
                    log('QwenWork: 已到最后一页');
                    complete = true;
                    break;
                }

                page++;
                try {
                    nextBtn.click();
                } catch (e) {
                    warn('QwenWork: 翻页点击失败:', e);
                    break;
                }
                await sleep(1500);

                container = findQwenworkDataContainer();
                if (!container) {
                    log('QwenWork: 翻页后数据容器丢失');
                    break;
                }
                const pageRecords = parseRecordsFromQwenworkDOM(container);
                if (pageRecords.length === 0) {
                    log('QwenWork: 翻页后没有记录，视为最后一页');
                    complete = true;
                    break;
                }
                const sig = pageRecords.map((r) => r.session_id).join('|');
                if (sig && sig === lastSig) {
                    // 点了下一页但内容没变：说明已经翻不动了（或被页面拦住）。
                    // 记为已到最后一页，避免每次打开都重复点同一条分页。
                    log('QwenWork: 分页内容没有变化，视为已到最后一页');
                    complete = true;
                    break;
                }
                lastSig = sig;

                const added = mergeQwenworkRecords(pageRecords);
                log('QwenWork: 第 ' + page + ' 页新增 ' + added + ' 条');
                // 不能用「本页无新增」判断结束：本地可能已经采过这一页，
                // 后面仍可能有缺失的旧页。内容签名变化说明确实翻到了新的一页。
                if (added === 0) {
                    noNewStreak++;
                    if (noNewStreak >= 3) {
                        log('QwenWork: 连续 3 页无新增，停止翻页');
                        break;
                    }
                } else {
                    noNewStreak = 0;
                }
            }

            // 采集完把分页退回第 1 页：否则页面停留在最后一页，
            // 用户下次进来看到的就不是最新的记录
            await returnToFirstPage();
            return complete;
        }

        // 把分页退回第 1 页。页面自己会记住页码，采集完不退回的话，
        // 用户下次进入时看到的就不是最新的记录。
        async function returnToFirstPage() {
            let pagination = findPaginationContainer();
            if (!pagination) return;

            // 数字分页：直接点页码 1（只点可交互节点，避免命中「共 1 页」之类的文本）
            const nodes = pagination.querySelectorAll('button, a, [role="button"], li');
            for (const el of nodes) {
                if (qwenworkTabText(el) !== '1') continue;
                try {
                    el.click();
                } catch (e) {
                    return;
                }
                await sleep(1200);
                log('QwenWork: 分页已退回第 1 页');
                return;
            }

            // 2026-11 版是游标分页，只给「上一页」：连续点到按钮禁用为止。
            // 最多 50 次，防止页面把禁用态渲染成可点击时死循环。
            for (let i = 0; i < 50; i++) {
                pagination = findPaginationContainer();
                if (!pagination) return;
                const prev = findPreviousPageButton(pagination);
                if (!prev || prev.disabled ||
                    prev.classList.contains('disabled') ||
                    prev.getAttribute('aria-disabled') === 'true') {
                    break;
                }
                try {
                    prev.click();
                } catch (e) {
                    return;
                }
                await sleep(900);
            }
            log('QwenWork: 分页已退回第 1 页');
        }

        function findPreviousPageButton(container) {
            const candidates = container.querySelectorAll('button, a, [role="button"]');
            for (const el of candidates) {
                const aria = (el.getAttribute('aria-label') || '').trim();
                const text = (el.textContent || '').trim();
                if (aria === '上一页' || aria === 'Previous page' ||
                    text === '上一页' || text === '‹' || text === '<') {
                    return el;
                }
            }
            return null;
        }

        function findPaginationContainer() {
            const selectors = [
                '.ant-pagination',
                '.el-pagination',
                '.pagination',
                '[class*="pagination"]',
                '[class*="Pagination"]',
                'nav[aria-label="pagination"]',
                'nav[aria-label*="分页"]',
                'nav[aria-label*="page" i]',
                'ul[class*="page"]',
                'div[class*="page"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            const candidates = document.querySelectorAll('button, a, [role="button"], li, span');
            for (const el of candidates) {
                const txt = el.textContent || '';
                if (txt.includes('下一页') || (txt.includes('>') && txt.length < 10)) {
                    let parent = el.parentElement;
                    for (let d = 0; d < 5 && parent; d++) {
                        if (parent.querySelectorAll('button, a, li').length >= 2) return parent;
                        parent = parent.parentElement;
                    }
                }
            }
            return null;
        }

        function findNextPageButton(container) {
            const candidates = container.querySelectorAll('button, a, [role="button"], li');
            for (const el of candidates) {
                const text = (el.textContent || '').trim();
                if (el.getAttribute('aria-label') === 'Next page' ||
                    el.getAttribute('aria-label') === '下一页' ||
                    text === '下一页' || text === '>' || text === '›' || text === 'next') {
                    return el;
                }
            }
            const all = container.querySelectorAll('*');
            for (const el of all) {
                const text = (el.textContent || '').trim();
                if ((text === '>' || text === '›') && el.tagName === 'SPAN') {
                    const parent = el.parentElement;
                    if (parent && (parent.tagName === 'BUTTON' || parent.tagName === 'A' ||
                        parent.getAttribute('role') === 'button')) {
                        return parent;
                    }
                    return parent;
                }
            }
            return null;
        }

        /* ================================================================== *
         * 7. 统计
         * ================================================================== */

        function parseLocalDateKey(dateStr) {
            const parts = String(dateStr || '').split('-').map(Number);
            if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
            const y = parts[0];
            const m = parts[1];
            const d = parts[2];
            const date = new Date(y, m - 1, d);
            if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
            date.setHours(0, 0, 0, 0);
            return date;
        }

        function parseTime(raw) {
            if (typeof raw === 'number') {
                if (raw > 946684800000) return raw;
                if (raw > 946684800) return raw * 1000;
                return 0;
            }
            if (typeof raw === 'string') {
                const text = raw.trim();
                if (!text) return 0;
                // 有些接口/历史数据把秒级或毫秒级时间戳存成字符串。
                // 交给 new Date() 会被当成非法日期，导致整条记录失去日维度。
                if (/^\d{10,13}$/.test(text)) return parseTime(Number(text));
                // 只有日期时按本地自然日解析：new Date('YYYY-MM-DD') 会按 UTC，
                // 在东八区之外可能落到前一天。
                if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
                    const day = parseLocalDateKey(text);
                    return day ? day.getTime() : 0;
                }
                // 统一成 ISO 风格再交给 Date 解析，"2026-09-13 18:02:00" 在部分环境解析不稳
                const normalized = text.replace(' ', 'T');
                const ts = new Date(normalized).getTime();
                return Number.isFinite(ts) ? ts : 0;
            }
            return 0;
        }

        /**
         * 一次对话可能横跨多个模型：会话级的 model_name 只代表其中一个，
         * 整笔记到它名下会把同一次对话里的其它模型藏起来（实测 37 条里有 7 条各含 2 个模型）。
         * 接口在 usage_group_details 里给出了每个模型各自的消耗，优先按它归属。
         * 实测多模型会话的 group 金额之和与会话金额完全一致，因此按 group 归属不会改变总数。
         */
        function readModelGroups(raw) {
            const list = raw && raw.usage_group_details;
            if (!Array.isArray(list) || list.length === 0) return null;
            const out = [];
            list.forEach((g) => {
                if (!g || typeof g !== 'object') return;
                const name = String(pick(g, ['model_display_name', 'model_name']) || '');
                const credit = num(pick(g, ['credits_float', 'amount_float']));
                if (!name && !credit) return;
                out.push({ name: name || MODEL_PLACEHOLDER, credit: credit });
            });
            return out.length ? out : null;
        }

        /**
         * 把会话总额（分）分配给各个模型分组。直接对每个 group 单独
         * Math.round(credit*100) 会让「总额 = 各模型之和」在 0.005 这类
         * 半分布上差 1 分；这里用最大余数法分配，保证分币级守恒。
         */
        function allocateGroupCents(groups, totalCents) {
            const exact = groups.map((g) => num(g.credit) * 100);
            const cents = exact.map((v) => Math.floor(v));
            let remaining = totalCents - cents.reduce((a, b) => a + b, 0);
            const order = exact
                .map((v, i) => ({ i: i, frac: v - Math.floor(v) }))
                .sort((a, b) => b.frac - a.frac);
            for (let k = 0; remaining > 0 && k < order.length; k++) {
                cents[order[k].i] += 1;
                remaining--;
            }
            let k = order.length - 1;
            while (remaining < 0 && k >= 0) {
                cents[order[k].i] -= 1;
                remaining++;
                k--;
            }
            if (remaining !== 0 && cents.length) cents[cents.length - 1] += remaining;
            return cents;
        }

        // 趋势的按周聚合：长区间逐日柱子会挤成一团，合并进自然周（周一起始）后
        // 每根柱子仍代表一段可比的时间
        function aggregateByWeek(days) {
            const weeks = [];
            const index = new Map();
            days.forEach((d) => {
                const day = parseLocalDateKey(d.date);
                if (!day) return;
                const monday = new Date(day);
                monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
                const key = fmtDate(monday);
                const existing = index.get(key);
                if (existing) {
                    existing.cents += d.cents;
                    existing.calls += d.calls;
                    return;
                }
                const row = {
                    date: key,
                    cents: d.cents,
                    calls: d.calls,
                    label: key.substring(5) + ' 周'
                };
                index.set(key, row);
                weeks.push(row);
            });
            return weeks.sort((a, b) => a.date.localeCompare(b.date));
        }

        /**
         * @param sessions 参与统计的记录（区间模式下已经过 applyRange 过滤）
         * @param range    当前生效的日期区间；为 null 时按「全部」口径输出今日 / 近 7 天 / 本月
         */
        function computeStats(sessions, store, range) {
            const now = new Date();
            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);
            const todayStr = fmtDate(todayStart);

            const sevenDaysStart = new Date(todayStart);
            sevenDaysStart.setDate(sevenDaysStart.getDate() - 6);
            const sevenDaysStartStr = fmtDate(sevenDaysStart);

            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            monthStart.setHours(0, 0, 0, 0);

            let totalCents = 0;
            const modelMap = new Map();
            const productMap = new Map();
            const clientMap = new Map();
            const dailyMap = new Map();
            // 未分类聚合条目的下级明细：仅模型桶需要（模型桶本身就是模型维度，只能按详情细分）
            const modelChildMap = new Map();
            let unlabeledProductCents = 0;
            let unlabeledProductCalls = 0;
            let unlabeledProductStart = '';
            let unlabeledProductEnd = '';
            let unparsedTime = 0;

            const bumpChild = (outer, outerKey, innerKey, cents) => {
                let inner = outer.get(outerKey);
                if (!inner) {
                    inner = new Map();
                    outer.set(outerKey, inner);
                }
                const v = inner.get(innerKey) || { credits: 0, calls: 0 };
                v.credits += cents;
                v.calls += 1;
                inner.set(innerKey, v);
            };

            const bumpModel = (name, cents) => {
                const m = modelMap.get(name) || { credits: 0, calls: 0 };
                m.credits += cents;
                m.calls += 1;
                modelMap.set(name, m);
            };

            sessions.forEach((raw) => {
                const s = readSession(raw);
                // 金额一律按「分」（×100 取整）累加，避免浮点误差导致
                // 「总数与各柱之和」「今日与趋势末柱」对不上（见 v1.5.2）
                const cents = Math.round(s.credit * 100);
                totalCents += cents;
                const ts = parseTime(s.time);

                // 原样展示采集到的模型标识：'-' 就是页面给出的「未公布」，不改写成别的说法
                const model = s.model || MODEL_PLACEHOLDER;

                // 模型维度优先按 usage_group_details 归属；没有该字段（QwenWork / WorkBuddy）时
                // 回退到会话级的模型名
                const groups = readModelGroups(raw);
                if (groups) {
                    const groupCents = allocateGroupCents(groups, cents);
                    groups.forEach((g, i) => {
                        const c = groupCents[i];
                        bumpModel(g.name, c);
                        if (isFallbackLabel(g.name)) {
                            bumpChild(modelChildMap, g.name, s.detail || '（无详情）', c);
                        }
                    });
                } else {
                    bumpModel(model, cents);
                    // 模型名缺失或为「-」时，这个桶本身就是模型维度，展开时改用记录里的详情来细分
                    if (isFallbackLabel(model)) {
                        bumpChild(modelChildMap, model, s.detail || '（无详情）', cents);
                    }
                }

                if (s.client !== undefined) {
                    const clientLabel = s.client || '未知使用端';
                    const c = clientMap.get(clientLabel) || { credits: 0, calls: 0 };
                    c.credits += cents;
                    c.calls += 1;
                    clientMap.set(clientLabel, c);
                    // 使用端桶不再做下级细分：桶里的记录都带模型名，而模型已在
                    // 「各模型积分消耗」中各自成行，再叠一层折叠属于重复呈现。
                }

                // Buddy One 产品维度。只有声明了 productDimension 的平台才统计；
                // 旧记录没有 product 字段，单独累计成「未标注产品」，不伪造归属。
                if (PLATFORM.productDimension) {
                    if (s.product) {
                        const label = productLabel(s.product);
                        const p = productMap.get(label) || { credits: 0, calls: 0 };
                        p.credits += cents;
                        p.calls += 1;
                        productMap.set(label, p);
                    } else {
                        unlabeledProductCents += cents;
                        unlabeledProductCalls += 1;
                        if (ts > 0) {
                            const day = fmtDate(new Date(ts));
                            if (!unlabeledProductStart || day < unlabeledProductStart) unlabeledProductStart = day;
                            if (!unlabeledProductEnd || day > unlabeledProductEnd) unlabeledProductEnd = day;
                        }
                    }
                }

                if (ts > 0) {
                    const dateStr = fmtDate(new Date(ts));
                    const d = dailyMap.get(dateStr) || { cents: 0, calls: 0 };
                    d.cents += cents;
                    d.calls += 1;
                    dailyMap.set(dateStr, d);
                } else {
                    unparsedTime++;
                }
            });

            const toRows = (map, childMap) => Array.from(map.entries())
                .map(([name, v]) => {
                    const row = { name, credits: v.credits / 100, calls: v.calls };
                    const inner = childMap && childMap.get(name);
                    if (inner) {
                        row.children = Array.from(inner.entries())
                            .map(([childName, childValue]) => ({
                                name: childName,
                                credits: childValue.credits / 100,
                                calls: childValue.calls
                            }))
                            .sort((a, b) => b.credits - a.credits);
                    }
                    return row;
                })
                .sort((a, b) => b.credits - a.credits);

            const modelBreakdown = toRows(modelMap, modelChildMap);

            // 使用端一览只保留真实存在的客户端标识。「未知使用端」是个占位桶而不是使用端，
            // 桶里的记录都带模型名、已在「各模型积分消耗」中各自成行，再以使用端身份列一次
            // 会让人以为积分被算了两次。这里把它摘出来，单独告知总量与去向。
            const allClientRows = clientMap.size > 0 ? toRows(clientMap) : [];
            const clientBreakdown = allClientRows.filter((r) => !isFallbackLabel(r.name));
            const omittedClientRows = allClientRows.filter((r) => isFallbackLabel(r.name));
            const unlabeledClient = omittedClientRows.length > 0
                ? {
                    credits: omittedClientRows.reduce((a, r) => a + Math.round(r.credits * 100), 0) / 100,
                    calls: omittedClientRows.reduce((a, r) => a + r.calls, 0)
                }
                : null;

            // 产品维度与使用端不同：空值不是「未知产品」这种占位桶，而是
            // 旧版本没有采集 appType 的历史记录。单独累计，不参与产品排行。
            const productBreakdown = productMap.size > 0 ? toRows(productMap) : [];
            // 只有至少一条记录带产品字段时才展示产品一节；否则说明这是
            // 尚未升级到 Buddy One 的旧数据，不拿「未标注产品」去打扰用户
            const unlabeledProduct = (productMap.size > 0 && unlabeledProductCalls > 0)
                ? {
                    credits: unlabeledProductCents / 100,
                    calls: unlabeledProductCalls,
                    start: unlabeledProductStart || null,
                    end: unlabeledProductEnd || null
                }
                : null;

            let todayCents = 0;
            let sevenDaysCents = 0;
            let monthCents = 0;
            const allDays = [];

            dailyMap.forEach((v, date) => {
                const day = parseLocalDateKey(date);
                if (!day) return;
                allDays.push({ date, cents: v.cents, calls: v.calls });
                if (date === todayStr) todayCents += v.cents;
                if (day.getTime() >= sevenDaysStart.getTime()) sevenDaysCents += v.cents;
                if (day.getTime() >= monthStart.getTime()) monthCents += v.cents;
            });
            allDays.sort((a, b) => a.date.localeCompare(b.date));

            const rangeActive = !!(range && (range.start || range.end));
            let dailyTrend = [];
            let trendNote = '';

            if (rangeActive) {
                // 区间口径：趋势展示区间内每一个有消耗的日子（调用方已按区间过滤），
                // 不再固定在近 7 天
                dailyTrend = allDays.slice();
                if (dailyTrend.length > 31) {
                    dailyTrend = aggregateByWeek(dailyTrend);
                    trendNote = '区间内共 ' + allDays.length + ' 天有消耗，趋势已按自然周（周一起始）聚合';
                }
            } else {
                dailyTrend = allDays.filter((d) => d.date >= sevenDaysStartStr);
                // 近 7 天没有记录时，趋势图会整块空着，容易被误认为脚本坏了。
                // 这里退化为「最近有消耗的若干天」，并明确标注真实区间。
                if (dailyTrend.length === 0 && dailyMap.size > 0) {
                    const dates = allDays.map((d) => d.date);
                    const tail = dates.slice(-7);
                    tail.forEach((date) => {
                        const v = dailyMap.get(date);
                        dailyTrend.push({ date, cents: v.cents, calls: v.calls });
                    });
                    trendNote = '近 7 天没有消耗记录，以下为最近有消耗的 ' + tail.length +
                        ' 天（' + tail[0] + ' ~ ' + tail[tail.length - 1] + '）';
                }
            }

            // Trae 的权益包金额是「已购买」不是「已消耗」，单独给出，不混进总消耗
            let entitlementCredits = 0;
            const entitlement = store && store.entitlement;
            if (entitlement && Array.isArray(entitlement.user_entitlement_pack_list)) {
                entitlement.user_entitlement_pack_list.forEach((pack) => {
                    entitlementCredits += num(pick(pack, ['amount_float', 'credits_float', 'total_amount', 'amount']));
                });
            }

            if (unparsedTime > 0) {
                log('有 ' + unparsedTime + ' 条记录的时间无法解析，未计入日维度统计');
            }

            const hasSessions = sessions.length > 0;
            const lastUpdate = hasSessions
                ? new Date((store && store.meta && store.meta.lastUpdate) || Date.now()).toLocaleString('zh-CN')
                : '暂无数据，请先打开 ' + PLATFORM.label + ' 用量页并触发一次数据加载';

            return {
                totalCredits: totalCents / 100,
                totalSessions: sessions.length,
                todayCredits: todayCents / 100,
                sevenDaysCredits: sevenDaysCents / 100,
                monthCredits: monthCents / 100,
                entitlementCredits,
                modelBreakdown,
                productBreakdown,
                unlabeledProduct,
                clientBreakdown,
                unlabeledClient,
                dailyTrend,
                trendNote,
                unparsedTime,
                rangeActive,
                rangeText: rangeActive ? rangeLabel(range) : '',
                // 日均的分母：区间跨度（自然日）。缺侧的区间（只填起始或只填结束）
                // 给不出跨度，卡片改为只展示区间合计
                rangeDays: rangeActive ? rangeDayCount(range) : 0,
                lastUpdate
            };
        }

        /* ================================================================== *
         * 8. 渲染
         * ================================================================== */

        function renderDashboard(force) {
            // SPA 切到其它页面后不再显示面板（数据仍在后台采集，回到用量页会自动恢复）
            if (!isOnUsagePage()) {
                removePanel();
                return;
            }

            const store = DataStore.get();
            const container = getOrCreateContainer();
            if (!container) return;

            // 正在输入日期时不重建：整块 innerHTML 重写会让输入框失焦，把用户敲到一半
            // 的日期打断。数据仍在后台合并，失焦或定时兜底重绘时补上
            if (!force && isRangeInputFocused(container)) return;

            refreshRollingRange();
            const allSessions = Array.isArray(store.usage_sessions) ? store.usage_sessions : [];
            const filtered = applyRange(allSessions, _range);
            // 指纹必须含区间：切换区间时记录条数可能不变（例如两个都不含数据的区间）。
            // 还要含当前本地日期：跨午夜后今日/近 7 天/本月会变化，但条数和
            // lastUpdate 都可能没变，不含日期就会永远停在昨天的数字。
            const key = PLATFORM.id + ':' + filtered.sessions.length + ':' +
                ((store.meta && store.meta.lastUpdate) || 0) + ':' + fmtDate(new Date()) +
                ':' + rangeSignature();
            if (!force && container.dataset.renderKey === key) return;
            container.dataset.renderKey = key;

            const stats = computeStats(filtered.sessions, store, _range);

            const trendTitle = stats.rangeActive
                ? '积分消耗趋势（' + stats.rangeText + '）'
                : (stats.trendNote ? '积分消耗趋势（近 7 天无记录）' : '积分消耗趋势（近 7 天）');
            const trendBody = renderTrendChart(stats.dailyTrend) +
                (stats.trendNote ? '<div class="tee-note tee-note-spaced">' + escapeHtml(stats.trendNote) + '</div>' : '');

            // 产品一节：Buddy One 账号的积分池跨产品共享，先按产品拆一层；
            // 旧记录没有 appType，单独说明差额，不硬塞进某个产品。
            let productBody = stats.productBreakdown.length > 0
                ? renderBreakdown(stats.productBreakdown, '请求')
                : '';
            if (stats.unlabeledProduct) {
                const up = stats.unlabeledProduct;
                const dateRange = (up.start && up.end) ? '，' + up.start + ' ~ ' + up.end : '';
                productBody += '<div class="tee-note tee-note-spaced">' + escapeHtml(
                    '另有 ' + formatNumber(up.credits) + ' 积分（' + up.calls + ' 请求' + dateRange +
                    '）未标注产品，已计入上方的模型统计；这些是旧版本采集、且不在本次补拉窗口内的历史记录（没有 appType 字段）'
                ) + '</div>';
            }

            // 使用端一节：把「未标注使用端」的记录摘出去之后，需要说明剩下的差额去哪了，
            // 否则这一节会静默地加不出总数
            let clientBody = stats.clientBreakdown.length > 0
                ? renderBreakdown(stats.clientBreakdown, '请求')
                : '';
            if (stats.unlabeledClient) {
                clientBody += '<div class="tee-note tee-note-spaced">' + escapeHtml(
                    '另有 ' + formatNumber(stats.unlabeledClient.credits) + ' 积分（' +
                    stats.unlabeledClient.calls + ' 请求）未标注使用端，已计入上方的模型统计'
                ) + '</div>';
            }

            const sections = [
                // 模型桶的未分类条目（模型名为 `-` 或缺失）按记录详情细分。
                // 使用端桶不做细分，也不保留占位桶：模型已在上一节各自成行。
                section('各模型积分消耗', renderBreakdown(stats.modelBreakdown, '调用', '详情')),
                productBody ? section('各产品积分消耗', productBody) : '',
                clientBody ? section('各使用端积分消耗', clientBody) : '',
                section(trendTitle, trendBody)
            ].join('');

            const note = typeof PLATFORM.note === 'function'
                ? PLATFORM.note(stats)
                : (PLATFORM.note || ('统计口径：本地已采集的 ' + PLATFORM.label + ' 用量记录。数据只存在本机浏览器。'));

            container.innerHTML = header() +
                rangeControl(rangeStatusLines(stats, filtered, allSessions)) +
                cards(stats) + sections + footer(note, stats);

            bindRangeEvents(container);

            const reloadBtn = container.querySelector('.tee-reload');
            if (reloadBtn) {
                reloadBtn.addEventListener('click', async () => {
                    // Trae / QwenWork 仍靠刷新页面重新触发页面请求；
                    // WorkBuddy 新版页面刷新后停在「积分概览」，reload 不会发用量请求，
                    // 因此这里直接向接口取一次数，按钮文案也改为「刷新数据」。
                    if (!PLATFORM.bootstrapOnLoad) {
                        window.location.reload();
                        return;
                    }
                    if (reloadBtn.disabled || _bootstrapInFlight) return;
                    reloadBtn.disabled = true;
                    reloadBtn.textContent = '刷新中…';
                    const res = await bootstrapPlatform({ force: true });
                    if (!res || (!res.ok && res.reason !== '正在采集')) openUsageTab();
                    renderDashboard(true);
                });
            }

            const resetBtn = container.querySelector('.tee-reset');
            if (resetBtn) {
                resetBtn.addEventListener('click', async () => {
                    const store = DataStore.get();
                    const count = DataStore.count();
                    if (count === 0) {
                        window.alert('本页当前没有已采集的用量数据，无需重置。');
                        return;
                    }

                    const prev = readBackup();
                    const lines = [
                        '即将清空「' + PLATFORM.label + '」本地已采集的 ' + count + ' 条用量数据，并重新采集一遍。',
                        '',
                        resetLossNote(),
                        '',
                        prev
                            ? '注意：已存在 ' + fmtDateTime(new Date(prev.at)) + ' 的备份（' +
                              prev.sessions.length + ' 条），继续将用当前数据覆盖它。'
                            : '清空前会自动把这 ' + count + ' 条备份到独立存储键，之后可用页脚的「恢复备份」找回来。'
                    ];
                    if (!window.confirm(lines.join('\n'))) return;

                    // 先落备份再清空。顺序反了就等于在一个没有撤销点的清空上继续，
                    // 而 GM 存储配额不足时 GM_setValue 是会抛的；ScriptCat 等管理器
                    // 还可能返回 Promise，必须等它真正写完再 reload。
                    const backupOk = await writeBackup(store.usage_sessions);
                    if (!backupOk) {
                        window.alert('备份写入失败，已取消重置。仍要清空的话，请先在脚本管理器的存储里手动留一份。');
                        return;
                    }

                    const sessionsBeforeClear = store.usage_sessions;
                    store.usage_sessions = [];
                    const cleared = await DataStore.set(store);
                    if (!cleared) {
                        // 没写进去就不算清空；把内存副本还原，避免页脚随后误报 0 条
                        store.usage_sessions = sessionsBeforeClear;
                        DataStore.cache = store;
                        window.alert('清空写入失败，已取消重置。备份仍保留在本地。');
                        return;
                    }
                    window.location.reload();
                });
            }

            const restoreBtn = container.querySelector('.tee-restore');
            if (restoreBtn) {
                restoreBtn.addEventListener('click', async () => {
                    const backup = readBackup();
                    if (!backup) {
                        window.alert('没有可用的重置备份。');
                        renderDashboard(true);
                        return;
                    }
                    if (!window.confirm(
                        '把 ' + fmtDateTime(new Date(backup.at)) + ' 的备份（' + backup.sessions.length +
                        ' 条）合并回当前数据？\n\n备份里当前没有的记录会被补回；同一条记录若已经重新采集到，以新值为准，不会回退成旧值。' +
                        '\n恢复后本次备份即被清除。'
                    )) return;

                    const result = await restoreBackup(backup);
                    if (!result.ok) {
                        window.alert('恢复写入失败，数据没有落盘；备份已保留，可稍后重试。');
                        renderDashboard(true);
                        return;
                    }
                    const cleared = await clearBackup();
                    if (!cleared) {
                        window.alert('数据已恢复，但备份清除失败；备份仍在，可稍后手动处理。');
                        renderDashboard(true);
                        return;
                    }
                    window.alert(
                        '已补回 ' + result.added + ' 条记录，当前共 ' + result.total + ' 条。' +
                        (result.trimmed ? '\n\n超出 ' + CONFIG.maxSessions + ' 条上限，最旧的记录已被截断。' : '')
                    );
                    // 必须强制重绘：补回 0 条时记录条数与 lastUpdate 都没变，
                    // 非强制渲染会被指纹挡掉，页脚仍显示已经清除的「恢复备份」。
                    renderDashboard(true);
                });
            }

            const diagBtn = container.querySelector('.tee-diag');
            if (diagBtn) {
                diagBtn.addEventListener('click', () => {
                    copyText(diagnosticPayload(), () => {
                        diagBtn.textContent = '已复制到剪贴板';
                        setTimeout(() => { diagBtn.textContent = '复制诊断信息'; }, 2500);
                    });
                });
            }

            // 折叠面板默认收起；恢复用户上次的展开状态，避免每次重绘都要重新点开
            container.querySelectorAll('details.tee-sub').forEach((el) => {
                const subKey = el.getAttribute('data-subkey');
                if (_openSubs.has(subKey)) el.open = true;
                el.addEventListener('toggle', () => {
                    if (el.open) _openSubs.add(subKey);
                    else _openSubs.delete(subKey);
                });
            });
        }

        function header() {
            return '' +
                '<div class="tee-header">' +
                '<h3>用量增强面板</h3>' +
                '<span class="tee-badge">' + PLATFORM.label + ' · v' + VERSION + '</span>' +
                '<button class="tee-btn tee-reload" style="margin-left: auto !important;">' +
                (PLATFORM.reloadLabel || '刷新页面') + '</button>' +
                '</div>';
        }

        /**
         * 重置到底会丢什么，按平台的数据来源分别说明。
         * 三个平台的可恢复范围差得很远：Trae / WorkBuddy 能补拉平台保留的窗口，
         * QwenWork 的接口返回 404，只能靠此刻页面渲染出来的内容。
         * 笼统写一句「会重新采集」等于没提示——用户会以为刷新一下就等于原样恢复。
         */
        function resetLossNote() {
            if (PLATFORM.rangeFields) {
                return '注意：这不等于原样恢复。本地历史里早于平台保留窗口（页面默认请求范围约最近 7~30 天）的那部分，' +
                    '重新采集与补拉都取不回来，只能逐日重新积累。';
            }
            return '注意：该平台的用量接口不可用，数据只能从当前页面抓取。重置后只能取回此刻页面渲染出的记录，' +
                '已经翻页 / 滚动走掉的历史会永久丢失。';
        }

        // 输入框正被占用时跳过常规重绘，避免打断输入（区间选择本身走强制重绘）
        function isRangeInputFocused(container) {
            const el = document.activeElement;
            return !!(el && el.classList && el.classList.contains('tee-date') && container.contains(el));
        }

        // 区间控件下方那一行行的说明，按「当前区间 → 数据覆盖 → 统计口径 → 操作结果」排列
        function rangeStatusLines(stats, filtered, allSessions) {
            const lines = [];
            if (stats.rangeActive) {
                lines.push('当前区间 ' + stats.rangeText + '：区间内 ' + stats.totalSessions +
                    ' 条，本地已采集 ' + allSessions.length + ' 条');
            }
            const coverage = rangeCoverage(_range, allSessions);
            if (coverage) lines.push(coverage);
            if (filtered.skippedNoTime > 0) {
                lines.push('另有 ' + filtered.skippedNoTime +
                    ' 条记录的时间无法解析，无法判断落在哪一天，未纳入区间统计');
            }
            if (_rangeHint.text) lines.push(_rangeHint.text);
            return lines;
        }

        // 原生 date 的区间界：给了它就把界外的日子置灰，输入框为空时日历
        // 还会直接开到界内的那个月，用户不必逐月翻页去找
        const dateBound = (name, value) =>
            (value ? ' ' + name + '="' + escapeAttr(value) + '"' : '');

        /**
         * 区间选择控件：预设芯片 + 自定义起止日期。
         * 选中的区间决定统计用的数据集——卡片、模型分布、使用端分布与趋势都按它过滤。
         * 起止互设界：起始日的 max = 结束日，结束日的 min = 起始日——先选哪一侧，
         * 另一侧的可选范围就以它为准，日历面板随之开到最近可选的月份。
         */

        function rangeControl(statusLines) {
            const chips = RANGE_PRESETS.map((p) => {
                const active = _range.preset === p.id;
                return '<button type="button" class="tee-chip' + (active ? ' tee-chip-on' : '') +
                    '" data-preset="' + p.id + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
                    escapeHtml(p.label) + '</button>';
            }).join('');
            const notes = (statusLines || []).filter(Boolean).map((line) =>
                '<div class="tee-range-note">' + escapeHtml(line) + '</div>'
            ).join('');

            return '' +
                '<div class="tee-range">' +
                '<div class="tee-range-row">' +
                '<span class="tee-range-title">统计区间</span>' +
                '<span class="tee-range-chips">' + chips + '</span>' +
                '<span class="tee-range-custom">' +
                '<input class="tee-date tee-date-start" type="date" aria-label="起始日期"' +
                dateBound('max', _rangeDraft.end) + ' value="' +
                escapeAttr(_rangeDraft.start) + '">' +
                '<span class="tee-range-dash">至</span>' +
                '<input class="tee-date tee-date-end" type="date" aria-label="结束日期"' +
                dateBound('min', _rangeDraft.start) + ' value="' +
                escapeAttr(_rangeDraft.end) + '">' +
                '<button type="button" class="tee-btn tee-range-apply">应用</button>' +
                '</span>' +
                '</div>' +
                (notes ? '<div class="tee-range-notes">' + notes + '</div>' : '') +
                '</div>';
        }

        // 应用一个区间选择：本地筛选立即生效，能补拉的平台再按区间向接口取数
        function applyRangeChoice(next) {
            _range = next;
            _rangeDraft = { start: next.start || '', end: next.end || '' };
            saveRange();
            _rangeHint = { active: false, text: '' };
            renderDashboard(true);
            if (next.start || next.end) requestUsageRange(next);
        }

        /**
         * 一侧的日期改动后，把另一侧顶进合法范围，再刷新两头的 min / max。
         * 以刚改的这一侧为准：另一侧落到了界外就顶到最近的合法日期——也就是同一天，
         * 得到一个单点区间而不是一句报错。日历里选不出界外的日子，但手输在部分宿主上
         * 能绕过 min / max，所以这道兜底和那两个属性都要留着。
         */
        function constrainRangeInput(container, changed) {
            const start = _rangeDraft.start || '';
            const end = _rangeDraft.end || '';
            // 'YYYY-MM-DD' 定长零填充，字典序即日期序
            if (start && end && start > end) {
                const other = changed === 'start' ? 'end' : 'start';
                const picked = _rangeDraft[changed];
                _rangeDraft[other] = picked;
                const otherEl = container.querySelector(other === 'start' ? '.tee-date-start' : '.tee-date-end');
                if (otherEl) otherEl.value = picked;
            }
            const startEl = container.querySelector('.tee-date-start');
            const endEl = container.querySelector('.tee-date-end');
            if (startEl) startEl.max = _rangeDraft.end || '';
            if (endEl) endEl.min = _rangeDraft.start || '';
        }

        // 事件在每次重绘后重新绑定（innerHTML 会换掉整棵子树）
        function bindRangeEvents(container) {
            container.querySelectorAll('.tee-chip').forEach((btn) => {
                btn.addEventListener('click', () => {
                    applyRangeChoice(presetRange(btn.getAttribute('data-preset')));
                });
            });

            [['.tee-date-start', 'start'], ['.tee-date-end', 'end']].forEach((pair) => {
                const el = container.querySelector(pair[0]);
                if (!el) return;
                // 输入即时记入草稿，这样面板因数据更新而重绘时不会丢掉未点「应用」的内容；
                // 同时把另一侧顶进合法范围，日历面板随之开到最近可选的月份
                el.addEventListener('input', () => {
                    _rangeDraft[pair[1]] = el.value || '';
                    constrainRangeInput(container, pair[1]);
                });
                el.addEventListener('blur', () => {
                    // blur 事件触发时 activeElement 常常还没换走（尤其是从起始日 Tab 到结束日），
                    // 直接在事件里重绘会被上面那道聚焦保护挡掉。放到下一拍判断：
                    // 换到另一个日期框时仍然不打断，离开控件后才补上被推迟的重绘
                    setTimeout(() => {
                        if (!_rangeHint.active) renderDashboard();
                    }, 0);
                });
            });

            const applyBtn = container.querySelector('.tee-range-apply');
            if (!applyBtn) return;
            applyBtn.addEventListener('click', () => {
                const start = _rangeDraft.start || '';
                const end = _rangeDraft.end || '';
                if (!start && !end) {
                    _rangeHint = { active: false, text: '请先填写起始日或结束日' };
                    renderDashboard(true);
                    return;
                }
                // 'YYYY-MM-DD' 定长零填充，字典序即日期序
                if (start && end && start > end) {
                    _rangeHint = { active: false, text: '起始日不能晚于结束日，区间未变更' };
                    renderDashboard(true);
                    return;
                }
                applyRangeChoice({
                    preset: RANGE_CUSTOM,
                    start: start || null,
                    end: end || null
                });
            });
        }

        function cards(stats) {
            // 区间口径与「全部」口径分开出卡：选中区间后，今日 / 近 7 天 / 本月
            // 这些以当前时刻为基准的卡片会集体变成 0，读起来像是算错了
            const items = stats.rangeActive
                ? [
                    ['区间积分消耗', formatNumber(stats.totalCredits)],
                    ['区间内' + PLATFORM.unitLabel + '数', String(stats.totalSessions)]
                ]
                : [
                    ['总积分消耗', formatNumber(stats.totalCredits)],
                    ['今日积分消耗', formatNumber(stats.todayCredits)],
                    ['近 7 天积分消耗', formatNumber(stats.sevenDaysCredits)],
                    ['本月积分消耗', formatNumber(stats.monthCredits)],
                    [PLATFORM.unitLabel + '总数', String(stats.totalSessions)]
                ];
            // 缺侧的区间（只填起始或只填结束）算不出跨度，就不给日均，避免用一个猜出来的分母
            if (stats.rangeActive && stats.rangeDays > 0) {
                items.splice(1, 0, ['区间日均消耗', formatNumber(stats.totalCredits / stats.rangeDays)]);
            }
            if (stats.entitlementCredits > 0) {
                items.push(['已购权益额度', formatNumber(stats.entitlementCredits)]);
            }
            items.push(['数据更新时间', stats.lastUpdate, true]);

            return '<div class="tee-stats">' + items.map((it) => '' +
                '<div class="tee-card">' +
                '<div class="tee-label">' + escapeHtml(it[0]) + '</div>' +
                '<div class="tee-value' + (it[2] ? ' tee-time' : '') + '">' + escapeHtml(String(it[1])) + '</div>' +
                '</div>'
            ).join('') + '</div>';
        }

        function section(title, body) {
            return '<div class="tee-section"><h4>' + escapeHtml(title) + '</h4>' + body + '</div>';
        }

        function footer(note, stats) {
            const extra = stats.unparsedTime > 0
                ? '<div class="tee-note">有 ' + stats.unparsedTime + ' 条记录时间无法解析，未计入日维度统计</div>'
                : '';
            // 恢复备份是重置的撤销点，只在确实存在备份时才出现——常驻一个点不动的
            // 按钮等于让用户每次都在一个无意义的入口上做判断。
            // 诊断信息用脚本自身的 GM 存储读取（数据存在油猴存储里，页面控制台读不到）。
            const backup = readBackup();
            const tools = '<div class="tee-tools">' +
                '<button class="tee-tool tee-diag" type="button">复制诊断信息</button>' +
                (backup
                    ? '<button class="tee-tool tee-restore" type="button">恢复备份（' +
                      backup.sessions.length + ' 条 · ' + fmtDateTime(new Date(backup.at)) + '）</button>'
                    : '') +
                '<button class="tee-tool tee-reset" type="button">重置本页数据</button>' +
                '</div>';
            return '<div class="tee-footer"><div class="tee-note">' + escapeHtml(note) + '</div>' + extra +
                tools + '</div>';
        }

        // 诊断数据：按日聚合 + 全部记录的内容明细，用于排查本地存储被污染的形态
        function diagnosticPayload() {
            const store = DataStore.get();
            const sessions = Array.isArray(store.usage_sessions) ? store.usage_sessions : [];
            const daily = {};
            sessions.forEach((s) => {
                const rs = readSession(s);
                // Trae 的 time 是秒级数字、WorkBuddy 是时间字符串，直接 slice(0,10) 对前者
                // 取出来的是整条时间戳（每条记录自成一天）。统一先过 parseTime 再落到本地日
                const ts = parseTime(rs.time);
                if (!ts) return;
                const day = fmtDate(new Date(ts));
                if (!daily[day]) daily[day] = { sum: 0, count: 0 };
                daily[day].sum = Math.round((daily[day].sum + rs.credit) * 100) / 100;
                daily[day].count += 1;
            });
            return JSON.stringify({
                platform: PLATFORM.id,
                version: VERSION,
                handler: (typeof GM_info !== 'undefined' && GM_info)
                    ? ((GM_info.scriptHandler || '?') + ' ' + (GM_info.version || '')).trim()
                    : '(未知)',
                count: sessions.length,
                backup: (function () {
                    const b = readBackup();
                    return b ? { at: fmtDateTime(new Date(b.at)), count: b.sessions.length } : null;
                })(),
                range: { preset: _range.preset, start: _range.start, end: _range.end },
                rangeHint: _rangeHint.text,
                // 只导出参数形态与请求头的**名称**：请求头的值里是鉴权凭据，不能带出去
                pageRequest: _lastApiRequest.url
                    ? {
                        url: _lastApiRequest.url,
                        body: _lastApiRequest.body,
                        headerNames: Object.keys(_lastApiRequest.headers || {})
                    }
                    : null,
                rangeRequest: _lastRangeRequest,
                daily: daily,
                // 只导出「时间 | 模型 | 积分」这类元数据。会话详情不进诊断信息——
                // QwenWork 的详情列就是用户的提问原文，而这段文本是要贴给别人看的，
                // 截断或打码都仍是把内容带了出去。排查重复/污染靠时间、模型、金额与条数足够了。
                records: sessions.map((s) => {
                    const rs = readSession(s);
                    // 时间列统一成本地 'YYYY-MM-DD HH:mm:ss'。Trae 存的是秒级数字，原样导出
                    // 就是一串裸时间戳（1791345764），与 WorkBuddy / QwenWork 的日期串不是一个形态，
                    // 贴出来没法读。解析不出时间的记录仍要出现在导出里，否则条数对不上。
                    const ts = parseTime(rs.time);
                    const timeLabel = ts ? fmtDateTime(new Date(ts)) : (rs.time || '（无时间）');
                    return timeLabel + ' | ' + rs.model + ' | ' + rs.credit;
                })
            }, null, 1);
        }

        function copyText(text, done) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
                return;
            }
            fallbackCopy(text, done);
        }

        function fallbackCopy(text, done) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                done();
            } catch (e) {
                warn('复制诊断信息失败:', e);
            }
            ta.remove();
        }

        // 用量为 0 时不画条。留一段保底宽度会让人以为这里有一点消耗。
        function barHtml(credits, max) {
            if (!(credits > 0)) return '';
            const pct = Math.max((credits / max) * 100, 0.5).toFixed(1);
            return '<div class="tee-bar" style="width:' + pct + '%"></div>';
        }

        function renderBreakdown(rows, unitLabel, childLabel) {
            if (!rows.length) {
                // 区间模式下的空白通常是「这一段时间没有消耗」，不是「没采到数据」，
                // 两种情况要给不同的话，否则用户会以为脚本坏了
                if (_range.start || _range.end) {
                    return '<div class="tee-empty">所选区间 ' + escapeHtml(rangeLabel(_range)) +
                        ' 内没有消耗记录（点「全部」可查看全部已采集记录）</div>';
                }
                return '<div class="tee-empty">暂无数据，请先在 ' + escapeHtml(PLATFORM.label) + ' 产生一次调用</div>';
            }
            const max = Math.max.apply(null, rows.map((r) => r.credits).concat([1]));
            return '<div class="tee-chart">' + rows.map((r) => {
                return '' +
                    '<div class="tee-row">' +
                    '<div class="tee-name" title="' + escapeAttr(r.name) + '">' + escapeHtml(r.name) + '</div>' +
                    '<div class="tee-bar-wrap">' + barHtml(r.credits, max) + '</div>' +
                    '<div class="tee-amount">' + formatNumber(r.credits) + ' 积分</div>' +
                    '<div class="tee-count">' + r.calls + ' ' + unitLabel + '</div>' +
                    '</div>' + renderSubBreakdown(r, childLabel);
            }).join('') + '</div>';
        }

        /**
         * 未分类聚合条目（「未知使用端」「过期积分」这类）的下级明细。
         * 只要有一项构成就渲染：即便只有一项，也能回答「这一行的数字由什么组成」。
         * 默认收起，所以不会因此变拥挤。
         */
        function renderSubBreakdown(row, childLabel) {
            const children = row.children || [];
            if (children.length === 0) return '';
            // 仅有一项且与父条目同名时，展开不会带来任何新信息
            if (children.length === 1 && children[0].name === row.name) return '';
            // 下级只有一个占位名时同样没有信息量（例如该平台没有可用的次级字段）
            if (children.length === 1 && isPlaceholderLabel(children[0].name)) return '';

            const key = PLATFORM.id + '|' + childLabel + '|' + row.name;
            const max = Math.max.apply(null, children.map((c) => c.credits).concat([1]));

            return '' +
                '<details class="tee-sub" data-subkey="' + escapeAttr(key) + '">' +
                '<summary class="tee-sub-summary">按' + escapeHtml(childLabel) + '细分 · ' + children.length + ' 项</summary>' +
                '<div class="tee-sub-body">' + children.map((c) => {
                    return '' +
                        '<div class="tee-sub-row">' +
                        '<div class="tee-name tee-sub-name" title="' + escapeAttr(c.name) + '">' + escapeHtml(c.name) + '</div>' +
                        '<div class="tee-bar-wrap tee-sub-bar-wrap">' + barHtml(c.credits, max) + '</div>' +
                        '<div class="tee-amount">' + formatNumber(c.credits) + ' 积分</div>' +
                        '<div class="tee-count">' + c.calls + '</div>' +
                        '</div>';
                }).join('') + '</div></details>';
        }

        function renderTrendChart(trend) {
            if (!trend.length) {
                return '<div class="tee-empty">' +
                    ((_range.start || _range.end) ? '所选区间内没有按日消耗记录' : '暂无趋势数据') +
                    '</div>';
            }
            const max = Math.max.apply(null, trend.map((d) => d.cents).concat([1]));
            // 柱子一多，柱顶的数值标签就会互相压住（标签是绝对定位、不换行的）：
            // 超过 12 根收起数值标签，数值改由悬停 title 提供；超过 20 根再隔柱隐去日期标签
            const classes = ['tee-trend'];
            if (trend.length > 12) classes.push('tee-trend-dense');
            if (trend.length > 20) classes.push('tee-trend-crowded');
            return '<div class="' + classes.join(' ') + '">' + trend.map((d) => {
                const pct = Math.max((d.cents / max) * 100, 1).toFixed(1);
                const valueText = formatNumber(d.cents / 100) + ' 积分 · ' + d.calls + ' 次';
                return '' +
                    '<div class="tee-trend-col">' +
                    '<div class="tee-trend-bar" title="' + escapeAttr(d.date + '：' + valueText) +
                    '" style="height:' + pct + '%">' +
                    '<span class="tee-trend-value">' + escapeHtml(formatNumber(d.cents / 100)) + '</span>' +
                    '</div>' +
                    // 按周聚合时行内已带好标签（周起始日 + 「周」），不再退回按日的 MM-DD
                    '<div class="tee-trend-label">' + escapeHtml(d.label || d.date.substring(5)) + '</div>' +
                    '</div>';
            }).join('') + '</div>';
        }

        function formatNumber(value) {
            const n = num(value);
            const rounded = Math.round(n * 100) / 100;
            if (Math.abs(rounded) >= 10000) return (rounded / 10000).toFixed(1) + '万';
            return rounded.toFixed(2);
        }

        function escapeHtml(str) {
            if (str === undefined || str === null) return '';
            const div = document.createElement('div');
            div.textContent = String(str);
            return div.innerHTML;
        }

        // escapeHtml 走 textContent，不会转义双引号；属性值必须再用它包一层，
        // 否则模型名/详情里的 `"` 会截断 title、data-subkey 等属性。
        function escapeAttr(str) {
            return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        /**
         * 是否仍在用量页。SPA 切路由时 pathname / hash 会变，
         * 而脚本只在启动时判定过一次平台，因此这里必须用实时值重新判断。
         * 不在用量页时：移除面板且不重建；回到用量页时由观察器自动恢复。
         */
        function isOnUsagePage() {
            if (window.location.hostname !== HOST) return false;
            const paths = PLATFORM.pagePaths || (PLATFORM.pagePath ? [PLATFORM.pagePath] : []);
            if (!paths.some((p) => window.location.pathname.indexOf(p) === 0)) return false;
            const hash = window.location.hash;
            // 页面带 hash 时（如 Trae 用 hash 切换 Tab），hash 不指向用量页就隐藏
            if (PLATFORM.pageHash && hash && hash.indexOf(PLATFORM.pageHash) === -1) return false;
            return true;
        }

        function removePanel() {
            const panel = document.getElementById('trae-enhancer-root');
            if (panel) {
                panel.remove();
                log('已离开用量页，面板已移除');
            }
        }

        /**
         * 找到「面板该插到哪里」。
         * 目标是插进页面自身的滚动容器内、并置于内容顶部——这样面板与页面共用同一条滚动条，
         * 且宽度与页面的内容栅格对齐（沿用其内边距），不会看起来像外挂进来的一块。
         * 返回 { parent, before }：插到 before 之前；before 为 null 时插为 parent 的首个子节点。
         */
        function findMountTarget() {
            const candidates = PLATFORM.mountSelectors || [];
            for (const sel of candidates) {
                let el = null;
                try {
                    el = document.querySelector(sel);
                } catch (e) {
                    continue;
                }
                if (!el) continue;

                // 卡片类 landmark（以 . 开头）：借它定位「内容列」，再把面板放到整个内容区的最顶端，
                // 同时沿用该列的宽度约束，保证面板与页面卡片同宽、居中对齐。
                if (sel.charAt(0) === '.') {
                    const root = el.closest('main') || document.body;
                    let col = el;
                    while (col.parentElement && col.parentElement !== root) col = col.parentElement;
                    const mw = getComputedStyle(col).maxWidth;
                    return {
                        parent: root,
                        before: root.firstElementChild,
                        maxWidth: (mw && mw !== 'none') ? mw : null
                    };
                }

                // 容器类 landmark：插为该容器的首个子节点（即内容区顶部）
                return { parent: el, before: el.firstElementChild };
            }
            return null;
        }

        let _mountSettled = false;

        // 把面板放到目标位置；若目标带了宽度约束（页面内容列是定宽居中时），一并沿用，
        // 这样面板与页面卡片同宽对齐，而不是撑满整个视口
        function placePanel(container, target) {
            if (target.maxWidth) {
                container.style.setProperty('--tee-max-width', target.maxWidth);
            } else {
                container.style.removeProperty('--tee-max-width');
            }
            target.parent.insertBefore(container, target.before || null);
        }

        function getOrCreateContainer() {
            let container = document.getElementById('trae-enhancer-root');
            if (container) {
                ensureMount(container);
                return container;
            }

            container = document.createElement('div');
            container.id = 'trae-enhancer-root';
            if (PLATFORM.themeClass) container.classList.add(PLATFORM.themeClass);
            _mountSettled = false;

            let target = findMountTarget();
            if (!target) {
                // 兜底：按常见容器顺序找一个能放的位置，同样置顶
                const fallback = document.querySelector('main') ||
                    document.querySelector('#root') ||
                    document.querySelector('#app') ||
                    document.body;
                if (fallback) target = { parent: fallback, before: fallback.firstElementChild };
            }
            if (!target || !target.parent) return null;

            try {
                placePanel(container, target);
                log('面板已挂载到 ' + target.parent.tagName + '（置顶）');
            } catch (e) {
                warn('面板挂载失败:', e);
                return null;
            }
            _mountSettled = !!findMountTarget();
            return container;
        }

        /**
         * 这三个页面都是 SPA：理想的挂载点（Tab 内容区、卡片容器）通常在首帧之后才渲染出来。
         * 位置没落到位之前，每次 DOM 变化与渲染都顺手校正一次；一旦落位就不再重复检查。
         */
        function ensureMount(container) {
            if (_mountSettled) return;
            const target = findMountTarget();
            if (!target || !target.parent) return;
            if (container.parentElement !== target.parent) {
                try {
                    placePanel(container, target);
                    log('面板已迁移到目标位置: ' + target.parent.tagName);
                } catch (e) {
                    return;
                }
            }
            _mountSettled = true;
        }

        /* ================================================================== *
         * 9. 样式（深色为默认，浅色主题通过 class 覆盖）
         * ================================================================== */

        // 样式注入：优先用宿主的 GM_addStyle，未实现时退回原生 <style> 注入。
        // 管理器无关原则的一部分——凡由宿主实现的 GM 接口都必须有兜底，
        // 否则换个管理器整个面板就没有样式了。
        function addStyle(css) {
            const inject = () => {
                const el = document.createElement('style');
                el.setAttribute('data-tee-style', '1');
                el.textContent = css;
                (document.head || document.documentElement).appendChild(el);
            };
            if (typeof GM_addStyle === 'function') {
                GM_addStyle(css);
                return;
            }
            // document-start 时 head 尚未解析出来，挂到 DOMContentLoaded 再注入
            if (document.head || document.documentElement) inject();
            else document.addEventListener('DOMContentLoaded', inject, { once: true });
        }

        // 样式注入单独兜底：样式失败不应连累数据采集与统计
        try {
            addStyle(`
        /* ==================================================================
         * 设计变量：三套主题共用同一套组件规范，只替换变量
         * 取值来自各页面自身的实测 token（底色 / 描边 / 圆角 / 强调色 / 字体）
         * ================================================================== */
        #trae-enhancer-root {
            /* Trae：深色，卡片 6px 圆角，主按钮为亮绿底 + 近黑文字 */
            --tee-bg: rgba(224, 226, 242, 0.04);
            --tee-surface: rgba(224, 226, 242, 0.06);
            --tee-track: rgba(224, 226, 242, 0.10);
            --tee-border: rgba(224, 226, 242, 0.12);
            --tee-text: #D1D3DB;
            --tee-text-dim: #9A9FAC;
            --tee-text-mute: #868C99;
            --tee-accent: #32F08C;
            --tee-bar-from: #1FB86A;
            --tee-bar-to: #32F08C;
            --tee-btn-bg: #32F08C;
            --tee-btn-hover: #4CF59E;
            --tee-btn-fg: #0C0C0D;
            --tee-radius: 6px;
            --tee-radius-in: 6px;
            --tee-radius-btn: 4px;
            --tee-font: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            --tee-value-size: 22px;

            margin: 0 auto 16px !important;
            padding: 16px !important;
            width: 100%;
            max-width: var(--tee-max-width, 100%);
            box-sizing: border-box;
            background: var(--tee-bg);
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius);
            color: var(--tee-text);
            font-family: var(--tee-font);
            font-size: 14px;
            line-height: 1.6;
            /* 原生日期控件的日历图标与弹层配色要和面板底色一致，否则深色面板里嵌着白控件 */
            color-scheme: dark;
        }

        #trae-enhancer-root.qwenwork-theme {
            /* QwenWork：浅色。大卡片为白底 + 16px 圆角 + 极细描边，内层用 4% 黑；强调色取品牌紫 */
            --tee-bg: #FFFFFF;
            --tee-surface: rgba(20, 20, 20, 0.04);
            --tee-track: rgba(20, 20, 20, 0.07);
            --tee-border: rgba(20, 20, 20, 0.10);
            --tee-text: #141414;
            --tee-text-dim: rgba(20, 20, 20, 0.65);
            --tee-text-mute: rgba(20, 20, 20, 0.55);
            --tee-accent: #5B4DFF;
            --tee-bar-from: #8D82FF;
            --tee-bar-to: #5B4DFF;
            --tee-btn-bg: rgba(20, 20, 20, 0.04);
            --tee-btn-hover: rgba(20, 20, 20, 0.09);
            --tee-btn-fg: #141414;
            --tee-radius: 16px;
            --tee-radius-in: 12px;
            --tee-radius-btn: 999px;
            --tee-font: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
            --tee-value-size: 22px;
            color-scheme: light;
        }

        #trae-enhancer-root.workbuddy-theme {
            /* WorkBuddy：浅色控制台。白卡片 24px 圆角，内层 #F5F7FA，品牌青绿 */
            --tee-bg: #FFFFFF;
            --tee-surface: #F5F7FA;
            --tee-track: rgba(51, 51, 51, 0.06);
            --tee-border: rgba(0, 0, 0, 0.08);
            --tee-text: #1B1A24;
            --tee-text-dim: #6B7280;
            --tee-text-mute: #6E747E;
            --tee-accent: #00836A;
            --tee-bar-from: #8DB8AA;
            --tee-bar-to: #00C29A;
            --tee-btn-bg: rgba(0, 0, 0, 0.86);
            --tee-btn-hover: rgba(0, 0, 0, 0.72);
            --tee-btn-fg: #FFFFFF;
            --tee-radius: 24px;
            --tee-radius-in: 16px;
            --tee-radius-btn: 12px;
            --tee-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
            --tee-value-size: 24px;
            color-scheme: light;
        }

        /* ---------------- 通用组件（全部相对变量书写，不写死颜色） ---------------- */

        #trae-enhancer-root .tee-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 0 0 14px !important;
            padding: 0 0 12px !important;
            border-bottom: 1px solid var(--tee-border);
        }
        #trae-enhancer-root .tee-header h3 {
            margin: 0 !important;
            font-size: 15px;
            font-weight: 600;
            color: var(--tee-text);
        }
        #trae-enhancer-root .tee-badge {
            padding: 2px 8px !important;
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius-btn);
            background: var(--tee-surface);
            color: var(--tee-text-dim);
            font-size: 11px;
            white-space: nowrap;
        }
        #trae-enhancer-root .tee-btn {
            margin-left: auto !important;
            padding: 6px 14px !important;
            border: 1px solid transparent;
            border-radius: var(--tee-radius-btn);
            background: var(--tee-btn-bg);
            color: var(--tee-btn-fg);
            font-family: inherit;
            font-size: 12px;
            line-height: 1.4;
            cursor: pointer;
            transition: background-color 0.15s ease;
        }
        #trae-enhancer-root .tee-btn:hover { background: var(--tee-btn-hover); }
        #trae-enhancer-root .tee-btn:active { transform: translateY(1px); }
        #trae-enhancer-root .tee-btn:focus-visible {
            outline: 2px solid var(--tee-accent);
            outline-offset: 2px;
        }

        /* ---------------- 日期范围筛选 ---------------- */

        #trae-enhancer-root .tee-range {
            margin: 0 0 14px !important;
            padding: 10px 12px !important;
            background: var(--tee-surface);
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius-in);
        }
        #trae-enhancer-root .tee-range-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        #trae-enhancer-root .tee-range-title {
            flex: 0 0 auto;
            font-size: 12px;
            color: var(--tee-text-dim);
        }
        #trae-enhancer-root .tee-range-chips,
        #trae-enhancer-root .tee-range-custom {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
        }
        #trae-enhancer-root .tee-range-custom { margin-left: auto !important; }
        /* .tee-btn 自带 margin-left:auto（为页头的「刷新页面」而设），这里必须收回来，
           否则「应用」会被推到最右侧、与结束日期输入框脱开 */
        #trae-enhancer-root .tee-range-custom .tee-btn { margin-left: 0 !important; }
        #trae-enhancer-root .tee-range-dash {
            font-size: 12px;
            color: var(--tee-text-mute);
        }
        #trae-enhancer-root .tee-chip {
            margin: 0 !important;
            padding: 4px 10px !important;
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius-btn);
            background: transparent;
            color: var(--tee-text-dim);
            font-family: inherit;
            font-size: 12px;
            line-height: 1.5;
            cursor: pointer;
            transition: background-color 0.15s ease, color 0.15s ease;
        }
        #trae-enhancer-root .tee-chip:hover {
            background: var(--tee-track);
            color: var(--tee-text);
        }
        /* 当前生效的区间用强调色描边，与「刷新页面」那类动作按钮区分开 */
        #trae-enhancer-root .tee-chip-on {
            border-color: var(--tee-accent);
            background: var(--tee-track);
            color: var(--tee-accent);
        }
        #trae-enhancer-root .tee-date {
            margin: 0 !important;
            padding: 4px 8px !important;
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius-btn);
            background: transparent;
            color: var(--tee-text);
            font-family: inherit;
            font-size: 12px;
            line-height: 1.4;
        }
        #trae-enhancer-root .tee-chip:focus-visible,
        #trae-enhancer-root .tee-date:focus-visible {
            outline: 2px solid var(--tee-accent);
            outline-offset: 1px;
        }
        #trae-enhancer-root .tee-range-notes {
            margin: 8px 0 0 !important;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        #trae-enhancer-root .tee-range-note {
            font-size: 11px;
            line-height: 1.6;
            color: var(--tee-text-mute);
        }

        #trae-enhancer-root .tee-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin: 0 0 16px !important;
        }
        #trae-enhancer-root .tee-card {
            padding: 12px 14px !important;
            background: var(--tee-surface);
            border: 1px solid var(--tee-border);
            border-radius: var(--tee-radius-in);
        }
        #trae-enhancer-root .tee-label {
            margin: 0 0 4px !important;
            font-size: 12px;
            color: var(--tee-text-dim);
        }
        #trae-enhancer-root .tee-value {
            font-size: var(--tee-value-size);
            font-weight: 600;
            line-height: 1.25;
            color: var(--tee-accent);
            font-variant-numeric: tabular-nums;
        }
        #trae-enhancer-root .tee-time {
            font-size: 12px;
            font-weight: 400;
            color: var(--tee-text-dim);
        }

        #trae-enhancer-root .tee-section { margin: 0 0 16px !important; }
        #trae-enhancer-root .tee-section h4 {
            margin: 0 0 8px !important;
            font-size: 13px;
            font-weight: 600;
            color: var(--tee-text);
        }
        #trae-enhancer-root .tee-empty {
            padding: 16px !important;
            background: var(--tee-surface);
            border-radius: var(--tee-radius-in);
            color: var(--tee-text-mute);
            font-size: 12px;
            text-align: center;
        }

        #trae-enhancer-root .tee-chart { display: flex; flex-direction: column; gap: 4px; }
        #trae-enhancer-root .tee-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 0 -6px !important;
            padding: 4px 6px !important;
            border-radius: var(--tee-radius-in);
            transition: background-color 0.15s ease;
        }
        #trae-enhancer-root .tee-row:hover { background: var(--tee-surface); }
        #trae-enhancer-root .tee-name {
            flex: 0 0 170px;
            min-width: 0;
            font-size: 12px;
            color: var(--tee-text);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #trae-enhancer-root .tee-bar-wrap {
            flex: 1 1 auto;
            min-width: 40px;
            height: 20px;
            border-radius: 999px;
            background: var(--tee-track);
            overflow: hidden;
        }
        #trae-enhancer-root .tee-bar {
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, var(--tee-bar-from), var(--tee-bar-to));
            transition: width 0.4s ease;
        }
        #trae-enhancer-root .tee-amount {
            flex: 0 0 84px;
            text-align: right;
            font-size: 12px;
            color: var(--tee-accent);
            font-variant-numeric: tabular-nums;
        }
        #trae-enhancer-root .tee-count {
            flex: 0 0 62px;
            text-align: right;
            font-size: 11px;
            color: var(--tee-text-dim);
            font-variant-numeric: tabular-nums;
        }

        #trae-enhancer-root .tee-sub { margin: 0 0 2px !important; }
        #trae-enhancer-root .tee-sub-summary {
            display: block;
            margin: 0 0 0 6px !important;
            padding: 2px 6px !important;
            border-radius: var(--tee-radius-btn);
            color: var(--tee-text-dim);
            font-size: 11px;
            list-style: none;
            cursor: pointer;
            user-select: none;
            transition: background-color 0.15s ease, color 0.15s ease;
        }
        #trae-enhancer-root .tee-sub-summary::-webkit-details-marker { display: none; }
        #trae-enhancer-root .tee-sub-summary::before { content: '▸'; display: inline-block; width: 12px; }
        #trae-enhancer-root .tee-sub[open] > .tee-sub-summary::before { content: '▾'; }
        #trae-enhancer-root .tee-sub-summary:hover {
            background: var(--tee-surface);
            color: var(--tee-text);
        }
        #trae-enhancer-root .tee-sub-summary:focus-visible {
            outline: 2px solid var(--tee-accent);
            outline-offset: 1px;
        }
        #trae-enhancer-root .tee-sub-body { padding: 2px 0 2px 20px !important; }
        #trae-enhancer-root .tee-sub-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 0 -6px !important;
            padding: 2px 6px !important;
            border-radius: var(--tee-radius-in);
            transition: background-color 0.15s ease;
        }
        #trae-enhancer-root .tee-sub-row:hover { background: var(--tee-surface); }
        #trae-enhancer-root .tee-sub-name { flex: 0 0 154px; font-size: 11px; color: var(--tee-text-dim); }
        #trae-enhancer-root .tee-sub-bar-wrap { height: 10px; }
        #trae-enhancer-root .tee-sub-row .tee-amount,
        #trae-enhancer-root .tee-sub-row .tee-count { font-size: 11px; }

        #trae-enhancer-root .tee-trend {
            display: flex;
            gap: 8px;
            height: 150px;
            padding: 24px 0 0 !important;
        }
        #trae-enhancer-root .tee-trend-col {
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            height: 100%;
            justify-content: flex-end;
        }
        #trae-enhancer-root .tee-trend-bar {
            width: 100%;
            max-width: 40px;
            min-height: 4px;
            border-radius: 4px 4px 0 0;
            background: linear-gradient(180deg, var(--tee-bar-to), var(--tee-bar-from));
            position: relative;
            transition: height 0.4s ease;
        }
        #trae-enhancer-root .tee-trend-value {
            position: absolute;
            top: -17px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 10px;
            color: var(--tee-accent);
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        #trae-enhancer-root .tee-trend-label {
            margin-top: 4px !important;
            font-size: 10px;
            color: var(--tee-text-dim);
        }
        /* 柱数多时收起柱顶数值标签，并把原先为标签预留的顶部留白还给柱子 */
        #trae-enhancer-root .tee-trend-dense .tee-trend-value { display: none; }
        #trae-enhancer-root .tee-trend-dense { padding: 4px 0 0 !important; }
        /* 更密的区间里隔柱隐去日期标签（保留占位，柱子位置不动） */
        #trae-enhancer-root .tee-trend-crowded .tee-trend-col:nth-child(even) .tee-trend-label {
            visibility: hidden;
        }

        #trae-enhancer-root .tee-footer {
            margin: 12px 0 0 !important;
            padding: 12px 0 0 !important;
            border-top: 1px solid var(--tee-border);
        }
        #trae-enhancer-root .tee-note {
            font-size: 11px;
            line-height: 1.7;
            color: var(--tee-text-mute);
        }
        #trae-enhancer-root .tee-note-spaced { margin-top: 10px !important; }
        #trae-enhancer-root .tee-tools {
            margin: 10px 0 0 !important;
            display: flex;
            /* 允许换行。不给换行时三个按钮被压进同一行、各自缩窄，
               结果中文在词中间断开（「复制诊断信 / 息」）、备份的时间戳
               被折成两行——375px 下实测就是这个形态 */
            flex-wrap: wrap;
            column-gap: 14px;
            row-gap: 6px;
            align-items: center;
        }
        #trae-enhancer-root .tee-tool,
        #trae-enhancer-root .tee-reset {
            margin: 0 !important;
            padding: 0 !important;
            border: none;
            background: none;
            color: var(--tee-text-mute);
            font-family: inherit;
            font-size: 11px;
            /* 按钮文案是固定字符串，任何宽度下都不该在词中间折行；
               放不下时交给上面那行换行处理 */
            white-space: nowrap;
            text-decoration: underline;
            cursor: pointer;
        }
        #trae-enhancer-root .tee-tool:hover,
        #trae-enhancer-root .tee-reset:hover { color: var(--tee-text); }
        #trae-enhancer-root .tee-tool:focus-visible,
        #trae-enhancer-root .tee-reset:focus-visible {
            outline: 2px solid var(--tee-accent);
            outline-offset: 1px;
        }

        /* ---------------- 窄屏适配：列宽与字号收缩，避免名称被挤成空白 ---------------- */
        @media (max-width: 900px) {
            #trae-enhancer-root { padding: 14px !important; }
            #trae-enhancer-root .tee-stats {
                grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
                gap: 8px;
            }
            #trae-enhancer-root .tee-value { font-size: 19px; }
            #trae-enhancer-root .tee-name { flex-basis: 116px; }
            #trae-enhancer-root .tee-amount { flex-basis: 72px; }
            #trae-enhancer-root .tee-count { flex-basis: 52px; }
            #trae-enhancer-root .tee-sub-name { flex-basis: 100px; }
            #trae-enhancer-root .tee-trend { height: 130px; }
            /* 区间控件在窄屏改为整行换行，自定义日期不再靠 margin-left:auto 顶到右侧 */
            #trae-enhancer-root .tee-range-row { gap: 6px; }
            #trae-enhancer-root .tee-range-custom { margin-left: 0 !important; }
            #trae-enhancer-root .tee-date { padding: 3px 6px !important; }
        }

        /* ---------------- 尊重系统的「减少动态效果」设置 ---------------- */
        @media (prefers-reduced-motion: reduce) {
            #trae-enhancer-root .tee-row,
            #trae-enhancer-root .tee-sub-row,
            #trae-enhancer-root .tee-bar,
            #trae-enhancer-root .tee-trend-bar,
            #trae-enhancer-root .tee-btn,
            #trae-enhancer-root .tee-chip,
            #trae-enhancer-root .tee-sub-summary {
                transition: none !important;
            }
        }
            `);
        } catch (e) {
            warn('样式注入失败，面板将以无样式呈现:', e);
        }

        /* ================================================================== *
         * 10. 生命周期
         * ================================================================== */

        function waitForDataAndRender(maxRetries) {
            const limit = maxRetries || 30;
            renderDashboard(true);

            // QwenWork 没有可用接口，直接走 DOM 提取。
            // 首次没取到数据时继续重试：SPA 首屏渲染时机不定，一次失败不代表页面上没有数据。
            if (PLATFORM.postFetch) {
                let attempt = 0;
                const run = async () => {
                    attempt++;
                    try {
                        await PLATFORM.postFetch();
                    } catch (e) {
                        warn('页面数据提取失败:', e);
                    }
                    renderDashboard();
                    if (DataStore.count() === 0 && attempt < 6) {
                        setTimeout(run, 5000);
                    }
                };
                setTimeout(run, 500);
                return;
            }

            // WorkBuddy 新版页面默认停在「积分概览」，不会自己请求用量明细；
            // 本地有缓存时下面的 check 会直接返回，所以首屏要单独安排一次主动采集。
            // 页面若已经自己发过用量请求（例如用户手点了消耗明细）且没有产品筛选，
            // 就不再重复；带 appTypes 的请求只覆盖一个产品，仍需补一次账号级数据。
            if (PLATFORM.bootstrapOnLoad) {
                setTimeout(async () => {
                    if (!isOnUsagePage()) return;
                    const capturedBody = _lastApiRequest.body || {};
                    const capturedFiltered =
                        (Array.isArray(capturedBody.appTypes) && capturedBody.appTypes.length > 0) ||
                        (Array.isArray(capturedBody.subscribeType) && capturedBody.subscribeType.length > 0);
                    if (_lastUsageCaptureAt && Date.now() - _lastUsageCaptureAt < 5000 && !capturedFiltered) {
                        log('页面已自行请求用量接口，跳过首屏主动采集');
                        renderDashboard();
                        return;
                    }
                    await bootstrapPlatform({ force: true });
                    renderDashboard(true);
                }, 2500);
            }

            let retries = 0;
            const check = () => {
                if (DataStore.count() > 0) {
                    renderDashboard();
                    return;
                }
                retries++;
                if (retries === 3) {
                    if (PLATFORM.usageTabText) {
                        if (!_bootstrapInFlight) {
                            log('尝试打开「' + PLATFORM.usageTabText + '」触发请求…');
                            openUsageTab();
                        }
                    } else {
                        log('尝试点击时间范围按钮触发请求…');
                        triggerTimeRangeButtons();
                    }
                }
                if (retries === 5) {
                    if (!PLATFORM.bootstrapOnLoad) {
                        bootstrapPlatform();
                    } else if (!_bootstrapInFlight && DataStore.count() === 0) {
                        // 首屏那次主动采集可能因为请求头/网络原因失败，再给一次机会
                        bootstrapPlatform({ force: true });
                    }
                }
                if (retries >= limit) {
                    renderDashboard(true);
                    return;
                }
                setTimeout(check, 1000);
            };
            setTimeout(check, 2000);
        }

        function observePageChanges() {
            const observer = new MutationObserver(() => {
                // 路由切换的第一时间就处理：不在用量页则移除面板，也不重建
                if (!isOnUsagePage()) {
                    removePanel();
                    return;
                }
                const panel = document.getElementById('trae-enhancer-root');
                if (!panel) {
                    renderDashboard();
                    return;
                }
                // 挂载点可能在首帧之后才出现，落位之前顺手校正（落位后立即返回，开销可忽略）
                ensureMount(panel);
            });
            const target = document.body || document.documentElement;
            if (target) {
                observer.observe(target, { childList: true, subtree: true });
            }
        }

        function init() {
            log('初始化，平台 ' + PLATFORM.id + '，版本 v' + VERSION);
            loadRange();
            waitForDataAndRender();
            observePageChanges();

            // 定时兜底：只有数据指纹变化或面板被移除时才会真正重绘
            setInterval(() => renderDashboard(), CONFIG.refreshInterval);
        }

        // 拦截器必须在 document-start 阶段就装上：页面首屏的用量请求可能早于
        // DOMContentLoaded，晚装会漏掉请求体/请求头，只能退到默认参数兜底。
        try {
            setupNetworkInterceptor();
        } catch (e) {
            warn('网络拦截器安装失败，将依赖主动采集兜底:', e);
        }

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(init, 0);
        } else {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        }
    } catch (e) {
        console.error('[用量增强] 脚本初始化失败:', e);
    }
})();
