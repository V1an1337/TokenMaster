// ==UserScript==
// @name         Token 管理器（支持导出）
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  按域扫描 Cookie（含子域与完整属性），支持 localStorage / sessionStorage / Cookie 的保存与属性级回放（domain/path/expires/httpOnly）
// @author       github.com/V1an1337
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_cookie
// @grant        GM.cookie
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'token_manager_records';
    const currentHostname = location.hostname;

    // 存储相关函数
    function generateRecordId() {
        try {
            if (typeof crypto !== 'undefined') {
                if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
                if (typeof crypto.getRandomValues === 'function') {
                    const bytes = new Uint8Array(16);
                    crypto.getRandomValues(bytes);
                    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                }
            }
        } catch (e) {}

        return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }

    function getAllRecords() {
        const raw = GM_getValue(STORAGE_KEY, '{}');
        try {
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }

    function saveAllRecords(records) {
        GM_setValue(STORAGE_KEY, JSON.stringify(records));
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    // 强制输入框/文本域使用黑字白底，避免被站点深色主题 CSS 覆盖导致“有值却看不见”
    function applyReadableFieldStyles(el) {
        if (!el || !el.style) return;
        try {
            el.style.setProperty('color', '#000', 'important');
            el.style.setProperty('background-color', '#ffffff', 'important');
            el.style.setProperty('-webkit-text-fill-color', '#000', 'important');
            el.style.setProperty('color-scheme', 'light', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
        } catch (e) {}
    }

    function getCookieMap() {
        const map = {};
        if (!document.cookie) return map;

        document.cookie.split(';').forEach(raw => {
            const trimmed = raw.trim();
            if (!trimmed) return;

            const eqPos = trimmed.indexOf('=');
            if (eqPos === -1) return;

            const key = trimmed.substring(0, eqPos);
            let value = trimmed.substring(eqPos + 1);

            try {
                value = decodeURIComponent(value);
            } catch (e) {}

            map[key] = value;
        });

        return map;
    }

    // ===== Cookie API（兼容 GM_cookie 与 GM.cookie 两种 Tampermonkey API，回调 / Promise 双形式）=====

    const cookieApi = (typeof GM !== 'undefined' && GM && GM.cookie) ? GM.cookie
        : ((typeof GM_cookie !== 'undefined') ? GM_cookie : null);

    function hasCookieApi() {
        return !!(cookieApi && typeof cookieApi.list === 'function');
    }

    // list -> cookie 数组；set / delete -> 是否成功
    function callCookieApi(method, details) {
        return new Promise(resolve => {
            const fn = (cookieApi && typeof cookieApi[method] === 'function') ? cookieApi[method] : null;
            if (!fn) {
                resolve(method === 'list' ? [] : false);
                return;
            }

            let settled = false;
            const finish = (...args) => {
                if (settled) return;
                settled = true;

                if (method === 'list') {
                    const cookies = args[0];
                    resolve(Array.isArray(cookies) ? cookies : []);
                    return;
                }

                // set / delete 的回调可能是 (error) 或 (cookie, error)，统一取最后一个参数判断
                const error = args.length > 1 ? args[1] : args[0];
                resolve(!error);
            };

            try {
                const maybe = fn.call(cookieApi, details, function () { finish.apply(null, arguments); });
                if (maybe && typeof maybe.then === 'function') {
                    maybe.then(value => finish(value), reason => finish(reason || 'cookie-api-error'));
                }
            } catch (e) {
                finish(method === 'list' ? [] : 'cookie-api-error');
            }
        });
    }

    function listCookies(details) { return callCookieApi('list', details); }
    function setCookieViaApi(details) { return callCookieApi('set', details); }
    function deleteCookieViaApi(details) { return callCookieApi('delete', details); }

    function normalizeCookieDomain(value) {
        if (typeof value !== 'string') return '';
        let domain = value.trim().toLowerCase();
        if (!domain) return '';
        domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
        domain = domain.split('/')[0];
        return domain;
    }

    function normalizeSameSite(value) {
        const v = String(value || '').toLowerCase();
        if (v === 'no_restriction' || v === 'none') return 'no_restriction';
        if (v === 'lax') return 'lax';
        if (v === 'strict') return 'strict';
        return '';
    }

    // 常见多段公共后缀 / 共享托管后缀：按域扫描到此为止，避免抓到无关站点的 Cookie
    const COOKIE_SCAN_STOP_SUFFIXES = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
        'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
        'co.kr', 'or.kr', 'ne.kr', 'pe.kr',
        'com.tw', 'org.tw', 'net.tw', 'idv.tw', 'com.hk', 'org.hk', 'edu.hk',
        'com.sg', 'org.sg', 'edu.sg', 'com.my', 'org.my', 'com.ph', 'com.vn',
        'com.id', 'co.id', 'or.id', 'web.id',
        'co.nz', 'net.nz', 'org.nz', 'co.in', 'net.in', 'org.in', 'firm.in',
        'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.ru', 'com.ua',
        'co.za', 'co.il', 'com.sa', 'com.eg', 'com.pk', 'com.bd',
        'github.io', 'gitlab.io', 'githubusercontent.com',
        'vercel.app', 'now.sh', 'netlify.app', 'netlify.com', 'pages.dev', 'workers.dev',
        'deno.dev', 'fly.dev', 'herokuapp.com', 'onrender.com', 'railway.app',
        'up.railway.app', 'koyeb.app', 'cyclic.app', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev',
        'web.app', 'firebaseapp.com', 'appspot.com', 'run.app', 'azurewebsites.net',
        'cloudfront.net', 's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'tumblr.com',
        'wixsite.com', 'squarespace.com', 'myshopify.com', 'neocities.org', 'readthedocs.io',
        'localhost'
    ]);

    // 按域扫描列表：从完整 hostname 逐级向上，直到公共后缀/共享后缀为止。
    // 例：suno.com -> [suno.com]；www.suno.com -> [www.suno.com, suno.com]
    // 这样可以覆盖 Clerk 之类的兄弟子域（auth.suno.com / clerk.suno.com）
    function getCookieScanDomains(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
        if (!host) return [];
        if (/^[\d.]+$/.test(host) || host.includes(':')) return [host];

        const parts = host.split('.');
        if (parts.length <= 1) return [host];

        const domains = [];
        for (let i = 0; i <= parts.length - 2; i++) {
            const suffix = parts.slice(i).join('.');
            if (COOKIE_SCAN_STOP_SUFFIXES.has(suffix)) break;
            domains.push(suffix);
        }

        return domains.length ? domains : [host];
    }

    function buildCookieUrl(item) {
        const domain = (normalizeCookieDomain(item && item.domain) || normalizeCookieDomain(currentHostname)).replace(/^\./, '');
        const rawPath = (item && typeof item.path === 'string' && item.path) ? item.path : '/';
        const path = rawPath.charAt(0) === '/' ? rawPath : `/${rawPath}`;
        const scheme = (item && (item.secure === true || item.httpOnly === true))
            ? 'https'
            : (location.protocol === 'https:' ? 'https' : 'http');
        return `${scheme}://${domain || 'localhost'}${path}`;
    }

    function buildCookieItemFromApi(cookie) {
        if (!cookie || typeof cookie.name !== 'string' || !cookie.name) return null;

        const item = { type: 'Cookie', key: cookie.name, value: cookie.value ?? '' };
        const domain = normalizeCookieDomain(cookie.domain);
        if (domain) item.domain = domain;
        if (typeof cookie.path === 'string' && cookie.path) item.path = cookie.path;
        if (typeof cookie.secure === 'boolean') item.secure = cookie.secure;
        if (typeof cookie.httpOnly === 'boolean') item.httpOnly = cookie.httpOnly;
        if (cookie.sameSite) {
            const sameSite = normalizeSameSite(cookie.sameSite);
            if (sameSite) item.sameSite = sameSite;
        }
        if (typeof cookie.hostOnly === 'boolean') item.hostOnly = cookie.hostOnly;

        let expirationDate = cookie.expirationDate;
        if (typeof expirationDate === 'number' && isFinite(expirationDate)) {
            if (expirationDate > 1e12) expirationDate = Math.floor(expirationDate / 1000);
            item.expirationDate = expirationDate;
        } else if (cookie.session === true) {
            item.session = true;
        }

        return item;
    }

    async function collectCookieItemsForCurrentSite() {
        const items = [];
        const seen = new Set();

        const push = cookie => {
            const item = buildCookieItemFromApi(cookie);
            if (!item) return;
            const dedupeKey = `${item.key}\u0000${item.domain || ''}\u0000${item.path || '/'}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            items.push(item);
        };

        if (hasCookieApi()) {
            const scans = [listCookies({ url: location.href })];
            getCookieScanDomains(currentHostname).forEach(domain => {
                scans.push(listCookies({ domain }));
            });

            const results = await Promise.all(scans);
            results.forEach(list => list.forEach(push));
        }

        // 兜底：GM_cookie 不可用时，至少保存当前页面 document.cookie 可见的键值
        const docMap = getCookieMap();
        Object.keys(docMap).forEach(name => {
            if (items.some(item => item.key === name)) return;
            items.push({ type: 'Cookie', key: name, value: docMap[name] });
        });

        return items;
    }

    function buildCookieString(key, value, expires, path) {
        const parts = [`${key}=${encodeURIComponent(value ?? '')}`, `path=${path || '/'}`];
        if (expires) parts.push(`expires=${expires}`);

        if (key.startsWith('__Secure-') || key.startsWith('__Host-')) {
            parts.push('Secure');
        }

        return parts.join('; ');
    }

    function storageForType(type) {
        const t = String(type || '').toLowerCase();
        if (t === 'localstorage') return localStorage;
        if (t === 'sessionstorage') return sessionStorage;
        return null;
    }

    // 按记录的属性回放单条 Cookie（domain / path / expires / httpOnly / secure / sameSite）
    async function applyCookieItem(item, options) {
        const opts = options || {};
        const name = String(item && item.key || '');
        if (!name) return false;

        const value = (typeof opts.value === 'string') ? opts.value : (item.value ?? '');
        const domain = normalizeCookieDomain(item.domain);
        const path = (typeof item.path === 'string' && item.path) ? item.path : '/';
        const shouldRemove = opts.remove === true || value === '';

        if (hasCookieApi() && typeof cookieApi.set === 'function') {
            const url = buildCookieUrl(item);

            if (shouldRemove) {
                const removed = await deleteCookieViaApi({ url, name });
                if (removed) return true;
                return setCookieViaApi({
                    url,
                    name,
                    value: '',
                    path,
                    expirationDate: Math.floor(Date.now() / 1000) - 60
                });
            }

            const details = { url, name, value, path };
            if (domain && item.hostOnly !== true) details.domain = domain;
            if (item.secure === true) details.secure = true;
            if (item.httpOnly === true) details.httpOnly = true;
            const sameSite = normalizeSameSite(item.sameSite);
            if (sameSite) details.sameSite = sameSite;
            if (typeof item.expirationDate === 'number' && isFinite(item.expirationDate)) {
                details.expirationDate = Math.floor(item.expirationDate);
            }

            let ok = await setCookieViaApi(details);
            if (!ok && details.sameSite) {
                // 部分 Tampermonkey 版本设置 SameSite=None 会失败，去掉后重试
                delete details.sameSite;
                ok = await setCookieViaApi(details);
            }
            return ok;
        }

        // 无 Cookie API：退化为 document.cookie（仅当前主机、非 HttpOnly）
        const cookieHost = domain.replace(/^\./, '');
        const hostMatches = !cookieHost
            || cookieHost === currentHostname
            || (!!currentHostname && currentHostname.endsWith(`.${cookieHost}`));
        if (!hostMatches) return false;

        if (shouldRemove) {
            document.cookie = buildCookieString(name, '', 'Thu, 01 Jan 1970 00:00:00 GMT', path);
            return true;
        }

        document.cookie = buildCookieString(name, value, null, path);
        return true;
    }

    function ensureRecordIdsForHost(host) {
        const all = getAllRecords();
        if (!Array.isArray(all[host])) return all;

        let changed = false;
        all[host].forEach(record => {
            if (!record || typeof record !== 'object') return;
            if (typeof record.id !== 'string' || record.id.trim() === '') {
                record.id = generateRecordId();
                changed = true;
            }
        });

        if (changed) saveAllRecords(all);
        return all;
    }

    function getRecordsForHost(host) {
        const all = ensureRecordIdsForHost(host);
        const hostRecords = Array.isArray(all[host]) ? all[host] : [];
        // Sort a copy so UI order doesn't implicitly become the storage "index".
        return [...hostRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    function getDisplayName(record) {
        const fallback = new Date(record?.date || Date.now()).toLocaleString();
        if (!record || typeof record.name !== 'string') return fallback;
        const trimmed = record.name.trim();
        return trimmed || fallback;
    }

    function updateRecordNameById(recordId, name) {
        const all = ensureRecordIdsForHost(currentHostname);
        if (!Array.isArray(all[currentHostname])) return;

        const index = all[currentHostname].findIndex(record => record && record.id === recordId);
        if (index < 0) return;

        const record = all[currentHostname][index];
        const fallback = new Date(record?.date || Date.now()).toLocaleString();
        const nextName = typeof name === 'string' ? name.trim() : '';

        record.name = nextName || fallback;
        saveAllRecords(all);
    }

    async function saveCurrentRecord() {
        const items = await getTokenItems();
        if (items.length === 0) {
            alert('当前页面未找到可保存的数据（localStorage / sessionStorage / Cookie），无法保存。');
            return;
        }

        const now = new Date();
        const defaultName = now.toLocaleString();

        const all = getAllRecords();
        if (!all[currentHostname]) all[currentHostname] = [];

        all[currentHostname].push({
            id: generateRecordId(),
            date: now.toISOString(),
            data: items,
            name: defaultName
        });

        saveAllRecords(all);
        alert(`已保存记录（${items.length} 个字段）`);
        if (activeTab === 'history') renderHistoryTab();
    }

    async function applyRecordAndReload(recordData) {
        if (!Array.isArray(recordData)) {
            alert('记录数据异常，无法加载。');
            return;
        }

        const pendingCookies = [];

        recordData.forEach(item => {
            if (!item || typeof item.key !== 'string') return;

            const itemType = String(item.type || '').toLowerCase();

            if (itemType === 'localstorage' || itemType === 'sessionstorage') {
                const storage = storageForType(item.type);
                if (!storage) return;
                try {
                    storage.setItem(item.key, item.value ?? '');
                } catch (e) {}
                return;
            }

            if (itemType === 'cookie') {
                pendingCookies.push(applyCookieItem(item));
            }
        });

        await Promise.all(pendingCookies);
        location.reload();
    }

    function deleteRecordById(recordId) {
        const all = ensureRecordIdsForHost(currentHostname);
        if (!Array.isArray(all[currentHostname])) return;

        const index = all[currentHostname].findIndex(record => record && record.id === recordId);
        if (index < 0) return;

        all[currentHostname].splice(index, 1);
        if (all[currentHostname].length === 0) delete all[currentHostname];

        saveAllRecords(all);
        renderHistoryTab();
    }

    function normalizeHost(value) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';

        // Accept either plain hostname or a full URL.
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
            try {
                return new URL(trimmed).hostname;
            } catch (e) {
                return '';
            }
        }

        return trimmed;
    }

    function isSafeHostKey(host) {
        return host !== '__proto__' && host !== 'prototype' && host !== 'constructor';
    }

    function ensureRecordIdsForAllHosts() {
        const all = getAllRecords();
        if (!all || typeof all !== 'object') return {};

        let changed = false;
        Object.keys(all).forEach(host => {
            if (!Array.isArray(all[host])) return;
            all[host].forEach(record => {
                if (!record || typeof record !== 'object') return;
                if (typeof record.id !== 'string' || record.id.trim() === '') {
                    record.id = generateRecordId();
                    changed = true;
                }
            });
        });

        if (changed) saveAllRecords(all);
        return all;
    }

    function sanitizeRecordForImport(record, strictData) {
        if (!record || typeof record !== 'object') return null;
        const data = record.data;
        if (!Array.isArray(data)) return null;

        const date = (typeof record.date === 'string' && record.date.trim()) ? record.date : new Date().toISOString();
        const id = (typeof record.id === 'string' && record.id.trim()) ? record.id : generateRecordId();

        const fallbackName = new Date(date).toLocaleString();
        const name = (typeof record.name === 'string' && record.name.trim()) ? record.name.trim() : fallbackName;

        return {
            id,
            date,
            data,
            name
        };
    }

    function exportAllRecordsText() {
        const all = ensureRecordIdsForAllHosts();
        return JSON.stringify({ schemaVersion: 1, records: all }, null, 2);
    }

    function exportHostRecordsText(host) {
        const normalizedHost = normalizeHost(host);
        if (!normalizedHost || !isSafeHostKey(normalizedHost)) return '';

        const all = ensureRecordIdsForHost(normalizedHost);
        const list = Array.isArray(all[normalizedHost]) ? all[normalizedHost] : [];
        return JSON.stringify({ schemaVersion: 1, records: { [normalizedHost]: list } }, null, 2);
    }

    function importAllRecordsFromText(text, mode) {
        const raw = typeof text === 'string' ? text.trim() : '';
        if (!raw) return { ok: false, message: '导入内容为空。' };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { ok: false, message: `JSON 解析失败：${e && e.message ? e.message : 'unknown error'}` };
        }

        const incomingRoot = (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') ? parsed.records : parsed;
        if (!incomingRoot || typeof incomingRoot !== 'object' || Array.isArray(incomingRoot)) {
            return { ok: false, message: '数据格式不正确，期望 { hostname: [records] } 或 { records: { ... } }。' };
        }

        const next = (mode === 'overwrite') ? Object.create(null) : getAllRecords();
        let added = 0;
        let updated = 0;
        let skipped = 0;

        Object.keys(incomingRoot).forEach(host => {
            const normalizedHost = normalizeHost(host);
            if (!normalizedHost || !isSafeHostKey(normalizedHost)) {
                skipped += 1;
                return;
            }

            const list = incomingRoot[host];
            if (!Array.isArray(list)) {
                skipped += 1;
                return;
            }

            if (!Array.isArray(next[normalizedHost])) next[normalizedHost] = [];
            const dest = next[normalizedHost];

            list.forEach(record => {
                const cleaned = sanitizeRecordForImport(record, true);
                if (!cleaned) {
                    skipped += 1;
                    return;
                }

                const idx = dest.findIndex(r => r && r.id === cleaned.id);
                if (idx >= 0) {
                    dest[idx] = cleaned;
                    updated += 1;
                } else {
                    dest.push(cleaned);
                    added += 1;
                }
            });
        });

        saveAllRecords(next);
        return { ok: true, message: `导入完成：新增 ${added} 条，更新 ${updated} 条，跳过 ${skipped} 项。` };
    }

    function exportSingleRecordText(host, record) {
        const normalizedHost = normalizeHost(host);
        const cleaned = sanitizeRecordForImport(record, true);
        if (!normalizedHost || !cleaned) return '';
        return JSON.stringify({ schemaVersion: 1, host: normalizedHost, record: cleaned }, null, 2);
    }

    function importSingleRecordFromText(text) {
        const raw = typeof text === 'string' ? text.trim() : '';
        if (!raw) return { ok: false, message: '导入内容为空。' };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { ok: false, message: `JSON 解析失败：${e && e.message ? e.message : 'unknown error'}` };
        }

        if (!parsed || typeof parsed !== 'object') return { ok: false, message: '数据格式不正确。' };

        const hostValue = parsed.host ?? parsed.hostname ?? parsed.url;
        const host = normalizeHost(typeof hostValue === 'string' ? hostValue : '');
        if (!host || !isSafeHostKey(host)) return { ok: false, message: '缺少有效 host/hostname/url，无法区分网址。' };

        const recordCandidate = (parsed.record && typeof parsed.record === 'object') ? parsed.record : parsed;
        const cleaned = sanitizeRecordForImport(recordCandidate, true);
        if (!cleaned) return { ok: false, message: '记录格式不正确（需要包含 data 数组）。' };

        const all = ensureRecordIdsForAllHosts();
        if (!Array.isArray(all[host])) all[host] = [];
        const dest = all[host];

        const idx = dest.findIndex(r => r && r.id === cleaned.id);
        if (idx >= 0) dest[idx] = cleaned;
        else dest.push(cleaned);

        saveAllRecords(all);
        return { ok: true, message: `已导入到 ${host}：${idx >= 0 ? '更新' : '新增'} 1 条记录。` };
    }

    function openTextWindow(titleText, initialText, filename) {
        const w = window.open('', '_blank', 'width=920,height=720');
        if (!w) {
            alert('浏览器阻止了弹窗，请允许此站点打开新窗口。');
            return null;
        }

        const safeTitle = String(titleText || 'Token 管理');
        const safeFilename = String(filename || 'token-data.json');

        w.document.open();
        w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(safeTitle)}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:16px;color:#000}
    h1{font-size:16px;margin:0 0 12px}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
    button{padding:8px 10px;border:0;border-radius:6px;cursor:pointer}
    .primary{background:#0066ff;color:#fff}
    .good{background:#00aa00;color:#fff}
    .warn{background:#ff8800;color:#fff}
    .danger{background:#ff4444;color:#fff}
    textarea{width:100%;min-height:520px;font-family:Consolas,monospace;font-size:12px;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
    .status{margin-top:8px;color:#333;font-size:12px;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1 id="title"></h1>
  <div class="row">
    <button id="copy" class="primary">复制</button>
    <button id="download" class="good">下载</button>
  </div>
  <textarea id="text" spellcheck="false"></textarea>
  <div id="status" class="status"></div>
</body>
</html>`);
        w.document.close();

        const titleEl = w.document.getElementById('title');
        const textEl = w.document.getElementById('text');
        const statusEl = w.document.getElementById('status');

        titleEl.textContent = safeTitle;
        textEl.value = typeof initialText === 'string' ? initialText : '';
        textEl.focus();
        textEl.select();

        function setStatus(msg) {
            statusEl.textContent = String(msg || '');
        }

        function downloadText(content) {
            const blob = new w.Blob([content], { type: 'application/json;charset=utf-8' });
            const url = w.URL.createObjectURL(blob);
            const a = w.document.createElement('a');
            a.href = url;
            a.download = safeFilename;
            w.document.body.appendChild(a);
            a.click();
            a.remove();
            w.URL.revokeObjectURL(url);
        }

        w.document.getElementById('copy').onclick = async () => {
            try {
                const value = textEl.value;
                if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
                    await w.navigator.clipboard.writeText(value);
                    setStatus('已复制到剪贴板。');
                } else {
                    textEl.focus();
                    textEl.select();
                    const ok = w.document.execCommand && w.document.execCommand('copy');
                    setStatus(ok ? '已复制到剪贴板。' : '复制失败，请手动 Ctrl+C。');
                }
            } catch (e) {
                setStatus('复制失败，请手动 Ctrl+C。');
            }
        };

        w.document.getElementById('download').onclick = () => {
            const value = textEl.value;
            if (!value.trim()) {
                setStatus('内容为空，无法下载。');
                return;
            }
            downloadText(value);
            setStatus(`已触发下载：${safeFilename}`);
        };

        return w;
    }

    function openManagerWindow(options) {
        const w = window.open('', '_blank', 'width=980,height=780');
        if (!w) {
            alert('浏览器阻止了弹窗，请允许此站点打开新窗口。');
            return null;
        }

        const focus = options && typeof options === 'object' ? options.focus : '';

        w.document.open();
        w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Token 管理器 - 导入/导出</title>
  <style>
    body{font-family:Arial,sans-serif;margin:16px;color:#000}
    h1{font-size:16px;margin:0 0 12px}
    h2{font-size:14px;margin:18px 0 8px}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
    button{padding:8px 10px;border:0;border-radius:6px;cursor:pointer}
    .primary{background:#0066ff;color:#fff}
    .good{background:#00aa00;color:#fff}
    .warn{background:#ff8800;color:#fff}
    .danger{background:#ff4444;color:#fff}
    textarea{width:100%;min-height:220px;font-family:Consolas,monospace;font-size:12px;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
    .status{margin-top:10px;color:#333;font-size:12px;white-space:pre-wrap}
    .hint{color:#333;font-size:12px;line-height:1.5}
  </style>
</head>
<body>
  <h1>Token 管理器 - 导入/导出</h1>

  <h2>全部数据（所有网址）</h2>
  <div class="hint">导出/导入的是 Tampermonkey 存储里的全部记录（按 hostname 区分）。</div>
  <div class="row">
    <button id="exportAll" class="primary">一键导出全部</button>
    <button id="copyAll" class="primary">复制</button>
    <button id="downloadAll" class="good">下载</button>
    <button id="importMerge" class="warn">合并导入</button>
    <button id="importOverwrite" class="danger">覆盖导入</button>
  </div>
  <textarea id="allText" spellcheck="false" placeholder="导出后会出现在这里；也可以把备份 JSON 粘贴到这里再导入。"></textarea>

  <h2>单条记录（区分网址）</h2>
  <div class="hint">格式示例：{ "host": "example.com", "record": { ... } }。导入后会写入对应 host 的历史记录。</div>
  <div class="row">
    <button id="importSingle" class="warn">导入单条</button>
  </div>
  <textarea id="singleText" spellcheck="false" placeholder="把单条记录 JSON 粘贴到这里，然后点“导入单条”。"></textarea>

  <div id="status" class="status"></div>
</body>
</html>`);
        w.document.close();

        const statusEl = w.document.getElementById('status');
        const allText = w.document.getElementById('allText');
        const singleText = w.document.getElementById('singleText');

        function setStatus(msg) {
            statusEl.textContent = String(msg || '');
        }

        function downloadText(filename, content) {
            const blob = new w.Blob([content], { type: 'application/json;charset=utf-8' });
            const url = w.URL.createObjectURL(blob);
            const a = w.document.createElement('a');
            a.href = url;
            a.download = filename;
            w.document.body.appendChild(a);
            a.click();
            a.remove();
            w.URL.revokeObjectURL(url);
        }

        async function copyText(value) {
            if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
                await w.navigator.clipboard.writeText(value);
                return true;
            }

            allText.focus();
            allText.select();
            return !!(w.document.execCommand && w.document.execCommand('copy'));
        }

        w.document.getElementById('exportAll').onclick = () => {
            const text = exportAllRecordsText();
            allText.value = text;
            allText.focus();
            allText.select();
            setStatus('已生成导出数据。');
        };

        w.document.getElementById('copyAll').onclick = async () => {
            try {
                const ok = await copyText(allText.value);
                setStatus(ok ? '已复制到剪贴板。' : '复制失败，请手动 Ctrl+C。');
            } catch (e) {
                setStatus('复制失败，请手动 Ctrl+C。');
            }
        };

        w.document.getElementById('downloadAll').onclick = () => {
            const value = allText.value;
            if (!value.trim()) {
                setStatus('内容为空，无法下载。');
                return;
            }

            const filename = `token-records-all-${new Date().toISOString().slice(0, 10)}.json`;
            downloadText(filename, value);
            setStatus(`已触发下载：${filename}`);
        };

        w.document.getElementById('importMerge').onclick = () => {
            const result = importAllRecordsFromText(allText.value, 'merge');
            setStatus(result.message);
        };

        w.document.getElementById('importOverwrite').onclick = () => {
            const ok = w.confirm('确认覆盖导入？当前所有已保存数据将被替换。');
            if (!ok) return;
            const result = importAllRecordsFromText(allText.value, 'overwrite');
            setStatus(result.message);
        };

        w.document.getElementById('importSingle').onclick = () => {
            const result = importSingleRecordFromText(singleText.value);
            setStatus(result.message);
        };

        setStatus('提示：导入后，回到原页面打开“历史记录”即可看到更新（必要时刷新页面）。');
        if (focus === 'single') singleText.focus();
        else allText.focus();
        return w;
    }

    function importSmartFromText(text, mode) {
        const raw = typeof text === 'string' ? text.trim() : '';
        if (!raw) return { ok: false, message: '导入内容为空。' };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { ok: false, message: `JSON 解析失败：${e && e.message ? e.message : 'unknown error'}` };
        }

        // Array: treat as multiple single-record payloads: [{host,record}, ...]
        if (Array.isArray(parsed)) {
            let okCount = 0;
            let failCount = 0;
            parsed.forEach(item => {
                const res = importSingleRecordFromText(JSON.stringify(item));
                if (res && res.ok) okCount += 1;
                else failCount += 1;
            });
            return {
                ok: okCount > 0,
                message: `导入完成：成功 ${okCount} 条，失败 ${failCount} 条。`
            };
        }

        // Object with host + record/data: single record payload.
        if (parsed && typeof parsed === 'object') {
            const hostValue = parsed.host ?? parsed.hostname ?? parsed.url;
            const hasHost = typeof hostValue === 'string' && normalizeHost(hostValue);
            const hasRecordShape = !!(parsed.record && typeof parsed.record === 'object') || Array.isArray(parsed.data);
            if (hasHost && hasRecordShape) {
                return importSingleRecordFromText(raw);
            }
        }

        // Fallback: treat as "all records" payload.
        return importAllRecordsFromText(raw, mode === 'overwrite' ? 'overwrite' : 'merge');
    }

    function openSmartImportWindow() {
        const w = window.open('', '_blank', 'width=980,height=720');
        if (!w) {
            alert('浏览器阻止了弹窗，请允许此站点打开新窗口。');
            return null;
        }

        w.document.open();
        w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Token 管理器 - 导入记录</title>
  <style>
    body{font-family:Arial,sans-serif;margin:16px;color:#000}
    h1{font-size:16px;margin:0 0 12px}
    .hint{color:#333;font-size:12px;line-height:1.5;margin-bottom:10px}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
    button{padding:8px 10px;border:0;border-radius:6px;cursor:pointer}
    .warn{background:#ff8800;color:#fff}
    .danger{background:#ff4444;color:#fff}
    textarea{width:100%;min-height:520px;font-family:Consolas,monospace;font-size:12px;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
    .status{margin-top:10px;color:#333;font-size:12px;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1>导入记录</h1>
  <div class="hint">支持：单条（{ host, record }）、多条（[{ host, record }, ...]）、以及全量（{ records: { host: [...] } } 或 { host: [...] }）。</div>
  <div class="row">
    <button id="importMerge" class="warn">合并导入</button>
    <button id="importOverwrite" class="danger">覆盖导入</button>
  </div>
  <textarea id="text" spellcheck="false" placeholder="把 JSON 粘贴到这里，然后点击导入。"></textarea>
  <div id="status" class="status"></div>
</body>
</html>`);
        w.document.close();

        const textEl = w.document.getElementById('text');
        const statusEl = w.document.getElementById('status');

        function setStatus(msg) {
            statusEl.textContent = String(msg || '');
        }

        w.document.getElementById('importMerge').onclick = () => {
            const res = importSmartFromText(textEl.value, 'merge');
            setStatus(res.message);
        };

        w.document.getElementById('importOverwrite').onclick = () => {
            const ok = w.confirm('确认覆盖导入？仅对“全量数据”生效；单条/多条导入将按记录 id 追加或更新。');
            if (!ok) return;
            const res = importSmartFromText(textEl.value, 'overwrite');
            setStatus(res.message);
        };

        textEl.focus();
        return w;
    }

    // 获取当前页面可保存的全部数据：localStorage + sessionStorage + Cookie（含子域与属性）
    async function getTokenItems() {
        const items = [];

        // localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                items.push({
                    type: 'localStorage',
                    key,
                    value: localStorage.getItem(key) ?? ''
                });
            }
        } catch (e) {}

        // sessionStorage
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (!key) continue;
                items.push({
                    type: 'sessionStorage',
                    key,
                    value: sessionStorage.getItem(key) ?? ''
                });
            }
        } catch (e) {}

        // Cookies（按域扫描当前域名及其子域，保留 domain / path / expires / httpOnly 等属性）
        const cookieItems = await collectCookieItemsForCurrentSite();
        return items.concat(cookieItems);
    }

    // 批量应用编辑并刷新
    async function applyAllAndReload() {
        const blocks = currentContent.querySelectorAll('.token-block');
        const pendingCookies = [];
        let hasChange = false;

        blocks.forEach(block => {
            const item = currentItems[Number(block.dataset.uid)];
            const textarea = block.querySelector('textarea');
            if (!item || !textarea) return;

            const newValue = textarea.value;
            const itemType = String(item.type || '').toLowerCase();

            if (itemType === 'localstorage' || itemType === 'sessionstorage') {
                const storage = storageForType(item.type);
                if (!storage) return;
                try {
                    const oldValue = storage.getItem(item.key) ?? '';
                    if (newValue === '' && oldValue !== '') {
                        storage.removeItem(item.key);
                        hasChange = true;
                    } else if (newValue !== oldValue) {
                        storage.setItem(item.key, newValue);
                        hasChange = true;
                    }
                } catch (e) {}
                return;
            }

            if (itemType === 'cookie') {
                if (newValue === (item.value ?? '')) return;
                hasChange = true;
                if (newValue === '') {
                    pendingCookies.push(applyCookieItem(item, { remove: true }));
                } else {
                    pendingCookies.push(applyCookieItem(item, { value: newValue }));
                }
            }
        });

        await Promise.all(pendingCookies);

        if (hasChange) {
            location.reload();
        } else {
            alert('没有检测到更改。');
        }
    }

    // UI 创建
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = 'Token管理';
    toggleBtn.style.position = 'fixed';
    toggleBtn.style.bottom = '20px';
    toggleBtn.style.right = '20px';
    toggleBtn.style.zIndex = '10000';
    toggleBtn.style.padding = '10px 14px';
    toggleBtn.style.background = '#0066ff';
    toggleBtn.style.color = 'white';
    toggleBtn.style.border = 'none';
    toggleBtn.style.borderRadius = '6px';
    toggleBtn.style.cursor = 'pointer';
    toggleBtn.style.boxShadow = '0 3px 8px rgba(0,0,0,0.2)';
    toggleBtn.style.fontSize = '13px';
    document.body.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.style.display = 'none';
    panel.style.position = 'fixed';
    panel.style.top = '50px';
    panel.style.right = '20px';
    panel.style.width = '520px';
    panel.style.maxHeight = '85vh';
    panel.style.overflowY = 'auto';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #ccc';
    panel.style.borderRadius = '8px';
    panel.style.padding = '12px';
    panel.style.zIndex = '9999';
    panel.style.boxShadow = '0 6px 16px rgba(0,0,0,0.25)';
    panel.style.fontFamily = 'Arial, sans-serif';
    panel.style.fontSize = '14px';

    // 标题栏
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '12px';
    header.style.paddingBottom = '8px';
    header.style.borderBottom = '1px solid #eee';

    const title = document.createElement('h3');
    title.textContent = 'Token 管理器';
    title.style.margin = '0';
    title.style.fontSize = '16px';
    title.style.color = '#0066ff';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.padding = '4px 10px';
    closeBtn.style.background = '#ff4444';
    closeBtn.style.color = 'white';
    closeBtn.style.border = 'none';
    closeBtn.style.borderRadius = '4px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '14px';

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Tab 切换栏
    const tabBar = document.createElement('div');
    tabBar.style.display = 'flex';
    tabBar.style.marginBottom = '12px';
    tabBar.style.borderBottom = '1px solid #ddd';

    const currentTabBtn = document.createElement('button');
    currentTabBtn.textContent = '当前编辑';
    currentTabBtn.style.flex = '1';
    currentTabBtn.style.padding = '8px';
    currentTabBtn.style.background = '#0066ff';
    currentTabBtn.style.color = 'white';
    currentTabBtn.style.border = 'none';
    currentTabBtn.style.borderRadius = '4px 4px 0 0';
    currentTabBtn.style.cursor = 'pointer';

    const historyTabBtn = document.createElement('button');
    historyTabBtn.textContent = '历史记录';
    historyTabBtn.style.flex = '1';
    historyTabBtn.style.padding = '8px';
    historyTabBtn.style.background = '#f0f0f0';
    historyTabBtn.style.color = '#333';
    historyTabBtn.style.border = 'none';
    historyTabBtn.style.borderRadius = '4px 4px 0 0';
    historyTabBtn.style.cursor = 'pointer';

    tabBar.appendChild(currentTabBtn);
    tabBar.appendChild(historyTabBtn);

    const manageTabBtn = document.createElement('button');
    manageTabBtn.textContent = '导入/导出';
    manageTabBtn.style.flex = '1';
    manageTabBtn.style.padding = '8px';
    manageTabBtn.style.background = '#f0f0f0';
    manageTabBtn.style.color = '#333';
    manageTabBtn.style.border = 'none';
    manageTabBtn.style.borderRadius = '4px 4px 0 0';
    manageTabBtn.style.cursor = 'pointer';

    tabBar.appendChild(manageTabBtn);
    panel.appendChild(tabBar);

    // 内容容器
    const contentArea = document.createElement('div');
    panel.appendChild(contentArea);

    const currentContent = document.createElement('div');
    const historyContent = document.createElement('div');
    historyContent.style.display = 'none';
    const manageContent = document.createElement('div');
    manageContent.style.display = 'none';

    contentArea.appendChild(currentContent);
    contentArea.appendChild(historyContent);
    contentArea.appendChild(manageContent);

    // 当前编辑 Tab 内容
    const currentBtns = document.createElement('div');
    currentBtns.style.display = 'flex';
    currentBtns.style.gap = '8px';
    currentBtns.style.marginBottom = '16px';

    const saveCurrentBtn = document.createElement('button');
    saveCurrentBtn.textContent = '保存当前记录';
    saveCurrentBtn.style.flex = '1';
    saveCurrentBtn.style.padding = '8px';
    saveCurrentBtn.style.background = '#ff8800';
    saveCurrentBtn.style.color = 'white';
    saveCurrentBtn.style.border = 'none';
    saveCurrentBtn.style.borderRadius = '4px';
    saveCurrentBtn.style.cursor = 'pointer';
    saveCurrentBtn.onclick = () => {
        saveCurrentRecord();
    };

    const applyBtn = document.createElement('button');
    applyBtn.textContent = '保存更改并刷新';
    applyBtn.style.flex = '1';
    applyBtn.style.padding = '8px';
    applyBtn.style.background = '#00aa00';
    applyBtn.style.color = 'white';
    applyBtn.style.border = 'none';
    applyBtn.style.borderRadius = '4px';
    applyBtn.style.cursor = 'pointer';
    applyBtn.onclick = applyAllAndReload;

    currentBtns.appendChild(saveCurrentBtn);
    currentBtns.appendChild(applyBtn);
    currentContent.appendChild(currentBtns);

    const currentList = document.createElement('div');
    currentContent.appendChild(currentList);

    // 渲染当前编辑 Tab 时的数据快照（供“保存更改并刷新”按键按 uid 定位）
    let currentItems = [];

    // 渲染当前编辑 Tab
    async function renderCurrentTab() {
        currentList.innerHTML = '';
        const items = await getTokenItems();
        currentItems = items;
        // Prefer items whose key contains "token" (case-insensitive).
        items.sort((a, b) => {
            const aKey = (a && typeof a.key === 'string') ? a.key : '';
            const bKey = (b && typeof b.key === 'string') ? b.key : '';
            const aHasToken = aKey.toLowerCase().includes('token') ? 1 : 0;
            const bHasToken = bKey.toLowerCase().includes('token') ? 1 : 0;
            if (aHasToken !== bHasToken) return bHasToken - aHasToken;

            const aType = (a && typeof a.type === 'string') ? a.type : '';
            const bType = (b && typeof b.type === 'string') ? b.type : '';
            if (aType !== bType) return aType.localeCompare(bType);

            const byKey = aKey.toLowerCase().localeCompare(bKey.toLowerCase());
            if (byKey !== 0) return byKey;

            const aDomain = (a && typeof a.domain === 'string') ? a.domain : '';
            const bDomain = (b && typeof b.domain === 'string') ? b.domain : '';
            return aDomain.localeCompare(bDomain);
        });

        if (items.length === 0) {
            currentList.innerHTML = '<p style="color:#888;text-align:center;padding:30px;">未找到可保存的数据（localStorage / sessionStorage / Cookie）</p>';
            applyBtn.disabled = true;
            applyBtn.style.opacity = '0.6';
            return;
        }

        applyBtn.disabled = false;
        applyBtn.style.opacity = '1';

        items.forEach((item, index) => {
            const block = document.createElement('div');
            block.className = 'token-block';
            block.dataset.type = item.type;
            block.dataset.key = item.key;
            block.dataset.uid = String(index);
            block.style.marginBottom = '16px';
            block.style.padding = '12px';
            block.style.background = '#f9f9f9';
            block.style.borderRadius = '6px';
            block.style.border = '1px solid #eee';

            const info = document.createElement('div');
            info.style.marginBottom = '8px';
            info.style.fontSize = '13px';
            info.style.color = '#000';

            let infoHTML = `<strong>类型：</strong><span style="color:#000;">${escapeHtml(item.type)}</span>　<strong>键名：</strong><span style="color:#000;font-weight:bold;">${escapeHtml(item.key)}</span>`;
            if (String(item.type).toLowerCase() === 'cookie') {
                const attrBits = [];
                if (item.domain) attrBits.push(`域：${item.domain}`);
                if (item.path && item.path !== '/') attrBits.push(`路径：${item.path}`);
                if (item.httpOnly) attrBits.push('HttpOnly');
                if (item.secure) attrBits.push('Secure');
                if (attrBits.length) {
                    infoHTML += `<div style="font-size:12px;color:#333;margin-top:4px;">${escapeHtml(attrBits.join('　'))}</div>`;
                }
            }
            info.innerHTML = infoHTML;
            block.appendChild(info);

            const textarea = document.createElement('textarea');
            textarea.value = item.value;
            textarea.style.width = '100%';
            textarea.style.minHeight = '90px';
            textarea.style.padding = '8px';
            textarea.style.border = '1px solid #ddd';
            textarea.style.borderRadius = '4px';
            textarea.style.fontFamily = 'monospace';
            textarea.style.fontSize = '12px';
            textarea.style.resize = 'vertical';
            applyReadableFieldStyles(textarea);
            block.appendChild(textarea);

            currentList.appendChild(block);
        });
    }

    // 导入/导出 Tab 内容
    const manageHeader = document.createElement('div');
    manageHeader.style.marginBottom = '12px';
    manageHeader.style.color = '#000';
    manageHeader.innerHTML = '<div style="font-weight:bold;">导入/导出</div><div style="font-size:12px;color:#333;line-height:1.5;margin-top:6px;">支持一键导出/导入全部数据（所有网址），以及导入单条记录（按 host 区分网址）。</div>';
    manageContent.appendChild(manageHeader);

    const manageBtns = document.createElement('div');
    manageBtns.style.display = 'flex';
    manageBtns.style.gap = '8px';
    manageBtns.style.marginBottom = '12px';

    const openManagerBtn = document.createElement('button');
    openManagerBtn.textContent = '打开管理页（弹窗）';
    openManagerBtn.style.flex = '1';
    openManagerBtn.style.padding = '10px';
    openManagerBtn.style.background = '#0066ff';
    openManagerBtn.style.color = 'white';
    openManagerBtn.style.border = 'none';
    openManagerBtn.style.borderRadius = '6px';
    openManagerBtn.style.cursor = 'pointer';
    openManagerBtn.onclick = () => openManagerWindow({ focus: 'all' });

    const exportAllQuickBtn = document.createElement('button');
    exportAllQuickBtn.textContent = '一键导出全部';
    exportAllQuickBtn.style.flex = '1';
    exportAllQuickBtn.style.padding = '10px';
    exportAllQuickBtn.style.background = '#00aa00';
    exportAllQuickBtn.style.color = 'white';
    exportAllQuickBtn.style.border = 'none';
    exportAllQuickBtn.style.borderRadius = '6px';
    exportAllQuickBtn.style.cursor = 'pointer';
    exportAllQuickBtn.onclick = () => {
        const text = exportAllRecordsText();
        const filename = `token-records-all-${new Date().toISOString().slice(0, 10)}.json`;
        openTextWindow('全部数据导出（所有网址）', text, filename);
    };

    manageBtns.appendChild(openManagerBtn);
    manageBtns.appendChild(exportAllQuickBtn);
    manageContent.appendChild(manageBtns);

    // 历史 Tab 内容
    const historyHeader = document.createElement('div');
    historyHeader.style.marginBottom = '12px';

    const histTitle = document.createElement('div');
    histTitle.style.fontWeight = 'bold';
    histTitle.style.color = '#000';
    historyHeader.appendChild(histTitle);

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = '输入名称筛选（支持部分匹配）';
    filterInput.style.width = '100%';
    filterInput.style.padding = '8px';
    filterInput.style.marginTop = '8px';
    filterInput.style.border = '1px solid #ccc';
    filterInput.style.borderRadius = '4px';
    filterInput.style.fontSize = '13px';
    applyReadableFieldStyles(filterInput);
    historyHeader.appendChild(filterInput);

    const historyTools = document.createElement('div');
    historyTools.style.display = 'flex';
    historyTools.style.gap = '8px';
    historyTools.style.marginTop = '10px';

    const importRecordsBtn = document.createElement('button');
    importRecordsBtn.textContent = '导入记录';
    importRecordsBtn.style.flex = '1';
    importRecordsBtn.style.padding = '8px';
    importRecordsBtn.style.background = '#ff8800';
    importRecordsBtn.style.color = 'white';
    importRecordsBtn.style.border = 'none';
    importRecordsBtn.style.borderRadius = '4px';
    importRecordsBtn.style.cursor = 'pointer';
    importRecordsBtn.onclick = () => openSmartImportWindow();

    const exportRecordsBtn = document.createElement('button');
    exportRecordsBtn.textContent = '导出记录';
    exportRecordsBtn.style.flex = '1';
    exportRecordsBtn.style.padding = '8px';
    exportRecordsBtn.style.background = '#0066ff';
    exportRecordsBtn.style.color = 'white';
    exportRecordsBtn.style.border = 'none';
    exportRecordsBtn.style.borderRadius = '4px';
    exportRecordsBtn.style.cursor = 'pointer';
    exportRecordsBtn.onclick = () => {
        const text = exportHostRecordsText(currentHostname);
        if (!text) {
            alert('当前网址导出失败（host 异常）。');
            return;
        }

        const safeHost = normalizeHost(currentHostname) || 'unknown-host';
        const filename = `token-records-${safeHost}-${new Date().toISOString().slice(0, 10)}.json`;
        openTextWindow(`导出记录 - ${safeHost}`, text, filename);
    };

    historyTools.appendChild(importRecordsBtn);
    historyTools.appendChild(exportRecordsBtn);
    historyHeader.appendChild(historyTools);

    historyContent.appendChild(historyHeader);

    const historyList = document.createElement('div');
    historyContent.appendChild(historyList);

    // 渲染历史 Tab
    function renderHistoryTab() {
        const allRecords = getRecordsForHost(currentHostname);
        histTitle.textContent = `历史记录 - ${currentHostname} (${allRecords.length} 条)`;

        const filterValue = filterInput.value.trim().toLowerCase();
        let records = allRecords;

        if (filterValue) {
            records = allRecords.filter(record => getDisplayName(record).toLowerCase().includes(filterValue));
        }

        historyList.innerHTML = '';

        if (records.length === 0) {
            const msg = filterValue ? '无匹配名称的记录' : '暂无保存的记录';
            historyList.innerHTML = `<p style="color:#888;text-align:center;padding:20px;">${msg}</p>`;
            return;
        }

        records.forEach(record => {
            const dateStr = new Date(record.date).toLocaleString();
            const displayName = getDisplayName(record);
            const recordId = record.id;

            const block = document.createElement('div');
            block.style.marginBottom = '12px';
            block.style.padding = '10px';
            block.style.background = '#f5f5ff';
            block.style.borderRadius = '6px';
            block.style.border = '1px solid #ddd';

            const info = document.createElement('div');
            info.style.marginBottom = '10px';
            info.style.fontSize = '13px';
            info.style.color = '#000';

            const nameRow = document.createElement('div');
            nameRow.style.display = 'flex';
            nameRow.style.alignItems = 'center';
            nameRow.style.gap = '8px';
            nameRow.style.marginBottom = '8px';

            const nameLabel = document.createElement('strong');
            nameLabel.textContent = '名称：';
            nameLabel.style.whiteSpace = 'nowrap';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = displayName;
            nameInput.style.flex = '1';
            nameInput.style.padding = '6px 8px';
            nameInput.style.border = '1px solid #ccc';
            nameInput.style.borderRadius = '4px';
            nameInput.style.fontSize = '13px';
            applyReadableFieldStyles(nameInput);

            const saveNameBtn = document.createElement('button');
            saveNameBtn.textContent = '保存';
            saveNameBtn.style.padding = '6px 10px';
            saveNameBtn.style.background = '#0066ff';
            saveNameBtn.style.color = 'white';
            saveNameBtn.style.border = 'none';
            saveNameBtn.style.borderRadius = '4px';
            saveNameBtn.style.cursor = 'pointer';
            saveNameBtn.onclick = () => {
                updateRecordNameById(recordId, nameInput.value);
                renderHistoryTab();
            };

            nameInput.onkeydown = e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveNameBtn.click();
                }
            };

            nameRow.appendChild(nameLabel);
            nameRow.appendChild(nameInput);
            nameRow.appendChild(saveNameBtn);
            info.appendChild(nameRow);

            const meta = document.createElement('div');
            const safeDataCount = Array.isArray(record.data) ? record.data.length : 0;
            let infoHTML = '';
            infoHTML += `<strong>时间：</strong><span style="color:#000;">${escapeHtml(dateStr)}</span><br>`;
            infoHTML += `<strong>字段数：</strong><span style="color:#000;">${safeDataCount}</span>`;
            meta.innerHTML = infoHTML;
            info.appendChild(meta);
            block.appendChild(info);

            const btns = document.createElement('div');
            btns.style.display = 'flex';
            btns.style.gap = '8px';

            const loadBtn = document.createElement('button');
            loadBtn.textContent = '加载并刷新';
            loadBtn.style.flex = '1';
            loadBtn.style.padding = '8px';
            loadBtn.style.background = '#00aa00';
            loadBtn.style.color = 'white';
            loadBtn.style.border = 'none';
            loadBtn.style.borderRadius = '4px';
            loadBtn.style.cursor = 'pointer';
            loadBtn.onclick = () => confirm(`确认加载 "${displayName}" 的记录？`) && applyRecordAndReload(record.data);

            const exportBtn = document.createElement('button');
            exportBtn.textContent = '导出';
            exportBtn.style.flex = '1';
            exportBtn.style.padding = '8px';
            exportBtn.style.background = '#0066ff';
            exportBtn.style.color = 'white';
            exportBtn.style.border = 'none';
            exportBtn.style.borderRadius = '4px';
            exportBtn.style.cursor = 'pointer';
            exportBtn.onclick = () => {
                const text = exportSingleRecordText(currentHostname, record);
                if (!text) {
                    alert('记录数据异常，无法导出。');
                    return;
                }

                const safeHost = normalizeHost(currentHostname) || 'unknown-host';
                const filename = `token-record-${safeHost}-${recordId}.json`;
                openTextWindow(`单条记录导出 - ${displayName}`, text, filename);
            };

            const delBtn = document.createElement('button');
            delBtn.textContent = '删除';
            delBtn.style.flex = '1';
            delBtn.style.padding = '8px';
            delBtn.style.background = '#ff4444';
            delBtn.style.color = 'white';
            delBtn.style.border = 'none';
            delBtn.style.borderRadius = '4px';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = () => confirm(`确认删除 "${displayName}" 的记录？`) && deleteRecordById(recordId);

            btns.appendChild(loadBtn);
            btns.appendChild(exportBtn);
            btns.appendChild(delBtn);
            block.appendChild(btns);
            historyList.appendChild(block);
        });
    }

    // 名称筛选实时更新
    filterInput.oninput = renderHistoryTab;

    // Tab 切换逻辑
    let activeTab = 'current';

    function switchToCurrent() {
        activeTab = 'current';
        currentTabBtn.style.background = '#0066ff';
        currentTabBtn.style.color = 'white';
        historyTabBtn.style.background = '#f0f0f0';
        historyTabBtn.style.color = '#333';
        manageTabBtn.style.background = '#f0f0f0';
        manageTabBtn.style.color = '#333';
        currentContent.style.display = 'block';
        historyContent.style.display = 'none';
        manageContent.style.display = 'none';
        renderCurrentTab();
    }

    function switchToHistory() {
        activeTab = 'history';
        currentTabBtn.style.background = '#f0f0f0';
        currentTabBtn.style.color = '#333';
        historyTabBtn.style.background = '#0066ff';
        historyTabBtn.style.color = 'white';
        manageTabBtn.style.background = '#f0f0f0';
        manageTabBtn.style.color = '#333';
        currentContent.style.display = 'none';
        historyContent.style.display = 'block';
        manageContent.style.display = 'none';
        renderHistoryTab();
    }

    function switchToManage() {
        activeTab = 'manage';
        currentTabBtn.style.background = '#f0f0f0';
        currentTabBtn.style.color = '#333';
        historyTabBtn.style.background = '#f0f0f0';
        historyTabBtn.style.color = '#333';
        manageTabBtn.style.background = '#0066ff';
        manageTabBtn.style.color = 'white';
        currentContent.style.display = 'none';
        historyContent.style.display = 'none';
        manageContent.style.display = 'block';
    }

    currentTabBtn.onclick = switchToCurrent;
    historyTabBtn.onclick = switchToHistory;
    manageTabBtn.onclick = switchToManage;

    // 面板开关
    toggleBtn.onclick = () => {
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            document.body.appendChild(panel);
            switchToCurrent();
        } else {
            panel.style.display = 'none';
        }
    };

    closeBtn.onclick = () => {
        panel.style.display = 'none';
    };
})();

