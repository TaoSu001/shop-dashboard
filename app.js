// 达人与视频看板 · 飞书多维表格插件(侧边栏扩展脚本 / 仪表盘插件 两用)
// 用飞书官方 Base JS SDK 读当前多维表格(读的是打开表格的人自己的权限,不需要 App Secret)
// SDK 文件放在仓库里一起发布(不依赖国外 CDN,国内打开更快)
import { bitable } from './vendor/js-sdk/index.mjs';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Math.round(n || 0).toLocaleString('en-US');
const fmtMoney = n => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney0 = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const fmtCompact = n => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : fmtInt(n); };
const fmtPct = n => isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const LS = 'shop_dash_v1';
// 飞书 SDK 的调用都加超时:宿主没响应时报错提示,而不是一直转圈
const withTimeout = (p, ms, what) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(what + '超时(' + ms / 1000 + ' 秒没有响应)')), ms))]);
function fatal(text) { const m = document.getElementById('msg'); if (m) { m.hidden = false; m.className = 'msg err'; m.textContent = text; } }
window.addEventListener('error', e => fatal('看板出错:' + (e.message || e) + '。请按 Ctrl+F5 强制刷新;仍然不行请截图发给管理员。'));
window.addEventListener('unhandledrejection', e => fatal('看板出错:' + ((e.reason && e.reason.message) || e.reason) + '。请按 Ctrl+F5 强制刷新;仍然不行请截图发给管理员。'));
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } };
const save = p => { try { localStorage.setItem(LS, JSON.stringify(Object.assign(load(), p))); } catch (e) {} };

/* ======================== 日期 ======================== */
// 表格里的日期 = 店铺当地时间按 GMT+8 存(和导出插件一致),+8 小时就是导出里的「墙上时间」
const wallOf = ms => new Date(ms + 8 * 3600e3);
const dayOf = ms => (typeof ms === 'number' && ms > 0) ? wallOf(ms).toISOString().slice(0, 10) : '';
const shift = (s, d) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) + 1;
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const md = s => s.slice(5).replace('-', '/');
function periodOf(p, custom) {
    const t = todayLocal();
    const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 周一 = 0
    const mon = shift(t, -dow);
    if (p === 'lastweek') return [shift(mon, -7), shift(mon, -1)];
    if (p === 'thisweek') return [mon, t];
    if (p === '7') return [shift(t, -7), shift(t, -1)];
    if (p === '28') return [shift(t, -28), shift(t, -1)];
    if (p === 'lastmonth') { const e = shift(t.slice(0, 8) + '01', -1); return [e.slice(0, 8) + '01', e]; }
    if (p === 'custom' && custom && custom[0] && custom[1] && custom[0] <= custom[1]) return custom;
    return periodOf('lastweek');
}
const prevOf = ([a, b]) => { const n = days(a, b); return [shift(a, -n), shift(a, -1)]; };
const dayList = ([a, b]) => { const out = []; for (let d = a; d <= b; d = shift(d, 1)) out.push(d); return out; };

/* ======================== 读表 ======================== */
const cellText = v => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(x => x == null ? '' : (typeof x === 'object' ? (x.text ?? x.name ?? '') : String(x))).join('');
    if (typeof v === 'object') return String(v.text ?? v.name ?? '');
    return String(v);
};
const cellNum = v => {
    if (typeof v === 'number') return v;
    const n = parseFloat(cellText(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
};
/* ======================== 数据仓库(GitHub,AES-256-GCM 加密) ======================== */
// 所有数据由「TikTok 导出助手」加密写入 GitHub;看板在浏览器里用团队密码解密,不经过任何服务器
const DATA_BASE = new URL(window.__DATA_BASE || 'https://taosu001.github.io/shop-data/', location.href).href;   // 统一成完整网址(缓存比对要用)
const PW_KEY = 'shop_data_pw';
let dataManifest = null, dataKey = null;
const b64u8 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
async function loadManifest(force) {
    if (!dataManifest || force) {
        // 加时间参数绕过 GitHub Pages 的 CDN 缓存(manifest 很小)
        const r = await withTimeout(fetch(DATA_BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store' }), 30000, '读取数据目录');
        if (!r.ok) throw new Error('数据目录 HTTP ' + r.status);
        dataManifest = await r.json();
        dataManifest.sets = dataManifest.sets || {};
    }
    return dataManifest;
}
// 用密码推导密钥,并用 manifest 里的校验块确认密码正确(密码不对会抛 OperationError)
async function deriveKey(pw) {
    const m = await loadManifest();
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64u8(m.kdf.salt), iterations: m.kdf.iter }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const c = b64u8(m.check);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, key, c.slice(12));
    return key;
}
async function getKey() {
    if (dataKey) return dataKey;
    const pw = lsGet(PW_KEY);
    if (!pw) return null;
    try { return (dataKey = await deriveKey(pw)); }
    catch (e) { if (e && e.name === 'OperationError') { lsSet(PW_KEY, null); return null; } throw e; }
}
// 文件 JSON {v:2, cols, types, strs, rows}:文字列存的是字符串表下标
function unpack(o) {
    if (o.v !== 2) return { cols: o.cols, rows: o.rows };
    return { cols: o.cols, rows: o.rows.map(r => r.map((v, i) => o.types[i] === 's' ? (v < 0 ? null : o.strs[v]) : v)) };
}
// 文件按指纹(h)缓存:下载过的文件存在浏览器里,内容变了指纹就变,自动重新下载
const fileCache = new Map();
function fetchFile(path, h, label) {
    const url = `${DATA_BASE}${path}?h=${h || ''}`;
    if (fileCache.has(url)) return fileCache.get(url);
    const p = (async () => {
        let buf = null, cache = null;
        try { cache = await caches.open('shop-data-v2'); const hit = await cache.match(url); if (hit) buf = await hit.arrayBuffer(); } catch (e) {}
        if (!buf) {
            reading.set(label || path, { n: 0, total: 1 }); showReading();
            const r = await withTimeout(fetch(url), 180000, `下载 ${label || path}`);
            if (!r.ok) throw new Error(`${label || path}:HTTP ${r.status}`);
            buf = await r.arrayBuffer();
            try { if (cache) await cache.put(url, new Response(buf.slice(0))); } catch (e) {}
            reading.set(label || path, { n: 1, total: 1 }); showReading();
        }
        const u = new Uint8Array(buf);
        const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, dataKey, u.slice(12));
        return unpack(JSON.parse(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text()));
    })();
    fileCache.set(url, p);
    p.catch(() => fileCache.delete(url));
    return p;
}
const monthsBetween = (a, b) => { const out = []; for (let m = a.slice(0, 7); m <= b.slice(0, 7); m = shift(m + '-01', 32).slice(0, 7)) out.push(m); return out; };
const SET_LABEL = { orders: '订单', videos: '视频', vday: '视频逐日', gmvsum: 'GMV Max 汇总', gmvdet: 'GMV Max 明细' };
const setShops = set => Object.keys((dataManifest && dataManifest.sets[set]) || {});
// 读某类数据:指定店铺、月份范围(from/to 为日期,null = 全部月份)→ 行对象数组
// 列名带币种的(如 "Video GMV ($)")同时提供去掉括号的别名,统计代码按别名取值
async function readSet(set, shops, from, to) {
    const jobs = [];
    for (const s of shops) {
        const months = (dataManifest.sets[set] || {})[s] || {};
        const want = from ? new Set(monthsBetween(from, to)) : null;
        for (const [m, meta] of Object.entries(months)) if (!want || want.has(m)) jobs.push(fetchFile(`${set}/${s}/${m}.bin`, meta.h, `${SET_LABEL[set] || set} ${m}`));
    }
    const out = [];
    for (const t of await Promise.all(jobs)) {
        const alias = t.cols.map(c => { const b = c.replace(/\s*\([^)]*\)\s*$/, ''); return b !== c ? b : null; });
        for (const r of t.rows) {
            const o = {};
            for (let i = 0; i < t.cols.length; i++) { if (r[i] == null) continue; o[t.cols[i]] = r[i]; if (alias[i]) o[alias[i]] = r[i]; }
            out.push(o);
        }
    }
    return out;
}

/* ======================== 数据源(店铺) ======================== */
let tables = [];   // 当前飞书多维表格的数据表(只在保存仪表盘配置时用)
function sources(kind) {
    const shops = setShops(kind === 'order' ? 'orders' : 'videos');
    const opts = shops.map(s => ({ v: 'shop:' + s, label: `店铺 ${s}`, shops: [s] }));
    if (shops.length > 1) opts.push({ v: 'all', label: `全部 ${shops.length} 个店铺合计`, shops });
    return opts;
}
function fillSelect(sel, opts, saved, guess) {
    sel.innerHTML = '<option value="">(不显示)</option>' + opts.map(o => `<option value="${esc(o.v)}">${esc(o.label)}</option>`).join('');
    const pick = opts.find(o => o.v === saved) || opts.find(o => o.v.startsWith('shop:')) || opts.find(o => guess.test(o.label));
    sel.value = pick ? pick.v : '';
}

