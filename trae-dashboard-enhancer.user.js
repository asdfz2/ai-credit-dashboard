// ==UserScript==
// @name         Trae 用量仪表盘增强
// @namespace    https://github.com/asdfz2/trae-dashboard-enhancer
// @version      1.5.1
// @description  为 Trae 用量仪表盘添加积分消耗统计、模型 breakdown 与近 7 天趋势
// @author       asdfz2
// @homepageURL  https://github.com/asdfz2/trae-dashboard-enhancer
// @supportURL   https://github.com/asdfz2/trae-dashboard-enhancer/issues
// @downloadURL  https://raw.githubusercontent.com/asdfz2/trae-dashboard-enhancer/main/trae-dashboard-enhancer.user.js
// @updateURL    https://raw.githubusercontent.com/asdfz2/trae-dashboard-enhancer/main/trae-dashboard-enhancer.user.js
// @license      MIT
// @match        https://www.trae.cn/dashboard*
// @match        https://trae.cn/dashboard*
// @icon         https://www.trae.cn/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_log
// @run-at       document-end
// @noframes
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

        // ========== 配置 ==========
        const CONFIG = {
            storageKey: 'trae_usage_data',
            refreshInterval: 60000, // 60秒检查一次新数据
        };

    // ========== 数据管理 ==========
    const DataStore = {
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
        // 合并API响应数据
        mergeApiResponse(url, responseData) {
            const store = this.get();
            if (!store.api_responses) store.api_responses = [];
            if (!store.usage_sessions) store.usage_sessions = [];

            // 只处理成功响应（code=0 或没有 code 字段）
            const code = responseData && responseData.code;
            if (code !== undefined && code !== 0 && code !== 200) {
                return store; // 跳过非成功响应
            }

            // 记录API响应
            store.api_responses.push({
                url: url,
                time: Date.now(),
                data: responseData
            });

            // 解析会话级用量数据
            if (responseData && responseData.user_usage_group_by_sessions) {
                const sessions = responseData.user_usage_group_by_sessions;

                // 日志输出分页信息（仅首次）
                if (!store._paginationLogged) {
                    store._paginationLogged = true;
                    log('API response top-level keys:', Object.keys(responseData).join(', '));
                    log('Sessions count:', sessions.length);
                    ['total', 'page', 'pageSize', 'page_size', 'totalPages', 'total_pages', 'hasMore', 'has_more', 'offset', 'limit', 'count'].forEach(key => {
                        if (responseData[key] !== undefined) {
                            log('Pagination field -', key + ':', responseData[key]);
                        }
                    });
                }

                // 自动翻页：检测分页字段
                const total = responseData.total || responseData.count || 0;
                const pageSize = responseData.pageSize || responseData.page_size || responseData.limit || 21;
                const currentPage = responseData.page || 1;
                const totalPages = responseData.totalPages || responseData.total_pages || Math.ceil(total / pageSize);

                if (total > 0 && totalPages > currentPage && !store._autoFetching) {
                    store._autoFetching = true;
                    this.set(store);
                    log('Auto-pagination: page ' + currentPage + '/' + totalPages + ', sessions:' + total);
                    const body = _lastApiRequest.body || {};
                    fetchAllPages(url, body, totalPages, currentPage);
                }

                sessions.forEach(session => {
                    const existing = store.usage_sessions.findIndex(s => s.session_id === session.session_id);
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

    async function fetchAllPages(baseUrl, requestBody, totalPages, currentPage) {
        log('Fetching all pages: current=' + currentPage + ', total=' + totalPages);
        for (let page = currentPage + 1; page <= totalPages; page++) {
            try {
                const body = { ...requestBody, page: page };
                const resp = await fetch(baseUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (resp.ok) {
                    const data = await resp.json();
                    DataStore.mergeApiResponse(baseUrl, data);
                    log('Fetched page ' + page + '/' + totalPages);
                }
            } catch (e) {
                log('Auto-fetch page ' + page + ' failed:', e);
            }
            // 稍微延迟，避免请求过快
            await new Promise(r => setTimeout(r, 300));
        }
        renderDashboard();
        log('All pages fetched. Total sessions:', (DataStore.get().usage_sessions || []).length);
    }

    // ========== 网络请求拦截 ==========
    function setupNetworkInterceptor() {
        log('Setting up network interceptors...');

        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');
            return originalFetch.apply(this, arguments).then(async response => {
                // 只拦截 Trae 相关 API
                if (isTraeApi(url)) {
                    try {
                        const clonedResponse = response.clone();
                        const data = await clonedResponse.json();
                        DataStore.mergeApiResponse(url, data);
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
        XMLHttpRequest.prototype.open = function(method, url) {
            this._traeMethod = method;
            this._traeUrl = typeof url === 'string' ? url : (url || '');
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
            if (this._traeUrl && isTraeApi(this._traeUrl)) {
                // 保存请求体，用于自动翻页
                _lastApiRequest = {
                    url: this._traeUrl,
                    method: this._traeMethod,
                    body: body ? JSON.parse(body) : {}
                };
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        DataStore.mergeApiResponse(this._traeUrl, data);
                        renderDashboard();
                    } catch (e) {}
                });
            }
            return originalSend.apply(this, arguments);
        };
    }

    function isTraeApi(url) {
        if (!url) return false;
        return url.includes('/trae/api/v1/pay/') ||
               url.includes('/trae/api/v2/pay/') ||
               url.includes('/cloudide/api/v3/common/GetUserToken') ||
               url.includes('query_user_usage_group_by_session') ||
               url.includes('user_current_entitlement_list') ||
               url.includes('cn_credits_billing_status') ||
               url.includes('web_user_pay_status') ||
               url.includes('expired_ents');
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

        const sessions = data.usage_sessions || [];
        const entitlement = data.entitlement;

        // 计算统计数据
        const stats = computeStats(sessions, entitlement);

        container.innerHTML = `
            <div class="trae-enhancer-header">
                <h3>📊 用量增强面板</h3>
                <span class="trae-enhancer-badge">v1.5</span>
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

    function computeStats(sessions, entitlement) {
        const now = Date.now();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);

        let totalCredits = 0;
        let todayCredits = 0;
        let sevenDaysCredits = 0;
        let monthCredits = 0;
        let totalCalls = 0;
        const modelMap = {};
        const dailyMap = {};

        sessions.forEach(s => {
            const credits = s.credits_float || s.amount_float || 0;
            totalCredits += credits;
            totalCalls += 1;

            // 解析时间（兼容多种格式）
            let ts = 0;
            const rawDate = s.usage_time;
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

            // 按时间范围统计
            if (ts >= todayStart.getTime()) {
                todayCredits += credits;
            }
            if (ts >= sevenDaysAgo) {
                sevenDaysCredits += credits;
            }
            if (ts >= monthStart.getTime()) {
                monthCredits += credits;
            }

            // 模型维度
            const model = s.model_name || '未知模型auto';
            if (!modelMap[model]) {
                modelMap[model] = { credits: 0, calls: 0 };
            }
            modelMap[model].credits += credits;
            modelMap[model].calls += 1;

            // 日期维度（使用本地时间，与 todayCredits 保持一致）
            if (ts > 0) {
                const d = new Date(ts);
                const dateStr = d.getFullYear() + '-' +
                    String(d.getMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getDate()).padStart(2, '0');
                if (!dailyMap[dateStr]) {
                    dailyMap[dateStr] = { credits: 0, calls: 0 };
                }
                dailyMap[dateStr].credits += credits;
                dailyMap[dateStr].calls += 1;
            }
        });

        // 模型排序
        const modelBreakdown = Object.entries(modelMap)
            .map(([name, data]) => ({ name, credits: data.credits, calls: data.calls }))
            .sort((a, b) => b.credits - a.credits);

        // 近7天趋势
        const dailyTrend = Object.entries(dailyMap)
            .filter(([date]) => {
                const d = new Date(date);
                return !isNaN(d.getTime()) && d.getTime() >= sevenDaysAgo;
            })
            .map(([date, data]) => ({ date, credits: data.credits, calls: data.calls }))
            .sort((a, b) => a.date.localeCompare(b.date));

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
        // 如果 dailyTrend 为空但 sessions 有数据，用当前日期显示
        if (dailyTrend.length === 0 && sessions.length > 0) {
            const todayStr = new Date().toISOString().substring(0, 10);
            dailyTrend.push({ date: todayStr, credits: totalCredits, calls: totalCalls });
            log('Trend fallback: assigned all credits to', todayStr);
        }
        log('Stats computed:', {
            sessions: sessions.length,
            totalCredits,
            dailyTrend: dailyTrend.length + ' entries',
            validTimestamps: Object.keys(dailyMap).length
        });

        const lastUpdate = sessions.length > 0
            ? new Date().toLocaleString('zh-CN')
            : '暂无数据，请先使用 Trae';

        return {
            totalCredits: Math.round(totalCredits * 100) / 100,
            totalSessions: sessions.length,
            totalCalls: totalCalls,
            todayCredits: Math.round(todayCredits * 100) / 100,
            sevenDaysCredits: Math.round(sevenDaysCredits * 100) / 100,
            monthCredits: Math.round(monthCredits * 100) / 100,
            modelBreakdown: modelBreakdown,
            dailyTrend: dailyTrend,
            lastUpdate: lastUpdate
        };
    }

    function renderModelBreakdown(breakdown) {
        if (breakdown.length === 0) {
            return '<div class="trae-enhancer-empty">暂无数据，请先使用 Trae 进行对话</div>';
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

        const maxCredits = Math.max(...trend.map(d => d.credits), 1);

        let html = '<div class="trend-chart">';
        trend.forEach(d => {
            const pct = (d.credits / maxCredits * 100).toFixed(1);
            const dateLabel = d.date.substring(5); // MM-DD
            html += `
                <div class="trend-bar-wrapper">
                    <div class="trend-bar" style="height: ${pct}%">
                        <span class="trend-value">${formatNumber(d.credits)}</span>
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

        // 查找页面主体区域
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
    `);

    // ========== 主动获取 API 数据（拦截器没抓到时的后备方案） ==========
    async function fetchUsageData() {
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
            if (retries === 10) {
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

    // ========== 监听页面 DOM 变化（SPA 重新渲染时重新插入容器） ==========
    function observePageChanges() {
        const observer = new MutationObserver(() => {
            // 检查容器是否还在
            if (!document.getElementById('trae-enhancer-root')) {
                // 容器被移除了，重新渲染
                const data = DataStore.get();
                if ((data.usage_sessions || []).length > 0) {
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
