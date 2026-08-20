// ==UserScript==
// @name         Trae/QwenWork 用量仪表盘增强
// @namespace    https://github.com/asdfz2/trae-dashboard-enhancer
// @version      1.7.0
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
        const log = (msg, ...args) => {
            console.log('[Trae Enhancer] ' + msg, ...args);
        };

        const debugMarker = document.createElement('div');
        debugMarker.id = 'trae-enhancer-debug';
        debugMarker.style.display = 'none';
        debugMarker.textContent = 'script running';
        document.documentElement.appendChild(debugMarker);
        log('Script started, debug marker injected');

        const isQwenWork = window.location.hostname.includes('qwenwork.cn');
        const isTrae = window.location.hostname.includes('trae.cn');
        log('Running on:', isQwenWork ? 'qwenwork.cn' : isTrae ? 'trae.cn' : 'unknown');

        const CONFIG = {
            storageKey: isQwenWork ? 'qwenwork_usage_data' : 'trae_usage_data',
            refreshInterval: 60000,
            maxAutoPages: 100,
        };

        const API_CONFIG = {
            trae: {
                creditField: 'credits_float',
                altCreditField: 'amount_float',
                timeField: 'usage_time',
                altTimeField: 'created_at',
                sessionIdField: 'session_id'
            },
            qwenwork: {
                creditField: 'credits',
                altCreditField: 'total_tokens',
                timeField: 'created_at',
                altTimeField: 'usage_time',
                sessionIdField: 'record_id'
            }
        };

        const currentConfig = isQwenWork ? API_CONFIG.qwenwork : API_CONFIG.trae;

    const DataStore = {
        sessions: null,
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
        mergeApiResponse(url, responseData, requestInfo) {
            const store = this.get();
            if (!store.api_responses) store.api_responses = [];
            if (!store.usage_sessions) store.usage_sessions = [];

            const isSuccess = (responseData && responseData.success === true) ||
                              (responseData && (responseData.code === undefined || responseData.code === 0 || responseData.code === 200));
            
            if (!isSuccess) {
                return store;
            }

            store.api_responses.push({
                url: url,
                time: Date.now(),
                data: responseData
            });

            let sessions = null;
            let pagination = null;
            
            if (responseData && responseData.user_usage_group_by_sessions) {
                sessions = responseData.user_usage_group_by_sessions;
                pagination = responseData;
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

            if (responseData && responseData.user_entitlement_pack_list) {
                store.entitlement = responseData;
            }

            if (responseData && responseData.is_credits_billing !== undefined) {
                store.billing_status = responseData;
            }

            if (store.api_responses.length > 100) {
                store.api_responses = store.api_responses.slice(-100);
            }

            this.set(store);
            return store;
        }
    };

    let _lastApiRequest = {};
    let _rawFetch = null;

    async function fetchAllPages(baseUrl, requestBody, totalPages, currentPage, requestHeaders, isDiscovery) {
        log('Fetching all pages: current=' + currentPage + ', total=' + totalPages);
        const doFetch = _rawFetch || window.fetch.bind(window);
        try {
            for (let page = currentPage + 1; page <= totalPages; page++) {
                const before = (DataStore.get().usage_sessions || []).length;
                try {
                    const body = Object.assign({}, requestBody || {});
                    const pageField = ('page_num' in body) ? 'page_num' : 'page';
                    body[pageField] = page;
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
                    if (isDiscovery && after === before) {
                        break;
                    }
                } catch (e) {
                    log('Auto-fetch page ' + page + ' failed:', e);
                    break;
                }
                await new Promise(r => setTimeout(r, 300));
            }
        } finally {
            const store = DataStore.get();
            delete store._autoFetching;
            delete store._pagingKey;
            DataStore.set(store);
        }
        renderDashboard();
        log('All pages fetched. Total sessions:', (DataStore.get().usage_sessions || []).length);
    }

    function setupNetworkInterceptor() {
        log('Setting up network interceptors...');

        const originalFetch = window.fetch;
        _rawFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');
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
                if (isTraeApi(url)) {
                    try {
                        const clonedResponse = response.clone();
                        const data = await clonedResponse.json();
                        DataStore.mergeApiResponse(url, data, isUsageSessionApi(url) ? reqInfo : null);
                        renderDashboard();
                    } catch (e) {}
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

    function isUsageSessionApi(url) {
        return url && url.includes('query_user_usage_group_by_session');
    }

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
        return !!url && ['/trae/api/v1/pay/', '/trae/api/v2/pay/', '/cloudide/api/v3/common/GetUserToken', 'query_user_usage_group_by_session', 'user_current_entitlement_list', 'cn_credits_billing_status', 'web_user_pay_status', 'expired_ents'].some(s => url.includes(s));
    }

    function renderDashboard() {
        log('Rendering dashboard...');
        const data = DataStore.get();
        const container = getOrCreateContainer();
        if (!container) {
            log('Container not found, aborting render');
            return;
        }

        if (isQwenWork) {
            container.classList.add('qwenwork-theme');
        }

        const sessions = DataStore.sessions || data.usage_sessions || [];
        const entitlement = data.entitlement;

        const stats = computeStats(sessions, entitlement);

        container.innerHTML = `
            <div class="trae-enhancer-header">
                <h3> 用量增强面板</h3>
                <span class="trae-enhancer-badge">v1.7.0</span>
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
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
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

            let ts = 0;
            const rawDate = s[currentConfig.timeField] || s[currentConfig.altTimeField];
            if (typeof rawDate === 'number' && rawDate > 946684800000) {
                ts = rawDate;
            } else if (typeof rawDate === 'number' && rawDate > 946684800) {
                ts = rawDate * 1000;
            } else if (typeof rawDate === 'string') {
                const d = new Date(rawDate);
                if (!isNaN(d.getTime())) {
                    ts = d.getTime();
                }
            }
            if (ts === 0 && sessions.indexOf(s) < 3) {
                log('usage_time parse failed:', rawDate, typeof rawDate);
            }

            let model = s.model_name || '未知模型auto';
            if (!model || model === '—' || model === '-' || model === '--') {
                model = '过期积分';
            }
            if (!modelMap[model]) {
                modelMap[model] = { credits: 0, calls: 0 };
            }
            modelMap[model].credits += credits;
            modelMap[model].calls += 1;

            if (ts > 0) {
                const dateStr = formatLocalDate(new Date(ts));
                if (!dailyMap[dateStr]) {
                    dailyMap[dateStr] = { cents: 0, calls: 0 };
                }
                dailyMap[dateStr].cents += Math.round(credits * 100);
                dailyMap[dateStr].calls += 1;
            }
        });

        const modelBreakdown = Object.entries(modelMap)
            .map(([name, data]) => ({ name, credits: data.credits, calls: data.calls }))
            .sort((a, b) => b.credits - a.credits);

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

        let totalEntitlementCredits = 0;
        if (entitlement && entitlement.user_entitlement_pack_list) {
            entitlement.user_entitlement_pack_list.forEach(pack => {
                totalEntitlementCredits += pack.amount_float || pack.credits_float || pack.total_amount || pack.amount || 0;
            });
        }
        if (totalEntitlementCredits > 0 && totalCredits === 0) {
            totalCredits = totalEntitlementCredits;
        }

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

    function getOrCreateContainer() {
        let container = document.getElementById('trae-enhancer-root');
        if (container) return container;

        if (isQwenWork) {
            container = document.createElement('div');
            container.id = 'trae-enhancer-root';
            container.style.cssText = 'width:100%;max-width:1400px;margin:0 auto;padding:0 20px;box-sizing:border-box;';
            document.body.appendChild(container);
            log('Creating full-width container on body (qwenwork.cn)');
            return container;
        }

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
        #trae-enhancer-root.qwenwork-theme .trend-value {
            color: #2563eb;
        }
        #trae-enhancer-root.qwenwork-theme .trend-label {
            color: #6b7280;
        }
        #trae-enhancer-root.qwenwork-theme .trae-enhancer-footer {
            border-top-color: #e5e7eb;
        }
    `);

    function parseRecordsFromQwenworkDOM(container) {
        const containerText = container ? (container.innerText || '') : '';
        const lines = containerText.split('\n').map(l => l.trim()).filter(l => l);
        
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
        return records;
    }

    function storeQwenworkRecords(records) {
        const newSessions = records
            .filter(r => r.credits < 0)
            .map(r => ({
                model_name: r.source || '未知模型auto',
                session_name: r.detail || '',
                usage_time: r.time,
                credits: Math.abs(r.credits),
                credit_type: 'consumed',
                _recordKey: r.time + '|' + r.source + '|' + r.detail
            }));

        const existing = DataStore.sessions || [];
        const existingKeys = new Set(existing.map(s => s._recordKey || ''));
        let merged = [...existing];
        let added = 0;
        for (const s of newSessions) {
            if (!existingKeys.has(s._recordKey)) {
                merged.push(s);
                existingKeys.add(s._recordKey);
                added++;
            }
        }
        DataStore.sessions = merged;
        DataStore.lastUpdated = new Date().toISOString();
        log('QwenWork: Added', added, 'new sessions, total:', merged.length);
        return added;
    }

    function findQwenworkDataContainer() {
        const usedTab = Array.from(document.querySelectorAll('*')).find(el => 
            el.innerText && el.innerText.trim() === '已使用' && el.children.length === 0
        );
        if (!usedTab) return null;

        let dataContainer = usedTab.parentElement;
        for (let depth = 0; depth < 15; depth++) {
            if (!dataContainer || dataContainer === document.body) break;
            const containerText = dataContainer.innerText || '';
            if (/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(containerText) && containerText.length > 100) {
                log('QwenWork: Found data container at depth', depth, 'tag:', dataContainer.tagName);
                break;
            }
            dataContainer = dataContainer.parentElement;
        }
        return dataContainer;
    }

    function clickQwenworkUsedTab() {
        return new Promise((resolve) => {
            const usedBtn = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]')).find(el => 
                el.innerText && el.innerText.trim() === '已使用'
            );
            if (!usedBtn) {
                log('QwenWork: "已使用" button not found for click');
                resolve(false);
                return;
            }
            log('QwenWork: Clicking "已使用" button');
            usedBtn.click();

            let waited = 0;
            const interval = setInterval(() => {
                waited += 500;
                const container = findQwenworkDataContainer();
                if (container) {
                    const records = parseRecordsFromQwenworkDOM(container);
                    if (records.length > 0) {
                        clearInterval(interval);
                        log('QwenWork: Data loaded after', waited, 'ms, records:', records.length);
                        resolve(true);
                        return;
                    }
                }
                if (waited >= 10000) {
                    clearInterval(interval);
                    log('QwenWork: Data load timeout after 10s');
                    resolve(true);
                }
            }, 500);
        });
    }

    async function fetchAllQwenworkPagesFromDOM() {
        let container = findQwenworkDataContainer();
        if (!container) {
            log('QwenWork: No data container found for pagination');
            return false;
        }

        let records = parseRecordsFromQwenworkDOM(container);
        log('QwenWork: Current page records:', records.length);
        storeQwenworkRecords(records);

        // 遍历翻页控件
        let page = 1;
        let maxPages = 100; // 安全上限
        let hasMore = true;

        while (hasMore && page < maxPages) {
            // 查找翻页容器
            const paginationContainer = findPaginationContainer();
            if (!paginationContainer) {
                log('QwenWork: No pagination controls found, only 1 page');
                break;
            }

            // 找"下一页"按钮
            const nextBtn = findNextPageButton(paginationContainer);
            if (!nextBtn || nextBtn.disabled || nextBtn.classList.contains('disabled') || nextBtn.getAttribute('aria-disabled') === 'true') {
                log('QwenWork: No more pages (next button disabled/missing)');
                break;
            }

            page++;
            log('QwenWork: Clicking page', page);
            try {
                nextBtn.click();
            } catch(e) {
                log('QwenWork: Click failed:', e);
                break;
            }

            // 等待数据刷新
            await new Promise(r => setTimeout(r, 1500));

            // 重新获取容器并提取数据
            container = findQwenworkDataContainer();
            if (!container) {
                log('QwenWork: Container lost after page change');
                break;
            }
            records = parseRecordsFromQwenworkDOM(container);
            const added = storeQwenworkRecords(records);
            log('QwenWork: Page', page, 'records:', records.length, 'new:', added);

            if (added === 0 && records.length > 0) {
                log('QwenWork: No new records on page', page, '- all already seen, stopping');
                break;
            }
        }

        log('QwenWork: Pagination complete, total pages:', page, 'total sessions:', (DataStore.sessions || []).length);
        return true;
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
        const allElements = document.querySelectorAll('button, a, [role="button"], li, span');
        for (const el of allElements) {
            if (el.textContent.includes('下一页') || el.textContent.includes('>') && el.textContent.length < 10) {
                let parent = el.parentElement;
                for (let d = 0; d < 5 && parent; d++) {
                    if (parent.querySelectorAll('button, a, li').length >= 2) {
                        return parent;
                    }
                    parent = parent.parentElement;
                }
            }
        }
        return null;
    }

    function findNextPageButton(container) {
        const candidates = container.querySelectorAll('button, a, [role="button"], li');
        for (const el of candidates) {
            const text = el.textContent.trim();
            if (el.getAttribute('aria-label') === 'Next page' || 
                el.getAttribute('aria-label') === '下一页' ||
                text === '下一页' || 
                text === '>' || 
                text === '›' ||
                text === 'next') {
                return el;
            }
        }
        const all = Array.from(container.querySelectorAll('*'));
        for (let i = 0; i < all.length; i++) {
            const text = all[i].textContent.trim();
            if ((text === '>' || text === '›') && all[i].tagName === 'SPAN') {
                const parent = all[i].parentElement;
                if (parent && (parent.tagName === 'BUTTON' || parent.tagName === 'A' || parent.getAttribute('role') === 'button')) {
                    return parent;
                }
                return all[i].parentElement;
            }
        }
        return null;
    }

    async function fetchUsageData() {
        if (isQwenWork) {
            log('QwenWork: Starting DOM data extraction...');

            const clicked = await clickQwenworkUsedTab();
            if (!clicked) {
                log('QwenWork: Failed to click "已使用" tab, retrying in 3s...');
                await new Promise(r => setTimeout(r, 3000));
            }
            
            try {
                await fetchAllQwenworkPagesFromDOM();
            } catch(e) {
                log('QwenWork: Pagination error:', e);
            }
            
            try {
                const bodyText = document.body.innerText;
                const creditMatch = bodyText.match(/剩余可用[\s\S]*?([\d,]+\.\d+)/);
                if (creditMatch) log('QwenWork: Remaining credits:', creditMatch[1]);
                const dailyMatch = bodyText.match(/剩余\s+([\d.]+)\s*$/m);
                if (dailyMatch) log('QwenWork: Daily remaining:', dailyMatch[1]);
            } catch(e) {}
            
            log('QwenWork: DOM extraction complete');
        } else {
            const usageUrl = 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session';
            const tokenUrl = 'https://api.trae.cn/cloudide/api/v3/common/GetUserToken';

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

    function triggerApiCalls() {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

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
                            btn.click();
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

    function waitForDataAndRender(maxRetries = 30) {
        renderDashboard();

        if (isQwenWork) {
            setTimeout(() => {
                log('QwenWork: Fast path - starting DOM extraction immediately');
                fetchUsageData().then(() => renderDashboard()).catch(err => {
                    log('fetchUsageData error:', err);
                    renderDashboard();
                });
            }, 100);
        } else {
            let retries = 0;
            const check = () => {
                const data = DataStore.get();
                const sessions = data.usage_sessions || [];
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
                    log('Trying active fetch...');
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
    }

    function observePageChanges() {
        const observer = new MutationObserver(() => {
            if (!document.getElementById('trae-enhancer-root')) {
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

    function init() {
        GM_log('[Trae Enhancer] Initializing...');

        setupNetworkInterceptor();

        if (document.readyState === 'complete') {
            waitForDataAndRender();
            observePageChanges();
        } else {
            window.addEventListener('load', () => {
                waitForDataAndRender();
                observePageChanges();
            });
        }

        setInterval(() => {
            const data = DataStore.get();
            if ((data.usage_sessions || []).length > 0) {
                renderDashboard();
            }
        }, CONFIG.refreshInterval);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    } catch (e) {
        console.error('[Trae Enhancer] Script error:', e);
    }
})();