/* ======================== 统计 ======================== */
// 寄样单:订单表「Normal or Pre-order」不是 Normal 的(寄样单这一列是空的,金额为 0)
//   Pre-order 是正常付款的预售单,不算寄样
const isSample = r => !/^(normal|pre-?order)$/i.test(cellText(r['Normal or Pre-order']).trim());
// 店铺订单只算正常订单(不含寄样单)
function orderStats(rows, [a, b]) {
    const orders = new Map();
    let qty = 0, gmv = 0;
    for (const r of rows) {
        if (isSample(r)) continue;
        const d = dayOf(cellNum(r['Created Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Order ID']).trim();
        if (!id) continue;
        const canceled = /cancel/i.test(cellText(r['Order Status']));
        if (!orders.has(id)) orders.set(id, { canceled, amount: cellNum(r['Order Amount']) });
        // TikTok 口径的 GMV = SKU 折后小计 + 平台补贴(不含税、运费),每个 SKU 行都要加
        if (!canceled) { qty += cellNum(r['Quantity']); gmv += cellNum(r['SKU Subtotal After Discount']) + cellNum(r['SKU Platform Discount']); }
    }
    let valid = 0, sales = 0;
    for (const o of orders.values()) if (!o.canceled) { valid++; sales += o.amount; }
    return { valid, sales, qty, gmv, aov: valid ? sales / valid : NaN };
}
// 寄样单数(按下单日期,一个订单号算一单,已取消的不算);收件达人 = 订单的 Buyer Username,按付费名单分纯佣 / 付费
function sampleStats(rows, [a, b]) {
    const seen = new Map();
    for (const r of rows) {
        if (!isSample(r)) continue;
        const d = dayOf(cellNum(r['Created Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Order ID']).trim();
        if (!id || seen.has(id)) continue;
        if (/cancel/i.test(cellText(r['Order Status']))) { seen.set(id, null); continue; }
        const who = normH(cellText(r['Buyer Username']));
        seen.set(id, { day: d, who, paid: isPaidName(who) });
    }
    const byDay = new Map(dayList([a, b]).map(d => [d, { org: 0, paid: 0 }]));
    const who = { org: new Set(), paid: new Set() };
    let org = 0, paid = 0;
    for (const s of seen.values()) {
        if (!s) continue;
        const g = s.paid ? 'paid' : 'org';
        byDay.get(s.day)[g]++; if (s.who) who[g].add(s.who);
        if (s.paid) paid++; else org++;
    }
    return { org, paid, byDay, who };
}
// 只看当前模式(全部 / 纯佣 / 付费)的寄样
function sampleView(sc) {
    const mode = curMode(), pick = o => mode === 'all' ? o.org + o.paid : mode === 'paid' ? o.paid : o.org;
    const who = mode === 'all' ? new Set([...sc.who.org, ...sc.who.paid]) : sc.who[mode === 'paid' ? 'paid' : 'org'];
    return { n: pick(sc), creators: who.size, day: d => { const x = sc.byDay.get(d); return x ? pick(x) : 0; } };
}
// 视频的商品列:"商品名(商品ID), 商品名2(ID2)" → 取第一个商品
function firstProduct(s) {
    s = String(s || '').trim();
    if (!s) return null;
    const m = s.match(/^(.*?)\((\d{6,})\)/);
    return m ? { name: m[1].trim(), id: m[2] } : { name: s.slice(0, 80), id: s.slice(0, 80) };
}
function videoStats(rows, [a, b]) {
    const vids = new Map();
    for (const r of rows) {
        const d = dayOf(cellNum(r['Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Video ID']).trim();
        if (!id || vids.has(id)) continue;
        vids.set(id, {
            id, day: d, creator: cellText(r['Creator name']), creatorId: cellText(r['Creator ID']) || cellText(r['Creator name']), info: cellText(r['Video Info']),
            views: cellNum(r['Video views']), imp: cellNum(r['Product Impressions']), clicks: cellNum(r['Product Clicks']),
            orders: cellNum(r['Attributed SKU orders']), gmv: cellNum(r['Video-attributed GMV']), product: firstProduct(cellText(r['Products']))
        });
    }
    const list = [...vids.values()];
    const creators = new Map(), products = new Map();
    const byDay = new Map(dayList([a, b]).map(d => [d, { posted: 0, selling: 0, gmv: 0, orders: 0, sellers: new Set() }]));
    for (const v of list) {
        const c = creators.get(v.creatorId) || { id: v.creatorId, name: v.creator, videos: 0, selling: 0, gmv: 0, views: 0, imp: 0, clicks: 0, orders: 0, last: '' };
        c.videos++; c.gmv += v.gmv; c.views += v.views; c.imp += v.imp; c.clicks += v.clicks; c.orders += v.orders; if (v.orders > 0) c.selling++; if (v.day > c.last) c.last = v.day;
        creators.set(v.creatorId, c);
        const dd = byDay.get(v.day);
        if (dd) { dd.posted++; dd.gmv += v.gmv; dd.orders += v.orders; if (v.orders > 0) { dd.selling++; dd.sellers.add(v.creatorId); } }
        if (v.product) {
            const p = products.get(v.product.id) || { id: v.product.id, name: v.product.name, videos: 0, selling: 0, gmv: 0, orders: 0, creators: new Set() };
            p.videos++; p.gmv += v.gmv; p.orders += v.orders; if (v.orders > 0) p.selling++; p.creators.add(v.creatorId);
            products.set(v.product.id, p);
        }
    }
    const sum = k => list.reduce((s, v) => s + v[k], 0);
    const sellingCreators = [...creators.values()].filter(c => c.selling > 0).length;
    return { list, count: list.length, views: sum('views'), imp: sum('imp'), clicks: sum('clicks'), gmv: sum('gmv'), orders: sum('orders'),
        selling: list.filter(v => v.orders > 0).length, creators, sellingCreators, products, byDay };
}

/* ======================== 提示框 ======================== */
const tip = $('tip');
function showTip(e, title, rows) {
    tip.innerHTML = '';
    const t = document.createElement('div'); t.className = 't'; t.textContent = title; tip.appendChild(t);
    for (const r of rows) {
        const row = document.createElement('div'); row.className = 'r';
        const l = document.createElement('span');
        if (r.color) { const i = document.createElement('i'); i.style.background = r.color; l.appendChild(i); }
        l.appendChild(document.createTextNode(r.label));
        const v = document.createElement('b'); v.textContent = r.value;
        row.append(l, v); tip.appendChild(row);
    }
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };

/* ======================== 折线图(本期 vs 上期,同一纵轴) ======================== */
// 4 格刻度的上限:每格是 1 / 2 / 2.5 / 5 × 10^n,保证刻度都是整齐的数
function niceMax(v) { if (!(v > 0)) return 4; const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; let st = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; if (st < 1) st = 1; return st * 4; }
function lineChart(body, width, { labels, series, fmt, axisFmt, tipTitle, height = 240 }) {
    const L = 52, R = 12, T = 10, B = 26, H = height, W = Math.max(280, width);
    const n = labels.length, max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
    const x = i => n === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (n - 1), y = v => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (let k = 0; k <= 4; k++) { const yy = T + (H - T - B) * k / 4; s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${k === 4 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${L - 10}" y="${yy + 4}" text-anchor="end">${axisFmt(max * (1 - k / 4))}</text>`; }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 64))));
    labels.forEach((lb, i) => { if (i % step === 0) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(lb)}</text>`; });
    for (const se of series) {
        const pts = se.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        if (se.area) s += `<polygon points="${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}" fill="${se.color}" opacity=".08"/>`;
        s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    s += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/><g class="dots"></g>`;
    s += `<rect class="ov" x="${L}" y="0" width="${W - L - R}" height="${H - B}" fill="transparent"/></svg>`;
    body.innerHTML = s;
    const svg = body.querySelector('svg'), xh = svg.querySelector('.xh'), dots = svg.querySelector('.dots'), ov = svg.querySelector('.ov');
    ov.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
        const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, n - 1)))));
        xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
        dots.innerHTML = series.map(se => `<circle cx="${x(i)}" cy="${y(se.values[i])}" r="4" fill="${se.color}" stroke="var(--bg)" stroke-width="2"/>`).join('');
        showTip(e, tipTitle(i), series.slice().reverse().map(se => ({ color: se.color, label: se.label(i), value: fmt(se.values[i]) })));
    });
    ov.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; hideTip(); });
}

