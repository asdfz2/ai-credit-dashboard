// ==UserScript==
// @name         Trae / QwenWork / WorkBuddy 用量仪表盘增强
// @namespace    https://github.com/asdfz2/Trae_Qwen-dashboard-enhancer
//               ↑ namespace 刻意不跟随仓库名：脚本管理器以 namespace + name 识别脚本，
//                 改掉它会让已安装用户出现新旧两个脚本并存。它只是个隐形标识，保持稳定即可。
// @version      1.11.1
// @description  在 Trae、QwenWork、WorkBuddy 用量页面添加积分消耗总数、各模型积分消耗、使用端分布与近 7 天趋势
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

        const VERSION = '1.11.1';

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
                // 插到「用量」Tab 内容区的顶部：它本身就在页面的滚动容器内，
                // 且带 32px/40px 内边距，面板因此与页面卡片同宽同左边界
                mountSelectors: ['[id$="-content-usage"]', '[role="tabpanel"]'],
                detect: () => /(^|\.)trae\.cn$/.test(HOST) && PATH.indexOf('/dashboard') === 0,
                // 面板只在用量页显示。SPA 切路由时 pathname / hash 会变，显示与否要用实时值判断。
                // Trae 的各 Tab 通过 hash 切换（#usage / #account…），离开用量 Tab 即隐藏
                pagePath: '/dashboard',
                pageHash: 'usage',
                apiUrl: 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session',

                usageApi: (url) => !!url && url.indexOf('query_user_usage_group_by_session') !== -1,

                watchApi: (url) => !!url && [
                    '/trae/api/v1/pay/',
                    '/trae/api/v2/pay/',
                    'query_user_usage_group_by_session',
                    'user_current_entitlement_list',
                    'cn_credits_billing_status',
                    'web_user_pay_status',
                    'expired_ents'
                ].some((s) => url.indexOf(s) !== -1),

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
                    return {
                        start_time: fmtDateTime(start),
                        end_time: fmtDateTime(end),
                        page_size: 20,
                        page_num: 1,
                        usage_type: [7]
                    };
                },

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
                note: '统计口径：页面中已加载的积分消耗记录。数据只存在本机浏览器。'
            },

            /* ---------------- WorkBuddy：拦截 API + 自动翻页 ---------------- */
            workbuddy: {
                id: 'workbuddy',
                label: 'WorkBuddy',
                storageKey: 'workbuddy_usage_data',
                themeClass: 'workbuddy-theme',
                unitLabel: '请求',
                // 插到 main.plans-usage 顶部：该元素位于页面的滚动容器内，其内边距
                // 会让面板与页面卡片左边界对齐
                mountSelectors: ['main.plans-usage'],
                detect: () => /(^|\.)workbuddy\.cn$/.test(HOST) && PATH.indexOf('/profile/plans-usage') === 0,
                pagePath: '/profile/plans-usage',
                apiUrl: 'https://www.workbuddy.cn/billing/meter/get-user-request-usage',

                usageApi: (url) => !!url && url.indexOf('/billing/meter/get-user-request-usage') !== -1,

                // 只关心用量明细接口：其它 billing 接口的数据页面自己会展示，不做重复呈现
                watchApi: (url) => !!url && url.indexOf('/billing/meter/get-user-request-usage') !== -1,

                extract(payload) {
                    const d = payload && payload.data;
                    if (!d || !Array.isArray(d.data)) return null;
                    return { records: d.data, total: num(d.total) };
                },

                // 只保留统计需要的字段。
                // 接口同时返回 input / inputTrunc（用户提示词原文），这里刻意丢弃，不落盘。
                normalize(raw) {
                    return {
                        session_id: String(raw.requestId || ''),
                        model_name: String(raw.model || ''),
                        usage_time: String(raw.requestTime || ''),
                        credits_float: num(raw.credit),
                        client: String(raw.client || ''),
                        purpose: String(raw.agentPurpose || '')
                    };
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

                // WorkBuddy 与 CodeBuddy 共用同一账号积分池，明细里会同时出现
                // WorkBuddy / CLI 等使用端，所以面板口径是账号级。
                note: '统计口径：账号级用量，含 WorkBuddy / CLI 等全部使用端。数据只存在本机浏览器，不含对话内容。'
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
            set(store) {
                this.cache = store;
                try {
                    GM_setValue(PLATFORM.storageKey, JSON.stringify(store));
                } catch (e) {
                    warn('本地数据写入失败:', e);
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
         * 3. 数据合并
         * ================================================================== */

        let _lastApiRequest = { url: '', method: 'POST', body: {}, headers: {} };
        let _rawFetch = null;

        // 翻页占位放在内存里，不写入本地存储。
        // 历史缺陷：曾把 _autoFetching 持久化，翻页中途关标签页会导致它永久为真、自动翻页从此失效。
        const _pagingInFlight = new Set();

        const isSuccessPayload = (p) => !!p &&
            (p.success === true || p.code === undefined || p.code === 0 || p.code === 200);

        function sanitizeHeaders(headers) {
            const out = Object.assign({}, headers || {});
            ['content-length', 'host', 'connection', 'accept-encoding'].forEach((k) => {
                delete out[k];
                delete out[k.toUpperCase()];
            });
            return out;
        }

        function computePagination(total, requestBody, records) {
            const b = requestBody || {};
            const currentPage = num(pick(b, ['pageNum', 'page_num', 'PageNumber', 'page', 'CurrentPage'])) || 1;
            const pageSize = num(pick(b, ['pageSize', 'page_size', 'PageSize', 'limit'])) || records.length || 20;
            const t = num(total);
            // 接口没给总条数时转为「自发现翻页」，靠「某页无新增」来终止
            const totalPages = t > 0
                ? Math.max(1, Math.ceil(t / Math.max(pageSize, 1)))
                : currentPage + CONFIG.maxAutoPages;
            return { currentPage, pageSize, total: t, totalPages, discovery: t <= 0 };
        }

        /**
         * 合并一份用量响应。返回 { added } 或 null（无法解析时）。
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
            let shouldWrite = false;

            if (parsed && parsed.records.length) {
                const index = new Map();
                store.usage_sessions.forEach((s, i) => {
                    const id = readSession(s).id;
                    if (id) index.set(id, i);
                });

                parsed.records.forEach((raw) => {
                    const session = PLATFORM.normalize(raw);
                    if (!session) return;
                    const id = readSession(session).id;
                    if (!id) return;
                    const prev = index.get(id);
                    if (prev === undefined) {
                        index.set(id, store.usage_sessions.length);
                        store.usage_sessions.push(session);
                        added++;
                    } else {
                        // 同一会话的最新版本覆盖旧值
                        store.usage_sessions[prev] = Object.assign({}, store.usage_sessions[prev], session);
                    }
                });

                if (store.usage_sessions.length > CONFIG.maxSessions) {
                    store.usage_sessions = store.usage_sessions.slice(-CONFIG.maxSessions);
                }
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

            if (added > 0 || extrasChanged || scrubbed) shouldWrite = true;

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
                const info = computePagination(parsed.total, requestBody, parsed.records);
                if (info.totalPages > info.currentPage) {
                    fetchAllPages(url, requestBody, info);
                }
            }

            return { added, parsed };
        }

        async function fetchAllPages(baseUrl, requestBody, info) {
            const sig = JSON.stringify(requestBody || {});
            if (_pagingInFlight.has(sig)) {
                log('该时间范围已在翻页中，跳过');
                return;
            }
            _pagingInFlight.add(sig);
            const doFetch = _rawFetch || window.fetch.bind(window);
            const lastPage = Math.min(info.totalPages, info.currentPage + CONFIG.maxAutoPages);
            log('开始自动翻页: 当前 ' + info.currentPage + '/' + lastPage + (info.discovery ? '（自发现模式）' : ''));

            try {
                for (let page = info.currentPage + 1; page <= lastPage; page++) {
                    const body = PLATFORM.continueBody(requestBody, page);
                    const headers = Object.assign(
                        { 'Content-Type': 'application/json' },
                        sanitizeHeaders(_lastApiRequest.headers)
                    );
                    let payload;
                    try {
                        const resp = await doFetch(baseUrl, {
                            method: 'POST',
                            credentials: 'include',
                            headers,
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
                    log('已取第 ' + page + ' 页，新增 ' + (r ? r.added : 0) + ' 条');
                    if (!r || r.added === 0) {
                        log('第 ' + page + ' 页无新增，停止翻页');
                        break;
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
            log('安装网络拦截器…');

            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                _rawFetch = originalFetch.bind(window);
                window.fetch = function (input, init) {
                    const url = typeof input === 'string' ? input : ((input && input.url) || '');
                    const reqInfo = {
                        url,
                        method: (init && init.method) || 'GET',
                        body: PLATFORM.usageApi(url) ? parseRequestBody(init && init.body) : {},
                        headers: normalizeHeaders(init && init.headers)
                    };
                    if (PLATFORM.usageApi(url)) _lastApiRequest = reqInfo;

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
                if (this._teeUrl && PLATFORM.usageApi(this._teeUrl) && this._teeHeaders) {
                    this._teeHeaders[String(key).toLowerCase()] = value;
                }
                return originalSetRequestHeader.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function (body) {
                const url = this._teeUrl;
                if (url && PLATFORM.watchApi(url)) {
                    const reqInfo = {
                        url,
                        method: this._teeMethod,
                        body: PLATFORM.usageApi(url) ? parseRequestBody(body) : {},
                        headers: this._teeHeaders || {}
                    };
                    if (PLATFORM.usageApi(url)) _lastApiRequest = reqInfo;
                    this.addEventListener('load', function () {
                        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                        const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                        mergePayload(reqInfo.url, payload, reqInfo.body);
                        renderDashboard();
                    });
                }
                return originalSend.apply(this, arguments);
            };
        }

        /* ================================================================== *
         * 5. 主动采集（拦截未命中时的兜底）
         * ================================================================== */

        async function bootstrapPlatform() {
            if (PLATFORM.postFetch) {
                try {
                    await PLATFORM.postFetch();
                } catch (e) {
                    warn('页面数据提取失败:', e);
                }
                renderDashboard();
                return;
            }
            if (!PLATFORM.apiUrl || !PLATFORM.defaultBody) return;
            if (DataStore.count() > 0) {
                log('已有本地数据，跳过主动采集');
                return;
            }

            // 优先复用页面自己发过的请求（参数与鉴权头都是现成的），否则用平台默认参数
            const captured = _lastApiRequest.url ? _lastApiRequest : null;
            const url = captured ? captured.url : PLATFORM.apiUrl;
            const body = captured ? captured.body : PLATFORM.defaultBody();
            if (!body || Object.keys(body).length === 0) {
                log('拿不到可用的请求参数，跳过主动采集');
                return;
            }

            log('主动采集:', url, body);
            try {
                const doFetch = _rawFetch || window.fetch.bind(window);
                const headers = Object.assign(
                    { 'Content-Type': 'application/json' },
                    sanitizeHeaders(captured ? captured.headers : {})
                );
                const resp = await doFetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: JSON.stringify(body)
                });
                if (!resp.ok) {
                    warn('主动采集失败，HTTP ' + resp.status);
                    return;
                }
                const payload = await resp.json();
                mergePayload(url, payload, body);
                renderDashboard();
            } catch (e) {
                warn('主动采集异常:', e);
            }
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

        // 先在小范围交互元素里找，找不到再回退到全页扫描（避免每次都遍历整棵 DOM 读 innerText）
        function findQwenworkUsedTab() {
            const quick = document.querySelectorAll('button, [role="tab"], [role="button"], [class*="tab"]');
            for (const el of quick) {
                if (el.children.length === 0 && (el.innerText || '').trim() === '已使用') return el;
            }
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (el.children.length === 0 && (el.innerText || '').trim() === '已使用') return el;
            }
            return null;
        }

        function findQwenworkDataContainer() {
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

        // 上一次解析的结构化统计，仅用于诊断输出（只记数量，不记内容）
        let _lastQwenworkParse = { dateLines: 0, amountLines: 0, textLength: 0 };

        // 读取金额。优先按原样解析，取不到再退回「从行内找第一个带符号的数字」
        function readSignedAmount(line) {
            const raw = String(line || '');
            const compact = raw.replace(/[,，\s]/g, '');
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
            const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
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

            // 「已使用」区域里的金额通常带负号。若页面改成渲染成正数，
            // 则回退按正数处理，避免整页一条都取不到。
            const negatives = found.filter((r) => r.amount < 0);
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
        function qwenworkId(time, source, detail, amount) {
            return 'qw-' + time + '|' + (source || '未知来源') + '|' + (detail || '') + '|' + num(amount);
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
                if (store.usage_sessions.length > CONFIG.maxSessions) {
                    store.usage_sessions = store.usage_sessions.slice(-CONFIG.maxSessions);
                }
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

        async function bootstrapQwenwork() {
            const tab = await waitForQwenworkTab(15000);
            if (tab) {
                try {
                    tab.click();
                } catch (e) {
                    warn('QwenWork: 点击「已使用」失败:', e);
                }
            } else {
                log('QwenWork: 未找到「已使用」入口');
            }

            const records = await waitForQwenworkRecords(15000);
            if (records.length === 0) {
                warn('QwenWork: 未能在页面上解析出积分消耗记录（匹配日期行 ' +
                    _lastQwenworkParse.dateLines + ' 条，数据区文本长度 ' +
                    _lastQwenworkParse.textLength +
                    '）。把脚本里的 DEBUG 改为 true 后重新加载页面，可在控制台看到详细流程');
                return 0;
            }

            const before = DataStore.count();
            mergeQwenworkRecords(records);

            // 页面可能停留在上次采集遗留的页码上：先退回第 1 页再重新解析一次，
            // 保证拿到的是最新的记录（列表按时间倒序，新记录总在第 1 页）
            await returnToFirstPage();
            const fresh = await waitForQwenworkRecords(8000);
            if (fresh.length > 0) mergeQwenworkRecords(fresh);

            // 首页（最新一页）没有新记录时，更早的页也不可能有新记录（列表按时间倒序）。
            // 跳过翻页：既省请求，也避免把页码留在中途——否则用户下次进来看到的不是最新记录
            if (DataStore.count() === before) {
                log('QwenWork: 记录均已采集过，跳过翻页');
                return records.length;
            }

            try {
                await fetchAllQwenworkPagesFromDOM();
            } catch (e) {
                warn('QwenWork 翻页失败:', e);
            }
            return records.length;
        }

        async function fetchAllQwenworkPagesFromDOM() {
            let container = findQwenworkDataContainer();
            if (!container) {
                log('QwenWork: 未找到数据容器，跳过翻页');
                return false;
            }
            mergeQwenworkRecords(parseRecordsFromQwenworkDOM(container));

            let page = 1;
            while (page < CONFIG.maxAutoPages) {
                const pagination = findPaginationContainer();
                if (!pagination) {
                    log('QwenWork: 未找到翻页控件，只有一页');
                    break;
                }
                const nextBtn = findNextPageButton(pagination);
                if (!nextBtn || nextBtn.disabled ||
                    nextBtn.classList.contains('disabled') ||
                    nextBtn.getAttribute('aria-disabled') === 'true') {
                    log('QwenWork: 已到最后一页');
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
                const added = mergeQwenworkRecords(parseRecordsFromQwenworkDOM(container));
                log('QwenWork: 第 ' + page + ' 页新增 ' + added + ' 条');
                if (added === 0) break;
            }

            // 采集完把分页退回第 1 页：否则页面停留在最后一页，
            // 用户下次进来看到的就不是最新的记录
            await returnToFirstPage();
            return true;
        }

        // 把分页退回第 1 页。页面自己会记住页码，采集完不退回的话，
        // 用户下次进入时看到的就不是最新的记录。
        async function returnToFirstPage() {
            const pagination = findPaginationContainer();
            if (!pagination) return;
            const nodes = pagination.querySelectorAll('li, button, a, span, [role="button"]');
            for (const el of nodes) {
                if ((el.textContent || '').trim() !== '1') continue;
                try {
                    el.click();
                } catch (e) {
                    return;
                }
                await sleep(1200);
                log('QwenWork: 分页已退回第 1 页');
                return;
            }
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
                // 统一成 ISO 风格再交给 Date 解析，"2026-09-13 18:02:00" 在部分环境解析不稳
                const normalized = raw.trim().replace(' ', 'T');
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
                out.push({ name: name || MODEL_PLACEHOLDER, cents: Math.round(credit * 100) });
            });
            return out.length ? out : null;
        }

        function computeStats(sessions, store) {
            const now = new Date();
            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);
            const todayStr = fmtDate(todayStart);

            const sevenDaysStart = new Date(todayStart);
            sevenDaysStart.setDate(sevenDaysStart.getDate() - 6);

            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            monthStart.setHours(0, 0, 0, 0);

            let totalCents = 0;
            const modelMap = new Map();
            const clientMap = new Map();
            const dailyMap = new Map();
            // 未分类聚合条目的下级明细：仅模型桶需要（模型桶本身就是模型维度，只能按详情细分）
            const modelChildMap = new Map();
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

                // 原样展示采集到的模型标识：'-' 就是页面给出的「未公布」，不改写成别的说法
                const model = s.model || MODEL_PLACEHOLDER;

                // 模型维度优先按 usage_group_details 归属；没有该字段（QwenWork / WorkBuddy）时
                // 回退到会话级的模型名
                const groups = readModelGroups(raw);
                if (groups) {
                    groups.forEach((g) => {
                        bumpModel(g.name, g.cents);
                        if (isFallbackLabel(g.name)) {
                            bumpChild(modelChildMap, g.name, s.detail || '（无详情）', g.cents);
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

                const ts = parseTime(s.time);
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

            let todayCents = 0;
            let sevenDaysCents = 0;
            let monthCents = 0;
            const dailyTrend = [];

            dailyMap.forEach((v, date) => {
                const day = parseLocalDateKey(date);
                if (!day) return;
                if (date === todayStr) todayCents += v.cents;
                if (day.getTime() >= sevenDaysStart.getTime()) {
                    sevenDaysCents += v.cents;
                    dailyTrend.push({ date, cents: v.cents, calls: v.calls });
                }
                if (day.getTime() >= monthStart.getTime()) monthCents += v.cents;
            });
            dailyTrend.sort((a, b) => a.date.localeCompare(b.date));

            // 近 7 天没有记录时，趋势图会整块空着，容易被误认为脚本坏了。
            // 这里退化为「最近有消耗的若干天」，并明确标注真实区间。
            let trendNote = '';
            if (dailyTrend.length === 0 && dailyMap.size > 0) {
                const dates = Array.from(dailyMap.keys()).sort();
                const tail = dates.slice(-7);
                tail.forEach((date) => {
                    const v = dailyMap.get(date);
                    dailyTrend.push({ date, cents: v.cents, calls: v.calls });
                });
                trendNote = '近 7 天没有消耗记录，以下为最近有消耗的 ' + tail.length +
                    ' 天（' + tail[0] + ' ~ ' + tail[tail.length - 1] + '）';
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
                clientBreakdown,
                unlabeledClient,
                dailyTrend,
                trendNote,
                unparsedTime,
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

            const sessions = Array.isArray(store.usage_sessions) ? store.usage_sessions : [];
            const key = PLATFORM.id + ':' + sessions.length + ':' + ((store.meta && store.meta.lastUpdate) || 0);
            if (!force && container.dataset.renderKey === key) return;
            container.dataset.renderKey = key;

            const stats = computeStats(sessions, store);

            const trendTitle = stats.trendNote ? '积分消耗趋势（近 7 天无记录）' : '积分消耗趋势（近 7 天）';
            const trendBody = renderTrendChart(stats.dailyTrend) +
                (stats.trendNote ? '<div class="tee-note tee-note-spaced">' + escapeHtml(stats.trendNote) + '</div>' : '');

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
                clientBody ? section('各使用端积分消耗', clientBody) : '',
                section(trendTitle, trendBody)
            ].join('');

            const note = PLATFORM.note || ('统计口径：本地已采集的 ' + PLATFORM.label + ' 用量记录。数据只存在本机浏览器。');

            container.innerHTML = header() + cards(stats) + sections + footer(note, stats);

            const reloadBtn = container.querySelector('.tee-reload');
            if (reloadBtn) {
                reloadBtn.addEventListener('click', () => window.location.reload());
            }

            const resetBtn = container.querySelector('.tee-reset');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    // 本地数据全部可以由页面重建：清空后刷新，采集流程会重新走一遍
                    if (!window.confirm('清空本页已采集的用量数据并重新采集？')) return;
                    const store = DataStore.get();
                    store.usage_sessions = [];
                    DataStore.set(store);
                    window.location.reload();
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
                '<button class="tee-btn tee-reload" style="margin-left: auto !important;">刷新页面</button>' +
                '</div>';
        }

        function cards(stats) {
            const items = [
                ['总积分消耗', formatNumber(stats.totalCredits)],
                ['今日积分消耗', formatNumber(stats.todayCredits)],
                ['近 7 天积分消耗', formatNumber(stats.sevenDaysCredits)],
                ['本月积分消耗', formatNumber(stats.monthCredits)],
                [PLATFORM.unitLabel + '总数', String(stats.totalSessions)]
            ];
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
            // 本地数据全部可以由页面重建，重置是无损操作——数据异常时的自救入口。
            // 诊断信息用脚本自身的 GM 存储读取（数据存在油猴存储里，页面控制台读不到）。
            const tools = '<div class="tee-tools">' +
                '<button class="tee-tool tee-diag" type="button">复制诊断信息</button>' +
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
                const day = String(rs.time || '').slice(0, 10);
                if (!day) return;
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
                daily: daily,
                records: sessions.map((s) => {
                    const rs = readSession(s);
                    return rs.time + ' | ' + rs.model + ' | ' + rs.detail + ' | ' + rs.credit;
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
                return '<div class="tee-empty">暂无数据，请先在 ' + escapeHtml(PLATFORM.label) + ' 产生一次调用</div>';
            }
            const max = Math.max.apply(null, rows.map((r) => r.credits).concat([1]));
            return '<div class="tee-chart">' + rows.map((r) => {
                return '' +
                    '<div class="tee-row">' +
                    '<div class="tee-name" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</div>' +
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
                '<details class="tee-sub" data-subkey="' + escapeHtml(key) + '">' +
                '<summary class="tee-sub-summary">按' + escapeHtml(childLabel) + '细分 · ' + children.length + ' 项</summary>' +
                '<div class="tee-sub-body">' + children.map((c) => {
                    return '' +
                        '<div class="tee-sub-row">' +
                        '<div class="tee-name tee-sub-name" title="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</div>' +
                        '<div class="tee-bar-wrap tee-sub-bar-wrap">' + barHtml(c.credits, max) + '</div>' +
                        '<div class="tee-amount">' + formatNumber(c.credits) + ' 积分</div>' +
                        '<div class="tee-count">' + c.calls + '</div>' +
                        '</div>';
                }).join('') + '</div></details>';
        }

        function renderTrendChart(trend) {
            if (!trend.length) {
                return '<div class="tee-empty">暂无趋势数据</div>';
            }
            const max = Math.max.apply(null, trend.map((d) => d.cents).concat([1]));
            return '<div class="tee-trend">' + trend.map((d) => {
                const pct = Math.max((d.cents / max) * 100, 1).toFixed(1);
                return '' +
                    '<div class="tee-trend-col">' +
                    '<div class="tee-trend-bar" style="height:' + pct + '%">' +
                    '<span class="tee-trend-value">' + formatNumber(d.cents / 100) + '</span>' +
                    '</div>' +
                    '<div class="tee-trend-label">' + escapeHtml(d.date.substring(5)) + '</div>' +
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

        /**
         * 是否仍在用量页。SPA 切路由时 pathname / hash 会变，
         * 而脚本只在启动时判定过一次平台，因此这里必须用实时值重新判断。
         * 不在用量页时：移除面板且不重建；回到用量页时由观察器自动恢复。
         */
        function isOnUsagePage() {
            if (window.location.hostname !== HOST) return false;
            if (window.location.pathname.indexOf(PLATFORM.pagePath) !== 0) return false;
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
            gap: 14px;
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
        }

        /* ---------------- 尊重系统的「减少动态效果」设置 ---------------- */
        @media (prefers-reduced-motion: reduce) {
            #trae-enhancer-root .tee-row,
            #trae-enhancer-root .tee-sub-row,
            #trae-enhancer-root .tee-bar,
            #trae-enhancer-root .tee-trend-bar,
            #trae-enhancer-root .tee-btn,
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

            let retries = 0;
            const check = () => {
                if (DataStore.count() > 0) {
                    renderDashboard();
                    return;
                }
                retries++;
                if (retries === 3) {
                    log('尝试点击时间范围按钮触发请求…');
                    triggerTimeRangeButtons();
                }
                if (retries === 5) {
                    bootstrapPlatform();
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
            setupNetworkInterceptor();
            waitForDataAndRender();
            observePageChanges();

            // 定时兜底：只有数据指纹变化或面板被移除时才会真正重绘
            setInterval(() => renderDashboard(), CONFIG.refreshInterval);
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
