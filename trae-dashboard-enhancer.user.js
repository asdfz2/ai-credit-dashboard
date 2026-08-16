// ==UserScript==
// @name         Trae/QwenWork 用量仪表盘增强
// @namespace    https://github.com/asdfz2/trae-dashboard-enhancer
// @version      1.6.2
// @description  在 Trae/QwenWork 用量仪表盘页面添加积分消耗总数、各模型积分消耗等增强功能
// @author       asdfz2
// @license      MIT
// @homepage     https://github.com/asdfz2/trae-dashboard-enhancer
// @supportURL   https://github.com/asdfz2/trae-dashboard-enhancer/issues
// @downloadURL  https://raw.githubusercontent.com/asdfz2/trae-dashboard-enhancer/main/trae-dashboard-enhancer.user.js
// @match        https://www.trae.cn/dashboard*
// @match        https://trae.cn/dashboard*
// @match        https://qwenwork.cn/app/settings/usage*
// @match        https://www.qwenwork.cn/app/settings/usage*
// @icon         https://www.trae.cn/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_log
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    try {
        // 控制台输出，方便调试
        const log = (msg, ...args) => {
            console.log('[Trae Enhancer] ' + msg, ...args);
        };

        // 立即注入一个调试标记，确认脚本已运行
        const debugMarker = document.createElement('div');
        debugMarker.id = 'trae-enhancer-debug';
        debugMarker.style.display = 'none';
        debugMarker.textContent = 'script running';
        document.documentElement.appendChild(debugMarker);
        log('Script started, debug marker injected');

        // ========== 域名检测 ==========
        const isQwenWork = window.location.hostname.includes('qwenwork.cn');
        const isTrae = window.location.hostname.includes('trae.cn');
        log('Running on:', isQwenWork ? 'qwenwork.cn' : isTrae ? 'trae.cn' : 'unknown');

        // ========== 配置 ==========
        const CONFIG = {
            storageKey: isQwenWork ? 'qwenwork_usage_data' : 'trae_usage_data',
            refreshInterval: 60000, // 60秒检查一次新数据
            maxAutoPages: 100, // 无分页元数据时自发现翻页的最大页数上限
        };

        // ========== API 配置（按域名区分）==========
        const API_CONFIG = {
            trae: {
                sessionApi: 'query_user_usage_group_by_session',
                sessionField: 'user_usage_group_by_sessions',
                creditField: 'credits_float',
                altCreditField: 'amount_float',
                modelField: 'model_name',
                timeField: 'usage_time',
                altTimeField: 'created_at',
                sessionIdField: 'session_id'
            },
            qwenwork: {
                sessionApi: 'usage_records',
                sessionField: 'usage_records',
                creditField: 'credits',
                altCreditField: 'total_tokens',
                modelField: 'model_name',
                timeField: 'created_at',
                altTimeField: 'usage_time',
                sessionIdField: 'record_id',
                // qwenwork 特有字段
                inputTokensField: 'input_tokens',
                outputTokensField: 'output_tokens',
                totalTokensField: 'total_tokens'
            }
        };

        const currentConfig = isQwenWork ? API_CONFIG.qwenwork : API_CONFIG.trae;

    // ========== 数据管理 ==========
    const DataStore = {
        sessions: null, // 内存缓存（qwenwork.cn DOM 提取用）
        get() {
            try {
                return JSON.parse(GM_getValue(CONFIG.storageKey, '{}'));
            } catch {
                return {};
            }
        },
        set(data) {
            GM_setValue(CONFIG.storageKey, JSON.stringify(data));
        },
        // 合并API响应数据；requestInfo 携带该响应对应的请求体/请求头，用于按正确范围翻页
        mergeApiResponse(url, responseData, requestInfo) {
            const store = this.get();
            if (!store.api_responses) store.api_responses = [];
            if (!store.usage_sessions) store.usage_sessions = [];

            // 检查响应是否成功（兼容两种格式）
            // Trae: code === 0 或 code === 200 或没有 code 字段
            // QwenWork: success === true
            const isSuccess = (responseData && responseData.success === true) ||
                              (responseData && (responseData.code === undefined || responseData.code === 0 || responseData.code === 200));
            
            if (!isSuccess) {
                return store; // 跳过非成功响应
            }

            // 记录API响应
            store.api_responses.push({
                url: url,
                time: Date.now(),
                data: responseData
            });

            // 解析用量数据（兼容两种数据结构）
            let sessions = null;
            let pagination = null;
            
            // Trae 格式: responseData.user_usage_group_by_sessions
            if (responseData && responseData.user_usage_group_by_sessions) {
                sessions = responseData.user_usage_group_by_sessions;
                pagination = responseData; // Trae 的分页信息在顶层
            }
            // QwenWork 格式: responseData.data.usage_records
            else if (responseData && responseData.data && responseData.data.usage_records) {
                sessions = responseData.data.usage_records;
                pagination = responseData.data.pagination || {};
            }

            if (sessions && Array.isArray(sessions)) {
                // 日志输出分页信息（仅首次）
                if (!store._paginationLogged) {
                    store._paginationLogged = true;
                    log('API response top-level keys:', Object.keys(responseData).join(', '));
                    if (responseData.data) {
                        log('Response data keys:', Object.keys(responseData.data).join(', '));
                    }
                    log('Sessions count:', sessions.length);
                    
                    // 输出分页字段
                    if (pagination) {
                        ['total', 'page', 'pageSize', 'page_size', 'totalPages', 'total_pages', 'hasMore', 'has_more', 'offset', 'limit', 'count'].forEach(key => {
                            if (pagination[key] !== undefined) {
                                log('Pagination field -', key + ':', pagination[key]);
                            }
                        });
                    }
                }

                // 自动翻页：有分页元数据则按元数据翻页；无元数据但已返回会话则自发现翻页（靠去重守卫截断）
                const total = pagination.total || pagination.count || 0;
                const pageSize = pagination.pageSize || pagination.page_size || pagination.limit || sessions.length || 21;
                const currentPage = pagination.page || 1;
                const hasMetadata = total > 0;
                const totalPages = hasMetadata
                    ? (pagination.totalPages || pagination.total_pages || Math.ceil(total / pageSize))
                    : 0;
                const needDiscovery = !hasMetadata && sessions.length > 0;

                // 该响应对应的请求体/请求头（优先用随响应传入的，回退到最近一次请求）
                const rbody = (requestInfo && requestInfo.body) ? requestInfo.body : (_lastApiRequest.body || {});
                const rheaders = (requestInfo && requestInfo.headers) ? requestInfo.headers : (_lastApiRequest.headers || {});
                const rsig = JSON.stringify(rbody);

                // 仅当尚未翻页，或当前翻页的是另一个范围（请求体不同）时才触发，避免切换 7天/30天 时被旧翻页占位漏掉
                if ((!store._autoFetching || store._pagingKey !== rsig) && (hasMetadata ? totalPages > currentPage : needDiscovery)) {
                    store._autoFetching = true;
                    store._pagingKey = rsig;
                    this.set(store);
                    const targetPages = hasMetadata ? totalPages : currentPage + CONFIG.maxAutoPages;
                    log('Auto-pagination: page ' + currentPage + '/' + targetPages + ', sessions:' + (total || sessions.length));
                    fetchAllPages(url, rbody, targetPages, currentPage, rheaders, needDiscovery);
                }

                // 合并会话数据（使用对应的去重字段）
                const idField = currentConfig.sessionIdField;
                sessions.forEach(session => {
                    const sessionId = session[idField] || session.session_id;
                    if (!sessionId) return;
                    
                    const existing = store.usage_sessions.findIndex(s => 
                        (s[idField] || s.session_id) === sessionId
                    );
                    if (existing >= 0) {
                        store.usage_sessions[existing] = session;
                    } else {
                        store.usage_sessions.push(session);
                    }
                });
            }

            // 解析权益/配额数据
            if (responseData && responseData.user_entitlement_pack_list) {
                store.entitlement = responseData;
            }

            // 保存计费状态
            if (responseData && responseData.is_credits_billing !== undefined) {
                store.billing_status = responseData;
            }

            // 限制存储大小，保留最近100条
            if (store.api_responses.length > 100) {
                store.api_responses = store.api_responses.slice(-100);
            }

            this.set(store);
            return store;
        }
    };

    // ========== 自动翻页获取所有历史数据 ==========
    // 存储上一次请求的 body 和 URL，用于翻页
    let _lastApiRequest = {};
    // 原始 fetch（未包装），翻页回放用它，避免触发拦截器重复合并导致去重守卫误判中断
    let _rawFetch = null;

    async function fetchAllPages(baseUrl, requestBody, totalPages, currentPage, requestHeaders, isDiscovery) {
        log('Fetching all pages: current=' + currentPage + ', total=' + totalPages);
        // 优先用原始 fetch（绕过拦截器重复合并）；不可用时回退到包装后的 fetch
        const doFetch = _rawFetch || window.fetch.bind(window);
        try {
            for (let page = currentPage + 1; page <= totalPages; page++) {
                const before = (DataStore.get().usage_sessions || []).length;
                try {
                    // 保留原请求体（含 start_time/end_time/usage_type 等），改用它真实的分页字段 page_num
                    const body = Object.assign({}, requestBody || {});
                    const pageField = ('page_num' in body) ? 'page_num' : 'page';
                    body[pageField] = page;
                    // 回放时转发原请求头（含鉴权头），否则接口返回 401
                    const headers = Object.assign({}, requestHeaders || {});
                    headers['Content-Type'] = 'application/json';
                    delete headers['content-length'];
                    delete headers['host'];
                    delete headers['connection'];
                    delete headers['accept-encoding'];
                    const resp = await doFetch(baseUrl, {
                        method: 'POST',
                        credentials: 'include',
                        headers: headers,
                        body: JSON.stringify(body)
                    });
                    if (!resp.ok) {
                        log('Auto-fetch page ' + page + ' failed with status ' + resp.status);
                        break;
                    }
                    const data = await resp.json();
                    DataStore.mergeApiResponse(baseUrl, data);
                    const after = (DataStore.get().usage_sessions || []).length;
                    log('Fetched page ' + page + '/' + totalPages + ', sessions now: ' + after);
                    // 仅「无元数据自发现」模式用去重守卫截断；有明确 totalPages 时直接拉完所有页
                    if (isDiscovery && after === before) {
                        break;
                    }
                } catch (e) {
                    log('Auto-fetch page ' + page + ' failed:', e);
                    break;
                }
                // 稍微延迟，避免请求过快
                await new Promise(r => setTimeout(r, 300));
            }
        } finally {
            // 复位翻页状态，允许后续响应再次触发翻页
            const store = DataStore.get();
            delete store._autoFetching;
            delete store._pagingKey;
            DataStore.set(store);
        }
        renderDashboard();
        log('All pages fetched. Total sessions:', (DataStore.get().usage_sessions || []).length);
    }

    // ========== 网络请求拦截 ==========
    function setupNetworkInterceptor() {
        log('Setting up network interceptors...');

        // 拦截 fetch
        const originalFetch = window.fetch;
        _rawFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');
            // 记录用量查询请求体，供自动翻页回放（fetch 路径之前漏了这项，导致翻页请求体为空）
            const reqInfo = {
                url: url,
                method: (init && init.method) || 'GET',
                body: isUsageSessionApi(url) ? parseRequestBody(init && init.body) : {},
                headers: normalizeHeaders(init && init.headers)
            };
            if (isUsageSessionApi(url)) {
                _lastApiRequest = reqInfo;
            }
            return originalFetch.apply(this, arguments).then(async response => {
                // 只拦截 Trae 相关 API
                if (isTraeApi(url)) {
                    try {
                        const clonedResponse = response.clone();
                        const data = await clonedResponse.json();
                        DataStore.mergeApiResponse(url, data, isUsageSessionApi(url) ? reqInfo : null);
                        renderDashboard();
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
                return response;
            });
        };

        // 拦截 XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._traeMethod = method;
            this._traeUrl = typeof url === 'string' ? url : (url || '');
            this._traeHeaders = {};
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
            if (this._traeUrl && isUsageSessionApi(this._traeUrl) && typeof this._traeHeaders === 'object') {
                this._traeHeaders[String(key).toLowerCase()] = value;
            }
            return originalSetRequestHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
            if (this._traeUrl && isTraeApi(this._traeUrl)) {
                const reqInfo = {
                    url: this._traeUrl,
                    method: this._traeMethod,
                    body: isUsageSessionApi(this._traeUrl) ? parseRequestBody(body) : {},
                    headers: this._traeHeaders || {}
                };
                if (isUsageSessionApi(this._traeUrl)) {
                    // 保存请求体与请求头，用于自动翻页
                    _lastApiRequest = reqInfo;
                }
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        DataStore.mergeApiResponse(reqInfo.url, data, isUsageSessionApi(reqInfo.url) ? reqInfo : null);
                        renderDashboard();
                    } catch (e) {}
                });
            }
            return originalSend.apply(this, arguments);
        };
    }

    // 是否为用量会话查询接口（自动翻页只针对该接口回放请求体）
    function isUsageSessionApi(url) {
        if (!url) return false;
        // Trae: query_user_usage_group_by_session
        // QwenWork: usage_records (在 /api/v1/ 路径下)
        return url.includes('query_user_usage_group_by_session') ||
               (isQwenWork && url.includes('usage_records'));
    }

    // 解析请求体为对象，兼容 JSON 字符串、URLSearchParams 与普通对象
    function parseRequestBody(body) {
        if (!body) return {};
        if (typeof body === 'string') {
            try { return JSON.parse(body); } catch (e) { return {}; }
        }
        if (body instanceof URLSearchParams) {
            const obj = {};
            body.forEach((v, k) => { obj[k] = v; });
            return obj;
        }
        if (typeof body === 'object') {
            return body;
        }
        return {};
    }

    // 规范化为普通对象，兼容 Headers 实例、键值对数组与普通对象
    function normalizeHeaders(headers) {
        const result = {};
        if (!headers) return result;
        if (headers instanceof Headers) {
            headers.forEach((v, k) => { result[k] = v; });
        } else if (Array.isArray(headers)) {
            headers.forEach(([k, v]) => { result[k] = v; });
        } else if (typeof headers === 'object') {
            Object.keys(headers).forEach(k => { result[k] = headers[k]; });
        }
        return result;
    }

    function isTraeApi(url) {
        if (!url) return false;
        // Trae API 路径
        if (url.includes('/trae/api/v1/pay/') ||
            url.includes('/trae/api/v2/pay/') ||
            url.includes('/cloudide/api/v3/common/GetUserToken') ||
            url.includes('query_user_usage_group_by_session') ||
            url.includes('user_current_entitlement_list') ||
            url.includes('cn_credits_billing_status') ||
            url.includes('web_user_pay_status') ||
            url.includes('expired_ents')) {
            return true;
        }
        // QwenWork API 路径
        if (isQwenWork && url.includes('/api/v1/usage_records')) {
            return true;
        }
        return false;
    }

    // ========== UI 渲染 ==========
    function renderDashboard() {
        log('Rendering dashboard...');
        const data = DataStore.get();
        const container = getOrCreateContainer();
        if (!container) {
            log('Container not found, aborting render');
            return;
        }

        // qwenwork.cn: 应用浅色主题
        if (isQwenWork) {
            container.classList.add('qwenwork-theme');
        }

        // qwenwork.cn: DOM 提取的数据存在 DataStore.sessions（内存）中
        const sessions = DataStore.sessions || data.usage_sessions || [];
        const entitlement = data.entitlement;

        // 计算统计数据
        const stats = computeStats(sessions, entitlement);

        container.innerHTML = `
            <div class="trae-enhancer-header">
                <h3> 用量增强面板</h3>
                <span class="trae-enhancer-badge">v1.6.2</span>
                <button class="trae-enhancer-btn" onclick="window.location.reload()" style="margin-left: auto;">刷新页面</button>
            </div>
            <div class="trae-enhancer-stats">
                <div class="stat-card">
                    <div class="stat-label">总积分消耗</div>
                    <div class="stat-value">${formatNumber(stats.totalCredits)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">今日积分消耗</div>
                    <div class="stat-value">${formatNumber(stats.todayCredits)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">近7天积分消耗</div>
                    <div class="stat-value">${formatNumber(stats.sevenDaysCredits)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">本月积分消耗</div>
                    <div class="stat-value">${formatNumber(stats.monthCredits)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">会话总数</div>
                    <div class="stat-value">${stats.totalSessions}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">数据更新时间</div>
                    <div class="stat-value stat-time">${stats.lastUpdate}</div>
                </div>
            </div>
            <div class="trae-enhancer-section">
                <h4>各模型积分消耗</h4>
                ${renderModelBreakdown(stats.modelBreakdown)}
            </div>
            <div class="trae-enhancer-section">
                <h4>积分消耗趋势（近7天）</h4>
                ${renderTrendChart(stats.dailyTrend)}
            </div>
            <div class="trae-enhancer-footer">
            </div>
        `;
    }

    function formatLocalDate(date) {
        return date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0');
    }

    function parseLocalDateKey(dateStr) {
        const parts = String(dateStr || '').split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
        const [y, m, d] = parts;
        const date = new Date(y, m - 1, d);
        if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
        date.setHours(0, 0, 0, 0);
        return date;
    }

    function computeStats(sessions, entitlement) {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayStr = formatLocalDate(todayStart);
        const sevenDaysStart = new Date(todayStart);
        sevenDaysStart.setDate(sevenDaysStart.getDate() - 6);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        monthStart.setHours(0, 0, 0, 0);

        let totalCredits = 0;
        let totalCalls = 0;
        const modelMap = {};
        const dailyMap = {};

        sessions.forEach(s => {
            const credits = s[currentConfig.creditField] || s[currentConfig.altCreditField] || 0;
            totalCredits += credits;
            totalCalls += 1;

            // 解析时间（兼容多种格式）
            let ts = 0;
            const rawDate = s[currentConfig.timeField] || s[currentConfig.altTimeField];
            if (typeof rawDate === 'number' && rawDate > 946684800000) {
                ts = rawDate; // 毫秒时间戳
            } else if (typeof rawDate === 'number' && rawDate > 946684800) {
                ts = rawDate * 1000; // 秒级时间戳
            } else if (typeof rawDate === 'string') {
                const d = new Date(rawDate);
                if (!isNaN(d.getTime())) {
                    ts = d.getTime();
                }
            }
            // 兜底：如果解析失败，debug 输出前 3 条
            if (ts === 0 && sessions.indexOf(s) < 3) {
                log('usage_time parse failed:', rawDate, typeof rawDate);
            }

            // 模型维度
            const model = s.model_name || '未知模型auto';
            if (!modelMap[model]) {
                modelMap[model] = { credits: 0, calls: 0 };
            }
            modelMap[model].credits += credits;
            modelMap[model].calls += 1;

            // 日期维度：统一本地自然日，按"分"（×100 整数）累加，后续 today/7天/月均从这里派生
            if (ts > 0) {
                const dateStr = formatLocalDate(new Date(ts));
                if (!dailyMap[dateStr]) {
                    dailyMap[dateStr] = { cents: 0, calls: 0 };
                }
                dailyMap[dateStr].cents += Math.round(credits * 100);
                dailyMap[dateStr].calls += 1;
            }
        });

        // 模型排序
        const modelBreakdown = Object.entries(modelMap)
            .map(([name, data]) => ({ name, credits: data.credits, calls: data.calls }))
            .sort((a, b) => b.credits - a.credits);

        // 从同一份"分"整数日汇总派生：今日 / 近7天 / 本月 / 趋势
        let todayCents = 0;
        let sevenDaysCents = 0;
        let monthCents = 0;
        const dailyTrend = [];

        Object.entries(dailyMap).forEach(([date, data]) => {
            const day = parseLocalDateKey(date);
            if (!day) return;

            if (date === todayStr) {
                todayCents += data.cents;
            }
            if (day.getTime() >= sevenDaysStart.getTime()) {
                sevenDaysCents += data.cents;
                dailyTrend.push({ date, cents: data.cents, calls: data.calls });
            }
            if (day.getTime() >= monthStart.getTime()) {
                monthCents += data.cents;
            }
        });

        dailyTrend.sort((a, b) => a.date.localeCompare(b.date));

        // 从权益信息获取总积分/配额
        let totalEntitlementCredits = 0;
        if (entitlement && entitlement.user_entitlement_pack_list) {
            entitlement.user_entitlement_pack_list.forEach(pack => {
                totalEntitlementCredits += pack.amount_float || pack.credits_float || pack.total_amount || pack.amount || 0;
            });
        }
        if (totalEntitlementCredits > 0 && totalCredits === 0) {
            totalCredits = totalEntitlementCredits;
        }

        // 问题2：趋势无数据 — 可能是 usage_time 缺失或格式不兼容
        // 如果 dailyTrend 为空但 sessions 有数据，用当前本地日期显示
        if (dailyTrend.length === 0 && sessions.length > 0) {
            const allCents = Math.round(totalCredits * 100);
            dailyTrend.push({ date: todayStr, cents: allCents, calls: totalCalls });
            todayCents = allCents;
            sevenDaysCents = allCents;
            monthCents = allCents;
            log('Trend fallback: assigned all credits to', todayStr);
        }
        log('Stats computed:', {
            sessions: sessions.length,
            totalCredits,
            todayCredits: todayCents / 100,
            sevenDaysCredits: sevenDaysCents / 100,
            dailyTrend: dailyTrend.length + ' entries',
            validTimestamps: Object.keys(dailyMap).length
        });

        const lastUpdate = sessions.length > 0
            ? new Date().toLocaleString('zh-CN')
            : '暂无数据，请先使用 ' + (isQwenWork ? 'QwenWork' : 'Trae');

        return {
            totalCredits: Math.round(totalCredits * 100) / 100,
            totalSessions: sessions.length,
            totalCalls: totalCalls,
            todayCredits: todayCents / 100,
            sevenDaysCredits: sevenDaysCents / 100,
            monthCredits: monthCents / 100,
            modelBreakdown: modelBreakdown,
            dailyTrend: dailyTrend,
            lastUpdate: lastUpdate
        };
    }

    function renderModelBreakdown(breakdown) {
        if (breakdown.length === 0) {
            return '<div class="trae-enhancer-empty">暂无数据，请先使用 ' + (isQwenWork ? 'QwenWork' : 'Trae') + ' 进行对话</div>';
        }

        const maxCredits = Math.max(...breakdown.map(m => m.credits), 1);

        let html = '<div class="model-chart">';
        breakdown.forEach(m => {
            const pct = (m.credits / maxCredits * 100).toFixed(1);
            html += `
                <div class="model-row">
                    <div class="model-name">${escapeHtml(m.name)}</div>
                    <div class="model-bar-wrapper">
                        <div class="model-bar" style="width: ${pct}%"></div>
                    </div>
                    <div class="model-value">${formatNumber(m.credits)} 积分</div>
                    <div class="model-calls">${m.calls} 次</div>
                </div>
            `;
        });
        html += '</div>';
        return html;
    }

    function renderTrendChart(trend) {
        if (trend.length === 0) {
            return '<div class="trae-enhancer-empty">暂无趋势数据</div>';
        }

        const maxCents = Math.max(...trend.map(d => d.cents), 1);

        let html = '<div class="trend-chart">';
        trend.forEach(d => {
            const pct = (d.cents / maxCents * 100).toFixed(1);
            const dateLabel = d.date.substring(5); // MM-DD
            html += `
                <div class="trend-bar-wrapper">
                    <div class="trend-bar" style="height: ${pct}%">
                        <span class="trend-value">${formatNumber(d.cents / 100)}</span>
                    </div>
                    <div class="trend-label">${dateLabel}</div>
                </div>
            `;
        });
        html += '</div>';
        return html;
    }

    // ========== DOM 工具 ==========
    function getOrCreateContainer() {
        let container = document.getElementById('trae-enhancer-root');
        if (container) return container;

        if (isQwenWork) {
            // qwenwork.cn: 直接放到 body 下，全宽显示，突破 main 的窄布局限制
            container = document.createElement('div');
            container.id = 'trae-enhancer-root';
            container.style.cssText = 'width:100%;max-width:1400px;margin:0 auto;padding:0 20px;box-sizing:border-box;';
            // 插入到 body 最后（页面最下方）
            document.body.appendChild(container);
            log('Creating full-width container on body (qwenwork.cn)');
            return container;
        }

        // Trae: 查找页面主体区域
        const main = document.querySelector('main') ||
                     document.querySelector('.dashboard-content') ||
                     document.querySelector('#app > div') ||
                     document.querySelector('#root') ||
                     document.body;

        if (!main) {
            log('No suitable parent element found');
            return null;
        }

        log('Creating container under:', main.tagName, main.className);
        container = document.createElement('div');
        container.id = 'trae-enhancer-root';
        main.appendChild(container);
        return container;
    }

    function formatNumber(num) {
        // 统一四舍五入到 2 位小数
        const rounded = Math.round(num * 100) / 100;
        if (rounded >= 10000) {
            return (rounded / 10000).toFixed(1) + '万';
        }
        return rounded.toFixed(2);
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ========== 样式注入 ==========
    GM_addStyle(`
        #trae-enhancer-root {
            margin: 20px 0;
            padding: 20px;
            background: #1a1a2e;
            border-radius: 12px;
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 100%;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        .trae-enhancer-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #333;
        }
        .trae-enhancer-header h3 {
            margin: 0;
            font-size: 18px;
            color: #fff;
        }
        .trae-enhancer-badge {
            background: #4a6cf7;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            color: #fff;
        }
        .trae-enhancer-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: #16213e;
            padding: 14px;
            border-radius: 8px;
            border: 1px solid #2a2a4a;
        }
        .stat-label {
            font-size: 12px;
            color: #888;
            margin-bottom: 6px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #4fc3f7;
        }
        .stat-time {
            font-size: 12px;
            color: #aaa;
        }
        .trae-enhancer-section {
            margin-bottom: 20px;
        }
        .trae-enhancer-section h4 {
            margin: 0 0 10px 0;
            font-size: 14px;
            color: #ccc;
        }
        .trae-enhancer-empty {
            padding: 20px;
            text-align: center;
            color: #666;
            background: #16213e;
            border-radius: 8px;
            font-size: 13px;
        }
        .model-chart {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .model-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 6px 0;
        }
        .model-name {
            width: 150px;
            font-size: 12px;
            color: #ccc;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-shrink: 0;
        }
        .model-bar-wrapper {
            flex: 1;
            height: 20px;
            background: #2a2a4a;
            border-radius: 10px;
            overflow: hidden;
        }
        .model-bar {
            height: 100%;
            background: linear-gradient(90deg, #4a6cf7, #4fc3f7);
            border-radius: 10px;
            transition: width 0.5s ease;
            min-width: 2px;
        }
        .model-value {
            width: 80px;
            text-align: right;
            font-size: 12px;
            color: #4fc3f7;
            flex-shrink: 0;
        }
        .model-calls {
            width: 60px;
            text-align: right;
            font-size: 11px;
            color: #888;
            flex-shrink: 0;
        }
        .model-tokens {
            width: 100px;
            text-align: right;
            font-size: 11px;
            color: #666;
            flex-shrink: 0;
            cursor: help;
        }
        .trend-chart {
            display: flex;
            align-items: flex-end;
            gap: 8px;
            height: 120px;
            padding: 10px 0;
        }
        .trend-bar-wrapper {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            height: 100%;
            justify-content: flex-end;
        }
        .trend-bar {
            width: 100%;
            max-width: 40px;
            background: linear-gradient(180deg, #4fc3f7, #4a6cf7);
            border-radius: 4px 4px 0 0;
            min-height: 4px;
            position: relative;
            transition: height 0.5s ease;
        }
        .trend-value {
            position: absolute;
            top: -18px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 10px;
            color: #4fc3f7;
            white-space: nowrap;
        }
        .trend-label {
            font-size: 10px;
            color: #888;
            margin-top: 4px;
        }
        .session-table {
            overflow-x: auto;
        }
        .session-table table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .session-table th {
            text-align: left;
            padding: 8px 10px;
            border-bottom: 1px solid #333;
            color: #888;
            font-weight: normal;
        }
        .session-table td {
            padding: 6px 10px;
            border-bottom: 1px solid #222;
            color: #ccc;
        }
        .session-table tr:hover td {
            background: #16213e;
        }
        .trae-enhancer-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid #333;
        }
        .trae-enhancer-btn {
            background: #4a6cf7;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
        }
        .trae-enhancer-btn:hover {
            background: #3b5de7;
        }
        .trae-enhancer-hint {
            font-size: 11px;
            color: #555;
        }

        /* ===== qwenwork.cn 浅色主题 ===== */
        #trae-enhancer-root.qwenwork-theme {
            background: #ffffff;
            border: 1px solid #e5e7eb;
            box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-header {
            border-bottom-color: #e5e7eb;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-header h3 {
            color: #1f2937;
        }
        #trae-enhancer-root.qwenwork-theme .stat-card {
            background: #f9fafb;
            border-color: #e5e7eb;
        }
        #trae-enhancer-root.qwenwork-theme .stat-label {
            color: #6b7280;
        }
        #trae-enhancer-root.qwenwork-theme .stat-value {
            color: #2563eb;
        }
        #trae-enhancer-root.qwenwork-theme .stat-time {
            color: #9ca3af;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-section h4 {
            color: #374151;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-empty {
            background: #f9fafb;
            color: #9ca3af;
        }
        #trae-enhancer-root.qwenwork-theme .model-bar-wrapper {
            background: #e5e7eb;
        }
        #trae-enhancer-root.qwenwork-theme .model-name {
            color: #4b5563;
        }
        #trae-enhancer-root.qwenwork-theme .model-value {
            color: #2563eb;
        }
        #trae-enhancer-root.qwenwork-theme .model-calls {
            color: #6b7280;
        }
        #trae-enhancer-root.qwenwork-theme .model-tokens {
            color: #9ca3af;
        }
        #trae-enhancer-root.qwenwork-theme .trend-value {
            color: #2563eb;
        }
        #trae-enhancer-root.qwenwork-theme .trend-label {
            color: #6b7280;
        }
        #trae-enhancer-root.qwenwork-theme .session-table th {
            border-bottom-color: #e5e7eb;
            color: #6b7280;
        }
        #trae-enhancer-root.qwenwork-theme .session-table td {
            border-bottom-color: #f3f4f6;
            color: #374151;
        }
        #trae-enhancer-root.qwenwork-theme .session-table tr:hover td {
            background: #f9fafb;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-footer {
            border-top-color: #e5e7eb;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-hint {
            color: #9ca3af;
        }
    `);

    // ========== 主动获取 API 数据（拦截器没抓到时的后备方案） ==========
    async function fetchUsageData() {
        if (isQwenWork) {
            // QwenWork 诊断：检查页面是否有内嵌数据
            log('QwenWork: Checking for embedded data...');
            
            // 找到"已使用" BUTTON 的祖先容器，从中提取数据
            const usedTab = Array.from(document.querySelectorAll('*')).find(el => 
                el.innerText && el.innerText.trim() === '已使用' && el.children.length === 0
            );
            
            if (!usedTab) {
                log('QwenWork: "已使用" button not found');
                return;
            }
            
            // 向上查找包含数据列表的容器（找到有足够多子元素的祖先）
            let dataContainer = usedTab.parentElement;
            for (let depth = 0; depth < 15; depth++) {
                if (!dataContainer || dataContainer === document.body) break;
                // 检查这个容器是否包含日期格式的记录
                const containerText = dataContainer.innerText || '';
                if (/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(containerText) && containerText.length > 100) {
                    log('QwenWork: Found data container at depth', depth, 'tag:', dataContainer.tagName, 'class:', (dataContainer.className || '').substring(0, 60));
                    break;
                }
                dataContainer = dataContainer.parentElement;
            }
            
            const containerText = dataContainer ? (dataContainer.innerText || '') : '';
            const lines = containerText.split('\n').map(l => l.trim()).filter(l => l);
            log('QwenWork: Container lines:', lines.length, 'First 15:', lines.slice(0, 15));
            
            // 查找积分历史记录（格式：时间、来源、详情、积分变更）
            const records = [];
            for (let i = 0; i < lines.length; i++) {
                if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(lines[i])) {
                    const time = lines[i];
                    const source = lines[i + 1] || '';
                    const detail = lines[i + 2] || '';
                    const change = lines[i + 3] || '';
                    const creditChange = parseFloat(change.replace(/,/g, ''));
                    if (!isNaN(creditChange)) {
                        records.push({ time, source, detail, credits: creditChange });
                    }
                }
            }
            
            log('QwenWork: Extracted', records.length, 'records from DOM');
            if (records.length > 0) {
                log('QwenWork: Sample records:', JSON.stringify(records.slice(0, 3)));
                
                const sessions = records
                    .filter(r => r.credits < 0)
                    .map(r => ({
                        model_name: r.source || '未知模型auto',
                        session_name: r.detail || '',
                        usage_time: r.time,
                        credits: Math.abs(r.credits),
                        credit_type: 'consumed'
                    }));
                
                DataStore.sessions = sessions;
                DataStore.lastUpdated = new Date().toISOString();
                log('QwenWork: Sessions stored:', sessions.length);
            } else {
                log('QwenWork: No records found, will retry after 5s...');
                setTimeout(() => {
                    log('QwenWork: Retrying DOM extraction...');
                    fetchUsageData();
                }, 5000);
            }
            
            // 查找积分信息
            const bodyText = document.body.innerText;
            const creditMatch = bodyText.match(/剩余可用[\s\S]*?([\d,]+\.\d+)/);
            if (creditMatch) {
                log('QwenWork: Remaining credits:', creditMatch[1]);
            }
            const dailyMatch = bodyText.match(/剩余\s+([\d.]+)\s*$/m);
            if (dailyMatch) {
                log('QwenWork: Daily remaining:', dailyMatch[1]);
            }
            
            // API 全部 404，不再尝试
            log('QwenWork: API attempts skipped (all return 404)');
        } else {
            // Trae 后备方案
            const usageUrl = 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session';
            const tokenUrl = 'https://api.trae.cn/cloudide/api/v3/common/GetUserToken';

            // 先尝试获取用户 token
            let token = null;
            try {
                const tokenResp = await fetch(tokenUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (tokenResp.ok) {
                    const tokenData = await tokenResp.json();
                    token = tokenData;
                    log('Got token:', tokenData);
                }
            } catch (e) {
                log('Token fetch failed:', e);
            }

            // 用 token 查询用量数据
            try {
                const body = token ? { token: token } : {};
                const resp = await fetch(usageUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (resp.ok) {
                    const data = await resp.json();
                    log('Usage API response:', data.code, Object.keys(data));
                    if (data && (data.code === 0 || data.code === undefined)) {
                        DataStore.mergeApiResponse(usageUrl, data);
                    }
                }
            } catch (e) {
                log('Usage fetch failed:', e);
            }
        }
        renderDashboard();
    }

    // ========== 从页面 DOM 提取数据（最终后备方案） ==========
    function extractDataFromDOM() {
        try {
            const bodyText = document.body ? document.body.innerText : '';
            if (!bodyText) return null;

            // 提取积分数字
            const creditPatterns = [
                /积分\s*[:：]?\s*([\d,]+\.?\d*)/g,
                /([\d,]+\.?\d*)\s*积分/g,
                /可用[积分额度]\s*[:：]?\s*([\d,]+\.?\d*)/g
            ];
            const credits = [];
            creditPatterns.forEach(p => {
                let m;
                while ((m = p.exec(bodyText)) !== null) {
                    credits.push(parseFloat(m[1].replace(/,/g, '')));
                }
            });

            // 提取模型名称
            const modelPattern = /(DeepSeek[-]?V\d+[-]?\w*|Claude|GPT[-]?\d*|Gemini|Qwen|通义|千问)/g;
            const models = [...new Set(bodyText.match(modelPattern) || [])];

            return { credits, models, bodyLength: bodyText.length };
        } catch (e) {
            return null;
        }
    }

    // ========== 尝试点击页面按钮触发新 API 请求（不改变滚动位置） ==========
    function triggerApiCalls() {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        // 尝试点击时间范围按钮（如"30天"、"本月"等）触发新请求
        const possibleSelectors = [
            'button:not([disabled])',
            '[role="tab"]:not([disabled])',
            '.ant-radio-button-wrapper',
            '.el-radio-button__inner',
            '[class*="time"]',
            '[class*="range"]'
        ];
        for (const sel of possibleSelectors) {
            const buttons = document.querySelectorAll(sel);
            for (const btn of buttons) {
                const txt = btn.textContent.trim();
                if (txt.includes('30') || txt.includes('月') || txt.includes('近')) {
                    setTimeout(() => {
                        try {
                            btn.dispatchEvent(new MouseEvent('click', {
                                bubbles: true, cancelable: true, view: window
                            }));
                            window.scrollTo(scrollX, scrollY);
                            log('Clicked:', txt);
                        } catch(e) {
                            log('Click failed:', txt, e);
                        }
                    }, 500);
                    return;
                }
            }
        }
    }

    // ========== 等待数据并持续重试渲染 ==========
    function waitForDataAndRender(maxRetries = 30) {
        let retries = 0;

        // 先立即渲染一次（即使没数据，也显示面板，避免空白）
        setTimeout(() => {
            log('Initial render (may be empty)');
            renderDashboard();
        }, 1000);

        const check = () => {
            const data = DataStore.get();
            const sessions = DataStore.sessions || data.usage_sessions || [];
            const hasData = sessions.length > 0;

            if (hasData) {
                log('Data found, re-rendering. Sessions:', sessions.length);
                renderDashboard();
                return;
            }

            retries++;
            if (retries === 3) {
                log('Triggering API calls by clicking buttons...');
                triggerApiCalls();
            }
            if (retries === 5) {
                log('Trying active fetch / DOM extraction...');
                fetchUsageData().then(() => {
                    renderDashboard();
                });
            }
            if (retries >= maxRetries) {
                log('Max retries (' + maxRetries + ') reached. Rendering with whatever data we have.');
                renderDashboard();
                return;
            }

            setTimeout(check, 1000);
        };
        setTimeout(check, 2000);
    }

    // ========== 监听页面 DOM 变化（SPA 重新渲染时重新插入容器） ==========
    function observePageChanges() {
        const observer = new MutationObserver(() => {
            // 检查容器是否还在
            if (!document.getElementById('trae-enhancer-root')) {
                // 容器被移除了，重新渲染
                const data = DataStore.get();
                if ((DataStore.sessions || data.usage_sessions || []).length > 0) {
                    renderDashboard();
                }
            }
        });
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ========== 初始化 ==========
    function init() {
        GM_log('[Trae Enhancer] Initializing...');

        // 注意：不要清空数据，防止拦截器还没抓到新数据时面板空白

        // 先拦截网络请求
        setupNetworkInterceptor();

        // 等待页面完全加载后开始检查数据
        if (document.readyState === 'complete') {
            waitForDataAndRender();
            observePageChanges();
        } else {
            window.addEventListener('load', () => {
                waitForDataAndRender();
                observePageChanges();
            });
        }

        // 定时刷新UI
        setInterval(() => {
            const data = DataStore.get();
            if ((data.usage_sessions || []).length > 0) {
                renderDashboard();
            }
        }, CONFIG.refreshInterval);
    }

    // 页面加载完成后初始化
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    } catch (e) {
        console.error('[Trae Enhancer] Script error:', e);
    }
})();