/* ======================== 可排序表格 ======================== */
const tblState = new Map();   // id -> { key, all }
function renderTable(host, id, { cols, rows, defaultKey, limit = 20, empty = '这段时间没有数据' }) {
    const st = tblState.get(id) || { key: defaultKey, all: false };
    tblState.set(id, st);
    if (!rows.length) { host.innerHTML = `<div class="empty">${empty}</div>`; return; }
    const col = cols.find(c => c.key === st.key) || cols.find(c => c.key === defaultKey);
    const sorted = rows.slice().sort((a, b) => (col.val(b) - col.val(a)) || 0);
    const shown = st.all ? sorted : sorted.slice(0, limit);
    const maxOf = {};
    for (const c of cols) if (c.bar) maxOf[c.key] = Math.max(...rows.map(r => c.val(r)), 1e-9);
    host.innerHTML = `<table class="tbl"><thead><tr><th class="rk">#</th>${cols.map(c => `<th class="${c.num ? 'n' : ''} ${c.val ? 's' : ''} ${c.key === col.key ? 'sorted' : ''} ${c.cls || ''}" ${c.val ? `data-k="${c.key}" tabindex="0"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr><td class="rk">${i + 1}</td>${cols.map(c => {
        if (c.html) return `<td class="who ${c.cls || ''}">${c.html(r)}</td>`;
        const v = c.val(r), txt = c.fmt(v, r);
        if (c.bar) return `<td class="n ${c.cls || ''}"><span class="bar">${esc(txt)}<span class="track"><i style="width:${Math.max(0, Math.min(100, v / maxOf[c.key] * 100)).toFixed(1)}%"></i></span></span></td>`;
        return `<td class="n ${c.cls || ''}">${c.rich ? txt : esc(txt)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>
      ${rows.length > limit ? `<button class="link more" data-more="${id}">${st.all ? '收起' : `显示全部 ${fmtInt(rows.length)} 条`}</button>` : ''}`;
    const rerender = () => renderTable(host, id, { cols, rows, defaultKey, limit, empty });
    host.querySelectorAll('th[data-k]').forEach(th => {
        const go = () => { st.key = th.dataset.k; rerender(); };
        th.onclick = go; th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    const more = host.querySelector('[data-more]');
    if (more) more.onclick = () => { st.all = !st.all; rerender(); };
}

/* ======================== 指标与大图 ======================== */
const pctChange = (a, b) => (isFinite(a) && isFinite(b) && b !== 0) ? (a - b) / Math.abs(b) : NaN;
function deltaText(cur, prev) {
    const r = pctChange(cur, prev);
    if (!isFinite(r)) return '<span>上期无数据</span>';
    if (Math.abs(r) < 0.0005) return '<span>与上期持平</span>';
    return `<span class="${r > 0 ? 'up' : 'down'}">${r > 0 ? '▲' : '▼'} ${Math.abs(r * 100).toFixed(1)}%</span> 较上期`;
}
const METRICS = [
    { key: 'gmv', label: '视频 GMV', total: s => s.gmv, day: d => d.gmv, fmt: fmtMoney0, axis: v => '$' + fmtCompact(v), sub: s => `${fmtInt(s.orders)} 笔订单` },
    { key: 'selling', label: '出单视频', total: s => s.selling, day: d => d.selling, fmt: fmtInt, axis: fmtCompact, sub: s => `出单率 ${fmtPct(s.count ? s.selling / s.count : NaN)}` },
    { key: 'posted', label: '发布视频', total: s => s.count, day: d => d.posted, fmt: fmtInt, axis: fmtCompact, sub: s => `${fmtInt(s.creators.size)} 位达人发布` },
    { key: 'sellers', label: '出单达人', total: s => s.sellingCreators, day: d => d.sellers.size, fmt: fmtInt, axis: fmtCompact, sub: s => `占发布达人 ${fmtPct(s.creators.size ? s.sellingCreators / s.creators.size : NaN)}` },
    { key: 'orders', label: '视频订单', total: s => s.orders, day: d => d.orders, fmt: fmtInt, axis: fmtCompact, sub: s => `转化率 ${fmtPct(s.clicks ? s.orders / s.clicks : NaN)}` },
    // 寄样来自订单表:没选订单数据时不显示
    { key: 'samples', label: '寄样', need: 'samples', total: s => s.samples.n, day: (d, s) => s.samples.day(d), fmt: fmtInt, axis: fmtCompact, sub: s => `${fmtInt(s.samples.creators)} 位达人收样` }
];
let view = null;   // 最近一次统计结果,切换指标 / 改变宽度时重画
const metricsOn = () => METRICS.filter(m => !m.need || (view.vc[m.need] && view.vp[m.need]));
function renderMetrics() {
    const { vc, vp } = view;
    const list = metricsOn();
    const cur = state.metric && list.find(m => m.key === state.metric) ? state.metric : 'gmv';
    $('metrics').classList.toggle('six', list.length > 5);
    $('metrics').innerHTML = list.map(m => `<button class="metric ${m.key === cur ? 'on' : ''}" role="tab" aria-selected="${m.key === cur}" data-m="${m.key}">
        <div class="k">${m.label}</div><div class="v">${m.fmt(m.total(vc))}</div><div class="d">${deltaText(m.total(vc), m.total(vp))}</div><div class="d">${esc(m.sub(vc))}</div></button>`).join('');
    renderMainChart();
}
function renderMainChart() {
    if (!view) return;
    const { vc, vp, range, prev } = view;
    const m = metricsOn().find(x => x.key === state.metric) || METRICS[0];
    const ds = dayList(range), pds = dayList(prev);
    $('legend').innerHTML = `<span><i style="background:var(--accent)"></i>${m.label} · 本期</span><span><i style="background:var(--prev)"></i>上期 ${md(prev[0])}–${md(prev[1])}</span>`;
    const el = $('mainChart');
    lineChart(el, el.clientWidth, {
        labels: ds.map(md), fmt: m.fmt, axisFmt: m.axis, tipTitle: i => `${ds[i]} ${WD[(new Date(ds[i] + 'T00:00:00Z').getUTCDay() + 6) % 7]}`,
        series: [
            { color: 'var(--prev)', values: pds.map(d => { const v = vp.byDay.get(d); return v ? m.day(v, vp, d) : 0; }), label: i => `上期 ${md(pds[i] || '')}` },
            { color: 'var(--accent)', area: true, values: ds.map(d => m.day(vc.byDay.get(d), vc, d)), label: () => '本期' }
        ]
    });
}

/* ======================== 目标(每店每月,纯佣 / 付费分开) ======================== */
// 目标在导出助手的设置页里填,存成 GitHub 上的 targets.bin:[店铺, 月份, 视频纯佣, 视频付费, 寄样纯佣, 寄样付费]
// 所选时间段的目标 = 每天按「当月目标 ÷ 当月天数」累加(选整月就是月目标)
let targetMap = null;
async function readTargets() {
    const meta = dataManifest && dataManifest.targets;
    if (!meta) return new Map();
    const t = await fetchFile('targets.bin', meta.h, '目标');
    return new Map(t.rows.map(r => [`${r[0]}|${r[1]}`, r]));
}
const monthDays = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
function targetSum(shops, [a, b], col) {
    let v = 0, has = false;
    for (const d of dayList([a, b])) {
        const m = d.slice(0, 7);
        for (const s of shops) { const r = targetMap && targetMap.get(`${s}|${m}`); if (r && r[col] != null) { v += r[col] / monthDays(m); has = true; } }
    }
    return has ? v : null;
}
// 发布视频数(按发布日期,去重)和寄样单数,分纯佣 / 付费
function goalCounts(videoRows, orderRows, [a, b]) {
    const out = { vOrg: null, vPaid: null, sOrg: null, sPaid: null };
    if (videoRows) {
        const seen = new Set(); out.vOrg = 0; out.vPaid = 0;
        for (const r of videoRows) {
            const d = dayOf(cellNum(r['Time']) || null);
            if (!d || d < a || d > b) continue;
            const id = cellText(r['Video ID']).trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            if (isPaidName(r['Creator name'])) out.vPaid++; else out.vOrg++;
        }
    }
    if (orderRows) { const s = sampleStats(orderRows, [a, b]); out.sOrg = s.org; out.sPaid = s.paid; }
    return out;
}
const GOALS = [
    { key: 'vOrg', col: 2, label: '发布视频 · 纯佣', grp: 'organic' },
    { key: 'vPaid', col: 3, label: '发布视频 · 付费', grp: 'paid' },
    { key: 'sOrg', col: 4, label: '寄样 · 纯佣', grp: 'organic' },
    { key: 'sPaid', col: 5, label: '寄样 · 付费', grp: 'paid' }
];
function goalShops() {
    const v = $('srcVideo').value || $('srcOrder').value;
    if (v.startsWith('shop:')) return [v.slice(5)];
    if (v === 'all') return [...new Set([...setShops('videos'), ...setShops('orders')])];
    return [];
}
function renderGoals(videoRows, orderRows, range) {
    const shops = goalShops();
    if (!shops.length || (!videoRows && !orderRows)) { $('goalSec').hidden = true; return; }
    $('goalSec').hidden = false;
    const m = range[1].slice(0, 7), mStart = m + '-01', mEnd = `${m}-${pad(monthDays(m))}`, mtd = [mStart, range[1]];
    const cur = goalCounts(videoRows, orderRows, range);
    const mc = goalCounts(videoRows, orderRows, mtd);
    const mode = curMode();
    const list = GOALS.filter(g => (mode === 'all' || g.grp === mode) && (paidSet || g.grp !== 'paid') && cur[g.key] != null);
    const anyTarget = list.some(g => targetSum(shops, [mStart, mEnd], g.col) != null);
    $('goalNote').textContent = anyTarget
        ? `所选时间段的目标 = 月目标按天折算 · 视频按发布日期,寄样按下单日期(已取消的不算)`
        : '还没有设置这个月的目标:在「TikTok 导出助手」设置页 →「每月目标」里填写';
    $('goals').innerHTML = list.map(g => {
        const n = cur[g.key], t = targetSum(shops, range, g.col);
        const mt = targetSum(shops, [mStart, mEnd], g.col), mExp = targetSum(shops, mtd, g.col);
        const pct = t ? n / t : NaN;
        const status = !t ? '<span style="color:var(--muted)">未设目标</span>'
            : n >= t ? `<span class="up">完成 ${fmtPct(pct)}</span>` : `<span class="${range[1] < todayLocal() ? 'down' : ''}">完成 ${fmtPct(pct)} · 差 ${fmtInt(Math.ceil(t - n))}</span>`;
        const month = mt != null ? `${m.slice(5)} 月累计 ${fmtInt(mc[g.key])} / ${fmtInt(mt)}${range[1] < mEnd ? `(按进度应到 ${fmtInt(Math.round(mExp))})` : ''}` : '';
        return `<div class="goal"><div class="k">${g.label}</div>
            <div class="v">${fmtInt(n)}${t ? `<small>/ ${fmtInt(Math.round(t))}</small>` : ''}</div>
            <div class="gbar"><i class="${t && n >= t ? 'done' : ''}" style="width:${t ? Math.min(100, pct * 100).toFixed(1) : 0}%"></i></div>
            <div class="d">${status}</div>${month ? `<div class="d">${month}</div>` : ''}</div>`;
    }).join('');
}

/* ======================== 付费 / 纯佣 ======================== */
// 「付费达人」表(同一个 base,列 handle):视频表的 Creator name 就是 handle,忽略大小写和 @ 比较
const normH = s => String(s || '').trim().replace(/^@/, '').toLowerCase();
let paidSet = null;   // null = 没有付费达人表,不显示模式切换
const MODES = { all: '全部达人', organic: '纯佣达人', paid: '付费达人' };
const curMode = () => (paidSet && MODES[state.mode] ? state.mode : 'all');
const isPaidName = n => !!paidSet && paidSet.has(normH(n));
async function readPaid() {
    const meta = dataManifest && dataManifest.paid;
    if (!meta) return null;
    const t = await fetchFile('paid.bin', meta.h, '付费达人名单');
    const set = new Set();
    for (const r of t.rows) { const h = normH(r[0]); if (h) set.add(h); }
    return set;
}
const modeTag = () => curMode() === 'all' ? '' : MODES[curMode()];

/* ======================== 洞察(最多 4 条,围绕达人和视频) ======================== */
function renderInsights(vc, vp, oc) {
    const out = [];
    if (curMode() === 'paid') {
        const posted = [...vc.creators.values()].filter(c => c.videos > 0).length;
        out.push(`付费名单共 <b>${fmtInt(paidSet.size)}</b> 位达人,本期 <b>${fmtInt(posted)}</b> 位发布了视频,${fmtInt(vc.sellingCreators)} 位出单。`);
    }
    if (vc.count) {
        const dg = pctChange(vc.gmv, vp.gmv), ds = pctChange(vc.selling, vp.selling);
        const perCur = vc.selling ? vc.gmv / vc.selling : 0, perPrev = vp.selling ? vp.gmv / vp.selling : 0, dp = pctChange(perCur, perPrev);
        if (isFinite(dg)) out.push(`视频 GMV ${dg >= 0 ? '增长' : '下降'} <b>${fmtPct(Math.abs(dg))}</b>。${isFinite(ds) && isFinite(dp) ? (Math.abs(ds) >= Math.abs(dp)
            ? `主要因为出单视频${ds >= 0 ? '多了' : '少了'} ${fmtPct(Math.abs(ds))}` : `主要因为每条出单视频的 GMV ${dp >= 0 ? '提高' : '下降'}了 ${fmtPct(Math.abs(dp))}(${fmtMoney0(perCur)}/条)`) + '。' : ''}`);
        else out.push(`这段时间发布 <b>${fmtInt(vc.count)}</b> 条视频,带来 <b>${fmtMoney0(vc.gmv)}</b> GMV。`);
        const cs = [...vc.creators.values()].sort((a, b) => b.gmv - a.gmv);
        const newOnes = cs.filter(c => !vp.creators.has(c.id));
        if (vc.gmv > 0) out.push(`前 3 位达人贡献 <b>${fmtPct(cs.slice(0, 3).reduce((s, c) => s + c.gmv, 0) / vc.gmv)}</b> 的视频 GMV,第一名是 <b>${esc(cs[0].name)}</b>(${fmtMoney0(cs[0].gmv)})。${newOnes.length ? `新达人 ${newOnes.length} 位,其中 ${newOnes.filter(c => c.selling > 0).length} 位已出单。` : ''}`);
        const hot = vc.list.filter(v => v.orders === 0).sort((a, b) => b.views - a.views);
        const viewP75 = vc.list.map(v => v.views).sort((a, b) => a - b)[Math.floor(vc.list.length * 0.75)] || 0;
        const missed = hot.filter(v => v.views >= viewP75 && v.views > 0);
        out.push(`出单率 <b>${fmtPct(vc.selling / vc.count)}</b>,商品点击率 ${fmtPct(vc.imp ? vc.clicks / vc.imp : NaN)},点击到下单 ${fmtPct(vc.clicks ? vc.orders / vc.clicks : NaN)}。${missed.length ? `有 <b>${missed.length}</b> 条播放量排在前 25% 的视频还没出单,值得看看商品挂车和价格。` : ''}`);
        const ps = [...vc.products.values()].sort((a, b) => b.gmv - a.gmv);
        if (ps.length && ps[0].gmv > 0) out.push(`视频带货最好的商品是 <b>${esc(ps[0].name.slice(0, 40))}</b>,${fmtInt(ps[0].creators.size)} 位达人的 ${fmtInt(ps[0].videos)} 条视频带来 ${fmtMoney0(ps[0].gmv)}${vc.gmv ? `,占视频 GMV 的 ${fmtPct(ps[0].gmv / vc.gmv)}` : ''}。`);
    } else out.push('这段时间没有发布的视频。');
    $('insights').innerHTML = out.slice(0, 4).map(t => `<li>${t}</li>`).join('');
}

/* ======================== 三个分区 ======================== */
function renderCreators(vc, vp) {
    const rows = [...vc.creators.values()];
    renderTable($('creators'), 'creators', {
        defaultKey: 'gmv', empty: '这段时间没有达人发布视频',
        rows,
        cols: [
            { key: 'name', label: '达人', html: c => `<a href="https://www.tiktok.com/@${encodeURIComponent(c.name)}" target="_blank" rel="noopener">${esc(c.name)}</a>${curMode() === 'all' && isPaidName(c.name) ? '<span class="badge paid">付费</span>' : ''}${vp.creators.has(c.id) ? '' : '<span class="badge">新</span>'}<div class="meta">最近发布 ${md(c.last)}</div>` },
            { key: 'videos', label: '视频', num: true, val: c => c.videos, fmt: fmtInt },
            { key: 'selling', label: '出单视频', num: true, val: c => c.selling, fmt: fmtInt },
            { key: 'rate', label: '出单率', num: true, val: c => c.videos ? c.selling / c.videos : 0, fmt: fmtPct, bar: true, cls: 'hide-sm' },
            { key: 'views', label: '播放', num: true, val: c => c.views, fmt: fmtCompact, cls: 'hide-sm' },
            { key: 'ctr', label: '点击率', num: true, val: c => c.imp ? c.clicks / c.imp : 0, fmt: fmtPct, cls: 'hide-sm' },
            { key: 'orders', label: '订单', num: true, val: c => c.orders, fmt: fmtInt },
            { key: 'gmv', label: 'GMV', num: true, val: c => c.gmv, fmt: fmtMoney0, bar: true },
            { key: 'chg', label: '较上期', num: true, rich: true, val: c => { const p = vp.creators.get(c.id); return p ? c.gmv - p.gmv : c.gmv; },
                fmt: (v, c) => { const p = vp.creators.get(c.id); if (!p) return '<span style="color:var(--muted)">—</span>'; const d = c.gmv - p.gmv; return Math.abs(d) < 0.5 ? '<span style="color:var(--muted)">持平</span>' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${fmtMoney0(Math.abs(d))}</span>`; } }
        ]
    });
}
function renderVideos(vc) {
    renderTable($('videos'), 'videos', {
        defaultKey: 'gmv', empty: '这段时间没有发布的视频',
        rows: vc.list,
        cols: [
            { key: 'v', label: '视频', html: v => `<a href="https://www.tiktok.com/@${encodeURIComponent(v.creator)}/video/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.creator)}</a> <span style="color:var(--muted);font-size:12px">${md(v.day)}</span><div class="meta">${esc((v.info || '').replace(/\s+/g, ' ').slice(0, 90))}</div>` },
            { key: 'views', label: '播放', num: true, val: v => v.views, fmt: fmtCompact },
            { key: 'ctr', label: '点击率', num: true, val: v => v.imp ? v.clicks / v.imp : 0, fmt: fmtPct, cls: 'hide-sm' },
            { key: 'cvr', label: '下单率', num: true, val: v => v.clicks ? v.orders / v.clicks : 0, fmt: fmtPct, cls: 'hide-sm' },
            { key: 'orders', label: '订单', num: true, val: v => v.orders, fmt: fmtInt },
            { key: 'gmv', label: 'GMV', num: true, val: v => v.gmv, fmt: fmtMoney0, bar: true }
        ]
    });
}
function renderOrderSide(vc, oc, op) {
    const parts = [];
    if (oc) {
        if (curMode() !== 'all') parts.push(`<div class="stat" style="flex-basis:100%"><div class="k" style="color:var(--muted)">店铺订单和销售额是全店整体数据,不区分付费 / 纯佣;寄样单按收件达人区分</div></div>`);
        parts.push(`<div class="stat"><div class="k">店铺订单(不含寄样)</div><div class="v">${fmtInt(oc.valid)}<small>${deltaText(oc.valid, op.valid)}</small></div></div>`);
        if (oc.samples) parts.push(`<div class="stat"><div class="k">${modeTag() ? modeTag() + '的' : ''}寄样单</div><div class="v">${fmtInt(oc.samples.n)}<small>${deltaText(oc.samples.n, op.samples.n)}</small></div></div>`);
        parts.push(`<div class="stat"><div class="k">店铺销售额</div><div class="v">${fmtMoney0(oc.sales)}<small>${deltaText(oc.sales, op.sales)}</small></div></div>`);
        parts.push(`<div class="stat"><div class="k">客单价</div><div class="v">${isFinite(oc.aov) ? fmtMoney(oc.aov) : '—'}</div></div>`);
        if (vc && oc.sales > 0) parts.push(`<div class="stat"><div class="k">${modeTag() ? modeTag() + '的' : ''}视频 GMV 相当于销售额的</div><div class="v">${fmtPct(vc.gmv / oc.sales)}<small>口径不同,仅供参考</small></div></div>`);
    }
    $('orderStats').innerHTML = parts.join('') || '<div class="empty" style="padding:8px 0">选择订单数据后显示店铺整体订单</div>';
    if (!vc) { $('products').innerHTML = ''; return; }
    renderTable($('products'), 'products', {
        defaultKey: 'gmv', limit: 10, empty: '视频数据里没有商品信息',
        rows: [...vc.products.values()],
        cols: [
            { key: 'name', label: '视频带货商品', html: p => `<span style="font-weight:500">${esc(p.name.slice(0, 70))}</span><div class="meta">商品 ID ${esc(p.id)}</div>` },
            { key: 'videos', label: '视频', num: true, val: p => p.videos, fmt: fmtInt },
            { key: 'selling', label: '出单视频', num: true, val: p => p.selling, fmt: fmtInt },
            { key: 'creators', label: '达人', num: true, val: p => p.creators.size, fmt: fmtInt, cls: 'hide-sm' },
            { key: 'orders', label: '订单', num: true, val: p => p.orders, fmt: fmtInt },
            { key: 'gmv', label: 'GMV', num: true, val: p => p.gmv, fmt: fmtMoney0, bar: true }
        ]
    });
}
/* ======================== GMV Max ======================== */
function gmvStats(sumRows, detRows, [a, b]) {
    const byDay = new Map(dayList([a, b]).map(d => [d, { cost: 0, gmv: 0, sku: 0, has: false }]));
    for (const r of sumRows) {
        if (cellText(r['粒度']) !== '日') continue;
        const dd = byDay.get(dayOf(cellNum(r['开始日期']) || null));
        if (!dd) continue;
        dd.cost += cellNum(r['花费']); dd.gmv += cellNum(r['GMV']); dd.sku += cellNum(r['SKU订单数']); dd.has = true;
    }
    const camps = new Map();
    for (const r of detRows) {
        if (cellText(r['粒度']) !== '日') continue;
        const d = dayOf(cellNum(r['开始日期']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Campaign ID']).trim();
        if (!id) continue;
        const c = camps.get(id) || { id, name: '', status: '', roiTarget: 0, budget: 0, cost: 0, gmv: 0, sku: 0, last: '', days: 0 };
        c.cost += cellNum(r['花费']); c.gmv += cellNum(r['GMV']); c.sku += cellNum(r['SKU订单数']); c.days++;
        if (d >= c.last) { c.last = d; c.name = cellText(r['Campaign名称']) || c.name; c.status = cellText(r['状态']) || c.status; c.roiTarget = cellNum(r['目标ROI']) || c.roiTarget; c.budget = cellNum(r['预算']) || c.budget; }
        camps.set(id, c);
    }
    const ds = [...byDay.values()];
    const cost = ds.reduce((s, d) => s + d.cost, 0), gmv = ds.reduce((s, d) => s + d.gmv, 0), sku = ds.reduce((s, d) => s + d.sku, 0);
    return { byDay, camps, cost, gmv, sku, roi: cost ? gmv / cost : NaN, cpo: sku ? cost / sku : NaN, covered: ds.filter(d => d.has).length, total: ds.length };
}
const fmtRoi = n => isFinite(n) ? n.toFixed(2) : '—';
// 这些指标「越低越好」:较上期下降显示为绿色
const GMV_METRICS = [
    { key: 'gmv', label: '广告 GMV', total: s => s.gmv, day: d => d.gmv, fmt: fmtMoney0, axis: v => '$' + fmtCompact(v), sub: s => `${fmtInt(s.sku)} 笔 SKU 订单` },
    { key: 'cost', label: '广告花费', total: s => s.cost, day: d => d.cost, fmt: fmtMoney0, axis: v => '$' + fmtCompact(v), sub: s => `日均 ${fmtMoney0(s.total ? s.cost / s.total : 0)}`, neutral: true },
    { key: 'roi', label: 'ROI', total: s => s.roi, day: d => d.cost ? d.gmv / d.cost : 0, fmt: fmtRoi, axis: v => v.toFixed(1), sub: s => 'GMV ÷ 花费' },
    { key: 'sku', label: 'SKU 订单', total: s => s.sku, day: d => d.sku, fmt: fmtInt, axis: fmtCompact, sub: s => `单笔成本 ${isFinite(s.cpo) ? fmtMoney(s.cpo) : '—'}` },
    { key: 'cpo', label: '单笔订单成本', total: s => s.cpo, day: d => d.sku ? d.cost / d.sku : 0, fmt: v => isFinite(v) ? fmtMoney(v) : '—', axis: v => '$' + v.toFixed(0), sub: s => '花费 ÷ SKU 订单', lowerBetter: true }
];
// 花费涨跌本身不分好坏 → 不上色;单笔订单成本越低越好 → 颜色反过来
function gmvDelta(cur, prev, lowerBetter, neutral) {
    const h = deltaText(cur, prev);
    if (neutral) return h.replace(/class="(up|down)"/, 'style="color:var(--text-2)"');
    return lowerBetter ? h.replace('class="up"', 'class="__d"').replace('class="down"', 'class="up"').replace('class="__d"', 'class="down"') : h;
}
let gview = null;
function renderGmv() {
    if (!gview) return;
    const { gc, gp } = gview;
    const cur = GMV_METRICS.find(m => m.key === state.gmvMetric) || GMV_METRICS[0];
    $('gmvMetrics').innerHTML = GMV_METRICS.map(m => `<button class="metric ${m.key === cur.key ? 'on' : ''}" role="tab" aria-selected="${m.key === cur.key}" data-g="${m.key}">
        <div class="k">${m.label}</div><div class="v">${m.fmt(m.total(gc))}</div><div class="d">${gp.covered ? gmvDelta(m.total(gc), m.total(gp), m.lowerBetter, m.neutral) : '<span>上期无数据</span>'}</div><div class="d">${esc(m.sub(gc))}</div></button>`).join('');
    renderGmvChart();
}
function renderGmvChart() {
    if (!gview) return;
    const { gc, gp, range, prev } = gview;
    const m = GMV_METRICS.find(x => x.key === state.gmvMetric) || GMV_METRICS[0];
    const ds = dayList(range), pds = dayList(prev);
    $('gmvLegend').innerHTML = `<span><i style="background:var(--accent)"></i>${m.label} · 本期</span><span><i style="background:var(--prev)"></i>上期 ${md(prev[0])}–${md(prev[1])}</span>`;
    const el = $('gmvChart');
    lineChart(el, el.clientWidth, {
        labels: ds.map(md), fmt: m.fmt, axisFmt: m.axis, height: 200, tipTitle: i => `${ds[i]} ${WD[(new Date(ds[i] + 'T00:00:00Z').getUTCDay() + 6) % 7]}`,
        series: [
            { color: 'var(--prev)', values: pds.map(d => { const v = gp.byDay.get(d); return v ? m.day(v) : 0; }), label: i => `上期 ${md(pds[i] || '')}` },
            { color: 'var(--accent)', area: true, values: ds.map(d => m.day(gc.byDay.get(d))), label: () => '本期' }
        ]
    });
}
function renderGmvSection(gc, gp, oc) {
    const below = [...gc.camps.values()].filter(c => c.cost > 0 && c.roiTarget > 0 && c.gmv / c.cost < c.roiTarget);
    const notes = [`按天汇总 · 飞书里有 ${gc.covered} / ${gc.total} 天的数据${gc.covered < gc.total ? '(缺的天可在导出助手里补拉)' : ''}`];
    $('gmvNote').textContent = notes.join(' · ');
    const parts = [];
    if (oc && oc.gmv > 0) parts.push(`<div class="stat"><div class="k">广告 GMV 占店铺 GMV</div><div class="v">${fmtPct(gc.gmv / oc.gmv)}<small>店铺 GMV ${fmtMoney0(oc.gmv)}(折后小计 + 平台补贴)</small></div></div>`);
    if (gc.camps.size) parts.push(`<div class="stat"><div class="k">低于目标 ROI 的 campaign</div><div class="v">${fmtInt(below.length)}<small>/ ${fmtInt([...gc.camps.values()].filter(c => c.cost > 0).length)} 个在花费</small></div></div>`);
    $('gmvStats').innerHTML = parts.join('');
    renderTable($('campaigns'), 'campaigns', {
        defaultKey: 'cost', limit: 10, empty: '明细表里这段时间没有 campaign 数据',
        rows: [...gc.camps.values()],
        cols: [
            { key: 'name', label: 'Campaign', html: c => `<span style="font-weight:500">${esc(c.name || c.id)}</span><div class="meta">${esc(c.status || '')}${c.budget ? ` · 预算 ${fmtMoney0(c.budget)}` : ''} · ID ${esc(c.id)}</div>` },
            { key: 'cost', label: '花费', num: true, val: c => c.cost, fmt: fmtMoney0, bar: true },
            { key: 'gmv', label: 'GMV', num: true, val: c => c.gmv, fmt: fmtMoney0 },
            { key: 'roi', label: 'ROI / 目标', num: true, rich: true, val: c => c.cost ? c.gmv / c.cost : 0,
                fmt: (v, c) => `<span class="${c.roiTarget && c.cost ? (v >= c.roiTarget ? 'up' : 'down') : ''}">${c.cost ? v.toFixed(2) : '—'}</span><span style="color:var(--muted)"> / ${c.roiTarget ? c.roiTarget.toFixed(2) : '—'}</span>` },
            { key: 'sku', label: 'SKU 订单', num: true, val: c => c.sku, fmt: fmtInt },
            { key: 'cpo', label: '单笔成本', num: true, val: c => c.sku ? c.cost / c.sku : 0, fmt: v => v ? fmtMoney(v) : '—', cls: 'hide-sm' },
            { key: 'share', label: '花费占比', num: true, val: c => gc.cost ? c.cost / gc.cost : 0, fmt: fmtPct, cls: 'hide-sm' }
        ]
    });
    renderGmv();
}
// 当前选择的店铺(跟随视频 / 订单的选择)里,有这类数据的店铺
function pickShops(set) {
    const v = $('srcVideo').value || $('srcOrder').value;
    const have = setShops(set);
    if (v.startsWith('shop:')) return have.includes(v.slice(5)) ? [v.slice(5)] : [];
    if (v === 'all') return have;
    return [];
}
async function readGmv(fromDay, toDay) {
    const shops = [...new Set([...pickShops('gmvsum'), ...pickShops('gmvdet')])];
    if (!shops.length) return null;
    const [sum, det] = await Promise.all([readSet('gmvsum', pickShops('gmvsum'), fromDay, toDay), readSet('gmvdet', pickShops('gmvdet'), fromDay, toDay)]);
    return { sum, det };
}

/* ======================== 视频走势(逐日明细) ======================== */
const trendShops = () => pickShops('vday');
async function readDaily(shops, from, to) {
    const out = [];
    for (const o of await readSet('vday', shops, from, to)) {
        const d = o['统计日期'];
        if (!d || d < from || d > to) continue;
        out.push({ day: d, id: String(o['Video ID']), creator: o['Creator name'] || '', info: o['Video Info'] || '', pub: dayOf(+o['Time']), prod: o['Products'] || '',
            views: +o['Video views'] || 0, gmv: +o['Video-attributed GMV'] || 0, orders: +o['Attributed SKU orders'] || 0 });
    }
    return out;
}
const NEW_DAYS = 7;   // 发布 7 天内(含发布当天)算新视频
function trendStats(rows, [a, b]) {
    const byDay = new Map(dayList([a, b]).map(d => [d, { views: 0, gmv: 0, orders: 0, active: 0, nViews: 0, nGmv: 0, nOrders: 0, nActive: 0 }]));
    const vids = new Map();
    for (const r of rows) {
        const dd = byDay.get(r.day);
        if (!dd) continue;
        const isNew = r.pub && days(r.pub, r.day) <= NEW_DAYS;
        dd.views += r.views; dd.gmv += r.gmv; dd.orders += r.orders; dd.active++;
        if (isNew) { dd.nViews += r.views; dd.nGmv += r.gmv; dd.nOrders += r.orders; dd.nActive++; }
        const v = vids.get(r.id) || { id: r.id, creator: r.creator, info: r.info, pub: r.pub, prod: r.prod, views: 0, gmv: 0, orders: 0, days: 0, sellDays: 0, peakDay: '', peakGmv: -1, series: new Map() };
        v.views += r.views; v.gmv += r.gmv; v.orders += r.orders; v.days++; if (r.orders > 0) v.sellDays++;
        if (r.gmv > v.peakGmv) { v.peakGmv = r.gmv; v.peakDay = r.day; }
        v.series.set(r.day, r);
        vids.set(r.id, v);
    }
    const ds = [...byDay.values()], sum = k => ds.reduce((s, d) => s + d[k], 0);
    return { byDay, vids, views: sum('views'), gmv: sum('gmv'), orders: sum('orders'), nViews: sum('nViews'), nGmv: sum('nGmv'), nOrders: sum('nOrders'),
        activeAvg: ds.length ? sum('active') / ds.length : 0, nActiveAvg: ds.length ? sum('nActive') / ds.length : 0, videoCount: vids.size };
}
// 发布后第 k 天的平均表现:只统计在已读数据里「第 k 天」已经过完的视频
function lifecycle(rows, pubFrom, end, maxAge = 30) {
    const acc = Array.from({ length: maxAge }, () => ({ views: 0, gmv: 0, orders: 0, n: 0 }));
    const byVid = new Map();
    for (const r of rows) { if (!r.pub || r.pub < pubFrom || r.pub > end) continue; if (!byVid.has(r.id)) byVid.set(r.id, { pub: r.pub, m: new Map() }); byVid.get(r.id).m.set(r.day, r); }
    for (const v of byVid.values()) {
        for (let k = 0; k < maxAge; k++) {
            const d = shift(v.pub, k);
            if (d > end) break;
            const r = v.m.get(d);
            acc[k].n++;
            if (r) { acc[k].views += r.views; acc[k].gmv += r.gmv; acc[k].orders += r.orders; }
        }
    }
    return { acc, videos: byVid.size };
}
const TREND_METRICS = [
    { key: 'gmv', label: 'GMV', all: s => s.gmv, nw: s => s.nGmv, dAll: d => d.gmv, dNew: d => d.nGmv, fmt: fmtMoney0, axis: v => '$' + fmtCompact(v), life: a => a.gmv, lifeFmt: fmtMoney },
    { key: 'views', label: '播放', all: s => s.views, nw: s => s.nViews, dAll: d => d.views, dNew: d => d.nViews, fmt: fmtCompact, axis: fmtCompact, life: a => a.views, lifeFmt: v => fmtInt(v) },
    { key: 'orders', label: '订单', all: s => s.orders, nw: s => s.nOrders, dAll: d => d.orders, dNew: d => d.nOrders, fmt: fmtInt, axis: fmtCompact, life: a => a.orders, lifeFmt: v => v.toFixed(2) },
    { key: 'active', label: '每天有数据的视频', all: s => s.activeAvg, nw: s => s.nActiveAvg, dAll: d => d.active, dNew: d => d.nActive, fmt: v => fmtInt(v), axis: fmtCompact, life: null }
];
let tview = null;
function spark(v, range, key) {
    const ds = dayList(range), vals = ds.map(d => { const r = v.series.get(d); return r ? r[key] : 0; });
    const max = Math.max(...vals, 1e-9), W = 96, H = 22;
    const pts = vals.map((x, i) => `${(i * W / Math.max(1, ds.length - 1)).toFixed(1)},${(H - 2 - x / max * (H - 4)).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
function renderTrendView() {
    if (!tview) return;
    const { tc, tp, range, prev, life } = tview;
    const m = TREND_METRICS.find(x => x.key === state.trendMetric) || TREND_METRICS[0];
    $('trendMetrics').innerHTML = TREND_METRICS.map(x => {
        const all = x.all(tc), share = all ? x.nw(tc) / all : NaN;
        return `<button class="metric ${x.key === m.key ? 'on' : ''}" role="tab" aria-selected="${x.key === m.key}" data-t="${x.key}">
        <div class="k">${x.label}${x.key === 'active' ? '(日均)' : ''}</div><div class="v">${x.fmt(all)}</div><div class="d">${deltaText(all, x.all(tp))}</div><div class="d">新视频占 ${fmtPct(share)}</div></button>`;
    }).join('');
    const ds = dayList(range);
    $('trendLegend').innerHTML = `<span><i style="background:var(--accent)"></i>新视频(发布 ${NEW_DAYS} 天内)</span><span><i style="background:var(--c2)"></i>老视频</span>`;
    const el = $('trendChart');
    lineChart(el, el.clientWidth, {
        labels: ds.map(md), fmt: m.fmt, axisFmt: m.axis, height: 220, tipTitle: i => `${ds[i]} ${WD[(new Date(ds[i] + 'T00:00:00Z').getUTCDay() + 6) % 7]}`,
        series: [
            { color: 'var(--c2)', values: ds.map(d => { const v = tc.byDay.get(d); return m.dAll(v) - m.dNew(v); }), label: () => '老视频' },
            { color: 'var(--accent)', values: ds.map(d => m.dNew(tc.byDay.get(d))), label: () => '新视频' }
        ]
    });
    const lm = m.life ? m : TREND_METRICS[0];
    const ages = life.acc.map((a, k) => ({ k, a })).filter(x => x.a.n >= 3);
    $('lifeTitle').textContent = `发布后第 N 天的平均${lm.label}(${fmtInt(life.videos)} 个视频)`;
    const le = $('lifeChart');
    if (ages.length >= 2) lineChart(le, le.clientWidth, {
        labels: ages.map(x => `第${x.k + 1}天`), fmt: lm.lifeFmt, axisFmt: lm.axis, height: 180, tipTitle: i => `发布后第 ${ages[i].k + 1} 天 · ${fmtInt(ages[i].a.n)} 个视频`,
        series: [{ color: 'var(--accent)', area: true, values: ages.map(x => lm.life(x.a) / x.a.n), label: () => '平均每个视频' }]
    });
    else le.innerHTML = '<div class="empty">这段时间新发布的视频太少,画不出曲线</div>';
    const sk = m.key === 'active' ? 'views' : m.key;
    renderTable($('trendVideos'), 'trendVideos', {
        defaultKey: 'gmv', empty: '这段时间没有视频数据',
        rows: [...tc.vids.values()],
        cols: [
            { key: 'v', label: '视频', html: v => `<a href="https://www.tiktok.com/@${encodeURIComponent(v.creator)}/video/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.creator)}</a>${curMode() === 'all' && isPaidName(v.creator) ? '<span class="badge paid">付费</span>' : ''} <span style="color:var(--muted);font-size:12px">发布 ${v.pub ? md(v.pub) : '—'}</span><div class="meta">${esc((v.info || '').replace(/\s+/g, ' ').slice(0, 80))}</div>` },
            { key: 'spark', label: `每日${m.key === 'active' ? '播放' : m.label}`, html: v => spark(v, range, sk), cls: 'hide-sm' },
            { key: 'views', label: '播放', num: true, val: v => v.views, fmt: fmtCompact },
            { key: 'orders', label: '订单', num: true, val: v => v.orders, fmt: fmtInt },
            { key: 'gmv', label: 'GMV', num: true, val: v => v.gmv, fmt: fmtMoney0, bar: true },
            { key: 'days', label: '活跃天数', num: true, val: v => v.days, fmt: fmtInt, cls: 'hide-sm' },
            { key: 'sell', label: '出单天数', num: true, val: v => v.sellDays, fmt: fmtInt, cls: 'hide-sm' },
            { key: 'peak', label: '峰值日', num: true, val: v => v.peakGmv, fmt: (x, v) => v.peakGmv > 0 ? `${md(v.peakDay)} · ${fmtMoney0(v.peakGmv)}` : '—', cls: 'hide-sm' }
        ]
    });
    const oldShare = tc.gmv ? 1 - tc.nGmv / tc.gmv : NaN;
    const lastDay = [...tc.byDay.keys()].filter(d => tc.byDay.get(d).active).pop(), ld = lastDay && tc.byDay.get(lastDay);
    const longTail = [...tc.vids.values()].filter(v => v.pub && days(v.pub, range[0]) > 30 && v.sellDays >= 3).length;
    // 平均每个新视频发布后 N 天内累计带来多少 GMV(第 k 天的平均值累加;只用样本足够的天数)
    const cum = n => { let s = 0; for (let k = 0; k < n; k++) { const a = life.acc[k]; if (!a || a.n < 3) return null; s += a.gmv / a.n; } return s; };
    const c7 = cum(7), c30 = cum(30);
    const ins = [];
    if (tc.gmv > 0) ins.push(`视频 GMV 里 <b>${fmtPct(oldShare)}</b> 来自发布超过 ${NEW_DAYS} 天的老视频,${fmtPct(1 - oldShare)} 来自新视频。`);
    if (c7 != null) ins.push(`平均每个新视频发布后 7 天内带来 <b>${fmtMoney(c7)}</b> GMV${c30 != null ? `,30 天内 <b>${fmtMoney(c30)}</b>${c30 > 0 ? `(前 7 天占 ${fmtPct(c7 / c30)})` : ''}` : ''}。`);
    if (longTail) ins.push(`有 <b>${fmtInt(longTail)}</b> 个发布超过 30 天的视频,这段时间仍有 3 天以上出单,适合追加投流或复用素材。`);
    if (ld) ins.push(`${md(lastDay)} 当天有 ${fmtInt(ld.active)} 个视频有数据,其中新视频 ${fmtInt(ld.nActive)} 个。`);
    $('trendInsights').innerHTML = ins.slice(0, 4).map(t => `<li>${t}</li>`).join('');
}
let trendSeq = 0;
async function renderTrend(range, prev) {
    const seq = ++trendSeq;
    const sec = $('trendSec'), note = $('trendNote');
    const shops = trendShops();
    if (!shops.length || !dataKey) { sec.hidden = true; return; }
    sec.hidden = false;
    note.textContent = '读取逐日数据…';
    try {
        const rows = await readDaily(shops, prev[0], range[1]);
        if (seq !== trendSeq) return;
        const mode = curMode();
        const rs = mode === 'all' ? rows : rows.filter(r => isPaidName(r.creator) === (mode === 'paid'));
        const tc = trendStats(rs, range), tp = trendStats(rs, prev);
        const have = [...tc.byDay.values()].filter(d => d.active).length;
        tview = { tc, tp, range, prev, life: lifecycle(rs, prev[0], range[1]) };
        note.textContent = `每天每个视频当天的数据 · 有 ${have} / ${days(...range)} 天的数据${modeTag() ? ' · 只看' + modeTag() : ''}`;
        renderTrendView();
    } catch (e) { if (seq === trendSeq) note.textContent = '读取失败:' + (e.message || e); }
}
$('trendMetrics').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; state.trendMetric = b.dataset.t; save({ trendMetric: state.trendMetric }); renderTrendView(); });

let resizeT, lastW = 0;
new ResizeObserver(() => { const w = $('out').clientWidth; if (Math.abs(w - lastW) < 8) return; lastW = w; clearTimeout(resizeT); resizeT = setTimeout(() => { renderMainChart(); renderGmvChart(); renderTrendView(); }, 120); }).observe($('out'));
$('metrics').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; state.metric = b.dataset.m; save({ metric: state.metric }); renderMetrics(); });
$('gmvMetrics').addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (!b) return; state.gmvMetric = b.dataset.g; save({ gmvMetric: state.gmvMetric }); renderGmv(); });

/* ======================== 主流程 ======================== */
const state = Object.assign({ period: 'lastweek', custom: null }, load());
let srcOpts = { order: [], video: [] };
const pref = {};   // 仪表盘模式下来自已保存的配置;侧边栏模式下来自本机记忆
function rebuildSources() {
    srcOpts = { order: sources('order'), video: sources('video') };
    fillSelect($('srcOrder'), srcOpts.order, $('srcOrder').value || pref.srcOrder || load().srcOrder, /订单/);
    fillSelect($('srcVideo'), srcOpts.video, $('srcVideo').value || pref.srcVideo || load().srcVideo, /视频/);
}
/* ---------- 仪表盘插件模式 ---------- */
// 放进飞书仪表盘时,SDK 会给出状态:Create / Config(配置)、View(展示)、FullScreen(全屏)
let dashState = '';
try { dashState = (bitable.dashboard && bitable.dashboard.state) || ''; } catch (e) {}
if (!dashState && /[?&]isConfig=(1|true)/i.test(location.search)) dashState = 'Config';
const isDash = ['Create', 'Config', 'View', 'FullScreen'].includes(dashState);
const isDashView = dashState === 'View' || dashState === 'FullScreen';
let renderedOnce = false;
function markRendered() {
    if (!isDash || renderedOnce) return;
    renderedOnce = true;
    try { Promise.resolve(bitable.dashboard.setRendered()).catch(() => {}); } catch (e) {}
}
async function loadDashConfig() {
    try {
        const c = await withTimeout(bitable.dashboard.getConfig(), 8000, '读取仪表盘配置');
        const cc = (c && c.customConfig) || {};
        if (cc.srcOrder != null) pref.srcOrder = cc.srcOrder;
        if (cc.srcVideo != null) pref.srcVideo = cc.srcVideo;
        if (cc.period) state.period = cc.period;
        if (cc.custom) state.custom = cc.custom;
        if (cc.mode) state.mode = cc.mode;
        return true;
    } catch (e) { return false; }
}
async function saveDashConfig() {
    // dataConditions 是飞书仪表盘要求的数据源;看板的数据其实来自 GitHub,这里指向当前多维表格的第一张表即可
    const firstId = tables[0] && tables[0].id;
    if (!firstId) { msg('当前多维表格里至少要有一张数据表,才能保存仪表盘配置', true); return; }
    try {
        await withTimeout(bitable.dashboard.saveConfig({
            dataConditions: [{ tableId: firstId, series: 'COUNTA' }],
            customConfig: { srcOrder: $('srcOrder').value, srcVideo: $('srcVideo').value, period: state.period, custom: state.custom || null, mode: state.mode || 'all' }
        }), 10000, '保存配置');
        msg('已保存到仪表盘');
    } catch (e) { msg('保存失败:' + (e && e.message || e), true); }
}

function msg(t, err) { $('msg').hidden = !t; $('msg').textContent = t || ''; $('msg').className = 'msg' + (err ? ' err' : ''); }
function progress(p) { const el = $('progress'); el.classList.toggle('show', p != null && p < 1); el.firstElementChild.style.width = ((p || 0) * 100) + '%'; }
const reading = new Map();   // 正在下载的文件 -> { n, total }
function showReading() {
    const left = [...reading].filter(([, p]) => p.n < p.total).map(([name]) => name);
    if (!left.length) { if (/^正在下载/.test($('msg').textContent)) msg(''); progress(null); return; }
    msg(`正在下载「${left.slice(0, 2).join('」「')}」${left.length > 2 ? ` 等 ${left.length} 个文件` : ''}…(下载过的会缓存,下次秒开)`);
    progress(1 - left.length / reading.size);
}
async function readSource(kind, fromDay, toDay) {
    const v = $(kind === 'order' ? 'srcOrder' : 'srcVideo').value;
    const opt = srcOpts[kind].find(o => o.v === v);
    if (!opt) return null;
    return readSet(kind === 'order' ? 'orders' : 'videos', opt.shops, fromDay, toDay);
}

/* ---------- 下载数据(解密后存成 CSV,用 Excel / WPS 打开) ---------- */
const DL_SETS = [['videos', '视频(按发布时间)', 'Time'], ['orders', '订单(按下单时间)', 'Created Time'], ['vday', '视频逐日(按统计日期)', '统计日期'],
    ['gmvsum', 'GMV Max 汇总', '开始日期'], ['gmvdet', 'GMV Max 明细', '开始日期'], ['paid', '付费达人名单', '']];
const fmtWall = ms => { const d = wallOf(ms).toISOString(); return d.slice(0, 10) + ' ' + d.slice(11, 16); };
function csvCell(v) { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function downloadCsv() {
    const [set, label, dateCol] = DL_SETS.find(x => x[0] === $('dlSet').value) || DL_SETS[0];
    const range = periodOf(state.period, state.custom);
    $('dlBtn').disabled = true;
    try {
        const tablesIn = [];
        let shops = [];
        if (set === 'paid') {
            if (!dataManifest.paid) throw new Error('还没有上传付费达人名单');
            tablesIn.push(await fetchFile('paid.bin', dataManifest.paid.h, '付费达人名单'));
        } else {
            shops = pickShops(set);
            if (!shops.length) throw new Error(`当前选择的店铺没有「${label}」数据`);
            const want = new Set(monthsBetween(range[0], range[1]));
            for (const sh of shops) {
                for (const [m, meta] of Object.entries(dataManifest.sets[set][sh])) {
                    if (want.has(m)) tablesIn.push(Object.assign(await fetchFile(`${set}/${sh}/${m}.bin`, meta.h, `${SET_LABEL[set]} ${m}`), { shop: sh }));
                }
            }
        }
        const cols = [];
        for (const t of tablesIn) for (const c of t.cols) if (!cols.includes(c)) cols.push(c);
        const withShop = shops.length > 1;
        const lines = [(withShop ? ['店铺'] : []).concat(cols).map(csvCell).join(',')];
        let n = 0;
        for (const t of tablesIn) {
            const idx = cols.map(c => t.cols.indexOf(c)), di = dateCol ? t.cols.indexOf(dateCol) : -1;
            for (const r of t.rows) {
                if (di >= 0) { const v = r[di], d = typeof v === 'number' ? dayOf(v) : String(v || ''); if (d < range[0] || d > range[1]) continue; }
                const vals = idx.map((i, k) => { const v = i < 0 ? null : r[i]; return typeof v === 'number' && v > 1e12 && /Time|日期|时间/.test(cols[k]) ? fmtWall(v) : v; });
                lines.push((withShop ? [t.shop] : []).concat(vals).map(csvCell).join(','));
                n++;
            }
        }
        if (!n) throw new Error(`${range[0]} 至 ${range[1]} 没有「${label}」数据`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        a.download = set === 'paid' ? '付费达人名单.csv' : `${SET_LABEL[set]}_${withShop ? '全部店铺' : shops[0]}_${range[0]}_${range[1]}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 20000);
        msg(`已下载 ${fmtInt(n)} 行(${range[0]} 至 ${range[1]})。如果没有弹出下载,请用普通浏览器打开看板网址再下载,飞书里可能会拦截下载。`);
        progress(null);
    } catch (e) { msg('下载失败:' + (e.message || e), true); progress(null); }
    finally { $('dlBtn').disabled = false; }
}
let busy = false, again = false;
async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    const range = periodOf(state.period, state.custom), prev = prevOf(range);
    document.querySelectorAll('#pills button').forEach(b => b.classList.toggle('on', b.dataset.p === state.period));
    $('custom').classList.toggle('show', state.period === 'custom');
    $('range').textContent = `${range[0]} 至 ${range[1]} · ${days(...range)} 天`;
    $('reload').disabled = true;
    $('out').classList.add('loading');   // 刷新时保留旧画面、降低透明度,不闪
    try {
        reading.clear();
        const t0 = performance.now();
        // 目标要看「本月累计」:数据至少从所选时间段最后一天所在月的 1 号读起
        const from = [prev[0], range[1].slice(0, 8) + '01'].sort()[0];
        const [orders, allVideos, gm, paid, tg] = await Promise.all([readSource('order', from, range[1]), readSource('video', from, range[1]), readGmv(prev[0], range[1]), readPaid().catch(() => null), readTargets().catch(() => new Map())]);
        paidSet = paid; targetMap = tg;
        $('modes').hidden = !paidSet;
        document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === curMode()));
        // 付费 / 纯佣:按达人 handle 过滤视频(达人、视频、视频带货商品都跟着变;店铺订单和 GMV Max 不区分)
        const mode = curMode();
        const videos = allVideos && mode !== 'all' ? allVideos.filter(r => isPaidName(r['Creator name']) === (mode === 'paid')) : allVideos;
        $('range').textContent = `${range[0]} 至 ${range[1]} · ${days(...range)} 天${modeTag() ? ' · 只看' + modeTag() : ''}`;
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        msg(''); progress(null);
        $('range').title = `读取用时 ${secs} 秒`;
        showUpdated();
        pruneCache();
        $('out').hidden = false;
        const oc = orders && orderStats(orders, range), op = orders && orderStats(orders, prev);
        const vc = videos && videoStats(videos, range), vp = videos && videoStats(videos, prev);
        if (orders) {
            const sc = sampleView(sampleStats(orders, range)), sp = sampleView(sampleStats(orders, prev));
            oc.samples = sc; op.samples = sp;
            if (vc) { vc.samples = sc; vp.samples = sp; }
        }
        renderGoals(allVideos, orders, range);
        if (vc) { view = { vc, vp, range, prev }; renderMetrics(); renderInsights(vc, vp, oc); renderCreators(vc, vp); renderVideos(vc); }
        else {
            view = null;
            for (const id of ['metrics', 'legend', 'insights', 'creators', 'videos']) $(id).innerHTML = '';
            $('mainChart').innerHTML = '<div class="empty">请在上方选择视频数据</div>';
        }
        renderOrderSide(vc, oc, op);
        if (gm) {
            const gc = gmvStats(gm.sum, gm.det, range), gp = gmvStats(gm.sum, gm.det, prev);
            gview = { gc, gp, range, prev };
            $('gmvSec').hidden = false;
            renderGmvSection(gc, gp, oc);
        } else { gview = null; $('gmvSec').hidden = true; }
        renderTrend(range, prev);   // 逐日明细在后台读取,不挡住上面的内容
        const lbl = [$('srcVideo'), $('srcOrder')].map(s => s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '').filter(Boolean);
        $('shop').textContent = lbl.length ? [...new Set(lbl)].join(' / ') : 'TikTok Shop';
        markRendered();
    } catch (e) {
        progress(null);
        msg('读取失败:' + (e && e.message || e), true);
        markRendered();
    } finally {
        $('out').classList.remove('loading');
        $('reload').disabled = false;
        busy = false;
        if (again) { again = false; refresh(); }
    }
}

let inFeishu = false;
function showLock(on) {
    $('lock').hidden = !on; $('lockBtn').hidden = on; $('dlbar').hidden = on;
    document.body.classList.toggle('locked', on);
    if (on) { $('out').hidden = true; msg(''); setTimeout(() => $('pw').focus(), 50); }
}
// 读数据目录 → 确认密码 → 开始统计
/* ---------- 数据更新:显示更新时间、定时检查、清理旧缓存 ---------- */
function showUpdated() {
    const u = dataManifest && dataManifest.updated;
    if (!u) { $('updated').textContent = ''; return; }
    const d = new Date(u), mins = Math.round((Date.now() - d) / 60000);
    const ago = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
    $('updated').textContent = `数据更新于 ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}(${ago})`;
    $('updated').title = d.toLocaleString();
}
// 当前 manifest 里所有文件的地址(带指纹);缓存里不在这个列表的都是旧版本
function liveUrls() {
    const out = new Set();
    for (const [set, shops] of Object.entries(dataManifest.sets || {}))
        for (const [shop, months] of Object.entries(shops))
            for (const [m, meta] of Object.entries(months)) out.add(`${DATA_BASE}${set}/${shop}/${m}.bin?h=${meta.h || ''}`);
    if (dataManifest.paid) out.add(`${DATA_BASE}paid.bin?h=${dataManifest.paid.h || ''}`);
    if (dataManifest.targets) out.add(`${DATA_BASE}targets.bin?h=${dataManifest.targets.h || ''}`);
    return out;
}
let pruned = '';
async function pruneCache() {
    if (!dataManifest || pruned === dataManifest.updated) return;
    pruned = dataManifest.updated;
    try {
        await caches.delete('shop-data-v1');   // 旧格式的缓存
        const c = await caches.open('shop-data-v2'), live = liveUrls();
        let n = 0;
        for (const req of await c.keys()) if (!live.has(req.url)) { await c.delete(req); n++; }
        for (const k of [...fileCache.keys()]) if (!live.has(k)) fileCache.delete(k);
        if (n) console.log('清理旧缓存', n, '个文件');
    } catch (e) {}
}
// 每 5 分钟看一次 manifest(只有几 KB);数据有更新就自动刷新。页面在后台时不检查,切回来时立刻检查一次
const CHECK_MS = 5 * 60000;
let lastCheck = 0;
async function checkUpdate() {
    if (!dataKey || busy || document.hidden || Date.now() - lastCheck < 30000) return;
    lastCheck = Date.now();
    const before = dataManifest && dataManifest.updated;
    try { await loadManifest(true); } catch (e) { return; }
    showUpdated();
    if (dataManifest.updated !== before) { rebuildSources(); msg('数据有更新,正在刷新…'); refresh(); }
}
setInterval(checkUpdate, CHECK_MS);
setInterval(() => { if (dataKey) showUpdated(); }, 60000);   // 「x 分钟前」随时间走
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastCheck > CHECK_MS) checkUpdate(); });

async function start() {
    msg('正在读取数据目录…');
    lastCheck = Date.now();
    try { await loadManifest(true); }
    catch (e) { msg('读取数据目录失败:' + (e.message || e) + '。请检查能否访问 GitHub,然后点「刷新」。', true); markRendered(); return; }
    let key = null;
    try { key = await getKey(); } catch (e) { msg('解密失败:' + (e.message || e), true); markRendered(); return; }
    if (!key) { showLock(true); markRendered(); return; }
    showLock(false);
    rebuildSources();
    refresh();
}
async function init() {
    msg('正在启动…');
    if (isDash) setTimeout(markRendered, 12000);   // 仪表盘:无论如何 12 秒内撤掉飞书的加载动画
    // 飞书是可选的:在多维表格里打开时读主题和仪表盘配置;直接用浏览器打开也能看(数据都来自 GitHub)
    try { tables = await withTimeout(bitable.base.getTableMetaList(), 6000, '连接多维表格'); inFeishu = true; } catch (e) { tables = []; }
    if (isDash && inFeishu) {
        document.body.classList.add('dash');
        if (isDashView) document.body.classList.add('dash-view');
        else { $('saveCfg').hidden = false; $('cfgHint').hidden = false; }
        await loadDashConfig();
        $('saveCfg').onclick = saveDashConfig;
        try { bitable.dashboard.onConfigChange(async () => { await loadDashConfig(); $('srcOrder').value = ''; $('srcVideo').value = ''; rebuildSources(); refresh(); }); } catch (e) {}
    }
    if (inFeishu) {
        try {
            const th = await withTimeout(bitable.bridge.getTheme(), 3000, '读取主题');
            document.documentElement.dataset.theme = /dark/i.test(th) ? 'dark' : 'light';
            bitable.bridge.onThemeChange(ev => { document.documentElement.dataset.theme = /dark/i.test((ev && ev.data && ev.data.theme) || '') ? 'dark' : 'light'; renderMainChart(); renderGmvChart(); renderTrendView(); });
        } catch (e) {}
    } else {
        $('size').hidden = true;
        if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
    }
    if (state.custom) { $('cs').value = state.custom[0]; $('ce').value = state.custom[1]; }
    const link = (from, to) => {
        const v = $(from).value;
        if ((v.startsWith('shop:') || v === 'all') && [...$(to).options].some(o => o.value === v)) $(to).value = v;
        save({ srcOrder: $('srcOrder').value, srcVideo: $('srcVideo').value });
        refresh();
    };
    $('srcOrder').onchange = () => link('srcOrder', 'srcVideo');
    $('srcVideo').onchange = () => link('srcVideo', 'srcOrder');
    $('modes').onclick = e => {
        const b = e.target.closest('button[data-mode]'); if (!b) return;
        state.mode = b.dataset.mode; save({ mode: state.mode }); refresh();
    };
    $('pills').onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        state.period = b.dataset.p; save({ period: state.period });
        if (state.period !== 'custom' || state.custom) refresh(); else { $('custom').classList.add('show'); document.querySelectorAll('#pills button').forEach(x => x.classList.toggle('on', x === b)); }
    };
    $('apply').onclick = () => {
        const c = [$('cs').value, $('ce').value];
        if (!c[0] || !c[1] || c[0] > c[1]) { msg('请选择有效的开始和结束日期', true); return; }
        state.custom = c; save({ custom: c, period: 'custom' }); state.period = 'custom'; refresh();
    };
    // 刷新:重新读数据目录(文件按指纹缓存,没变的不会重新下载)
    $('reload').onclick = async () => { try { await loadManifest(true); rebuildSources(); } catch (e) {} refresh(); };
    $('unlock').onclick = async () => {
        const pw = $('pw').value;
        if (!pw) return;
        $('unlock').disabled = true; $('lockMsg').textContent = '验证中…';
        try { dataKey = await deriveKey(pw); lsSet(PW_KEY, pw); $('pw').value = ''; $('lockMsg').textContent = ''; start(); }
        catch (e) { $('lockMsg').textContent = e && e.name === 'OperationError' ? '密码不对' : '验证失败:' + (e.message || e); }
        finally { $('unlock').disabled = false; }
    };
    $('pw').onkeydown = e => { if (e.key === 'Enter') $('unlock').click(); };
    $('lockBtn').onclick = () => { lsSet(PW_KEY, null); dataKey = null; fileCache.clear(); showLock(true); };
    $('dlSet').innerHTML = DL_SETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('dlBtn').onclick = downloadCsv;
    const sizeBtns = [...document.querySelectorAll('#size button')];
    const markSize = s => sizeBtns.forEach(b => b.classList.toggle('on', b.dataset.s === s));
    markSize(state.size || '');
    $('size').onclick = async e => {
        const b = e.target.closest('button'); if (!b) return;
        try {
            const ok = await bitable.ui.setHostContainerSize(b.dataset.s);
            if (ok === false) throw new Error('不支持');
            state.size = b.dataset.s; save({ size: state.size }); markSize(state.size);
        } catch (err) { msg('飞书暂不支持插件调整侧边栏大小,可以用鼠标拖动侧边栏的左边缘把它拉宽', true); }
    };
    if (state.size && !isDash && inFeishu) { try { Promise.resolve(bitable.ui.setHostContainerSize(state.size)).catch(() => {}); } catch (e) {} }
    start();
}
init();
