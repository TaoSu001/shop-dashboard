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
// 缓存:tableId -> { from, rows }。from = 已读到的最早日期;要看更早的日期时才重新读
const cache = new Map();
// 只读 fromDay 之后的记录(按日期字段在飞书端筛选),不必每次把整张表读完
async function readTable(tableId, wanted, timeField, fromDay, onPage) {
    const hit = cache.get(tableId);
    if (hit && (hit.from === '' || hit.from <= fromDay)) return hit.rows;
    const table = await bitable.base.getTableById(tableId);
    const metas = await table.getFieldMetaList();
    const byName = new Map(metas.map(m => [m.name, m.id]));
    // 带币种的列名(如 "Video GMV ($)")按前缀匹配
    const ids = wanted.map(w => [w, byName.get(w) || (metas.find(m => m.name.startsWith(w + ' (')) || {}).id]).filter(x => x[1]);
    const timeId = byName.get(timeField);
    const since = Date.parse(shift(fromDay, -1) + 'T00:00:00Z') - 8 * 3600e3;
    const filter = timeId ? { conjunction: 'and', conditions: [{ fieldId: timeId, operator: 'isGreater', value: since }] } : undefined;
    const readAll = async useFilter => {
        const rows = [];
        let pageToken, total = 0;
        do {
            const res = await table.getRecordsByPage(Object.assign({ pageSize: 200, pageToken }, useFilter && filter ? { filter } : {}));
            total = res.total || total;
            for (const r of res.records) {
                const o = {};
                for (const [w, id] of ids) o[w] = r.fields[id];
                rows.push(o);
            }
            pageToken = res.hasMore ? res.pageToken : undefined;
            onPage && onPage(rows.length, total);
        } while (pageToken);
        return rows;
    };
    let rows, from = fromDay;
    try { rows = await readAll(true); }
    catch (e) { rows = await readAll(false); from = ''; }   // 筛选不被支持时退回整表读取
    if (!filter) from = '';
    cache.set(tableId, { from, rows });
    return rows;
}
const ORDER_COLS = ['Order ID', 'Order Status', 'Created Time', 'Quantity', 'Order Amount', 'Order Refund Amount', 'SKU Subtotal After Discount',
    'Seller SKU', 'Product Name', 'Variation', 'State', 'Buyer Username'];
const VIDEO_COLS = ['Video ID', 'Creator name', 'Creator ID', 'Video Info', 'Time', 'Video views', 'Product Impressions', 'Product Clicks',
    'Attributed SKU orders', 'Video-attributed GMV', 'Products'];

/* ======================== 数据源 ======================== */
let tables = [];
function sources(kind) {
    const prefix = kind === 'order' ? '订单' : '视频';
    const groups = new Map();
    for (const t of tables) {
        const m = t.name.match(new RegExp('^' + prefix + '_(\\d+)_(\\d+)$'));
        if (m) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push(t); }
    }
    const opts = [];
    for (const [shop, list] of groups) opts.push({ v: 'shop:' + shop, label: `店铺 ${shop}(${list.length} 张表)`, ids: list.map(t => t.id) });
    if (groups.size > 1) opts.push({ v: 'all', label: `全部 ${groups.size} 个店铺合计`, ids: [...groups.values()].flat().map(t => t.id) });
    for (const t of tables) if (!/^(订单|视频)_\d+_\d+$/.test(t.name)) opts.push({ v: 'tbl:' + t.id, label: t.name, ids: [t.id] });
    return opts;
}
function fillSelect(sel, opts, saved, guess) {
    sel.innerHTML = '<option value="">(不显示)</option>' + opts.map(o => `<option value="${esc(o.v)}">${esc(o.label)}</option>`).join('');
    const pick = opts.find(o => o.v === saved) || opts.find(o => o.v.startsWith('shop:')) || opts.find(o => guess.test(o.label));
    sel.value = pick ? pick.v : '';
}

/* ======================== 统计 ======================== */
function orderStats(rows, [a, b]) {
    const orders = new Map();
    let qty = 0;
    for (const r of rows) {
        const d = dayOf(cellNum(r['Created Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Order ID']).trim();
        if (!id) continue;
        const canceled = /cancel/i.test(cellText(r['Order Status']));
        if (!orders.has(id)) orders.set(id, { canceled, amount: cellNum(r['Order Amount']) });
        if (!canceled) qty += cellNum(r['Quantity']);
    }
    let valid = 0, sales = 0;
    for (const o of orders.values()) if (!o.canceled) { valid++; sales += o.amount; }
    return { valid, sales, qty, aov: valid ? sales / valid : NaN };
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
    { key: 'orders', label: '视频订单', total: s => s.orders, day: d => d.orders, fmt: fmtInt, axis: fmtCompact, sub: s => `转化率 ${fmtPct(s.clicks ? s.orders / s.clicks : NaN)}` }
];
let view = null;   // 最近一次统计结果,切换指标 / 改变宽度时重画
function renderMetrics() {
    const { vc, vp } = view;
    const cur = state.metric && METRICS.find(m => m.key === state.metric) ? state.metric : 'gmv';
    $('metrics').innerHTML = METRICS.map(m => `<button class="metric ${m.key === cur ? 'on' : ''}" role="tab" aria-selected="${m.key === cur}" data-m="${m.key}">
        <div class="k">${m.label}</div><div class="v">${m.fmt(m.total(vc))}</div><div class="d">${deltaText(m.total(vc), m.total(vp))}</div><div class="d">${esc(m.sub(vc))}</div></button>`).join('');
    renderMainChart();
}
function renderMainChart() {
    if (!view) return;
    const { vc, vp, range, prev } = view;
    const m = METRICS.find(x => x.key === state.metric) || METRICS[0];
    const ds = dayList(range), pds = dayList(prev);
    $('legend').innerHTML = `<span><i style="background:var(--accent)"></i>${m.label} · 本期</span><span><i style="background:var(--prev)"></i>上期 ${md(prev[0])}–${md(prev[1])}</span>`;
    const el = $('mainChart');
    lineChart(el, el.clientWidth, {
        labels: ds.map(md), fmt: m.fmt, axisFmt: m.axis, tipTitle: i => `${ds[i]} ${WD[(new Date(ds[i] + 'T00:00:00Z').getUTCDay() + 6) % 7]}`,
        series: [
            { color: 'var(--prev)', values: pds.map(d => { const v = vp.byDay.get(d); return v ? m.day(v) : 0; }), label: i => `上期 ${md(pds[i] || '')}` },
            { color: 'var(--accent)', area: true, values: ds.map(d => m.day(vc.byDay.get(d))), label: () => '本期' }
        ]
    });
}

/* ======================== 洞察(最多 4 条,围绕达人和视频) ======================== */
function renderInsights(vc, vp, oc) {
    const out = [];
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
            { key: 'name', label: '达人', html: c => `<a href="https://www.tiktok.com/@${encodeURIComponent(c.name)}" target="_blank" rel="noopener">${esc(c.name)}</a>${vp.creators.has(c.id) ? '' : '<span class="badge">新</span>'}<div class="meta">最近发布 ${md(c.last)}</div>` },
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
        parts.push(`<div class="stat"><div class="k">店铺订单</div><div class="v">${fmtInt(oc.valid)}<small>${deltaText(oc.valid, op.valid)}</small></div></div>`);
        parts.push(`<div class="stat"><div class="k">店铺销售额</div><div class="v">${fmtMoney0(oc.sales)}<small>${deltaText(oc.sales, op.sales)}</small></div></div>`);
        parts.push(`<div class="stat"><div class="k">客单价</div><div class="v">${isFinite(oc.aov) ? fmtMoney(oc.aov) : '—'}</div></div>`);
        if (vc && oc.sales > 0) parts.push(`<div class="stat"><div class="k">视频 GMV 相当于销售额的</div><div class="v">${fmtPct(vc.gmv / oc.sales)}<small>口径不同,仅供参考</small></div></div>`);
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
let resizeT, lastW = 0;
new ResizeObserver(() => { const w = $('out').clientWidth; if (Math.abs(w - lastW) < 8) return; lastW = w; clearTimeout(resizeT); resizeT = setTimeout(renderMainChart, 120); }).observe($('out'));
$('metrics').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; state.metric = b.dataset.m; save({ metric: state.metric }); renderMetrics(); });

/* ======================== 主流程 ======================== */
const state = Object.assign({ period: 'lastweek', custom: null }, load());
let srcOpts = { order: [], video: [] };
let refreshTables = async () => {};
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
        const c = await bitable.dashboard.getConfig();
        const cc = (c && c.customConfig) || {};
        if (cc.srcOrder != null) pref.srcOrder = cc.srcOrder;
        if (cc.srcVideo != null) pref.srcVideo = cc.srcVideo;
        if (cc.period) state.period = cc.period;
        if (cc.custom) state.custom = cc.custom;
        return true;
    } catch (e) { return false; }
}
async function saveDashConfig() {
    const so = srcOpts.order.find(o => o.v === $('srcOrder').value), sv = srcOpts.video.find(o => o.v === $('srcVideo').value);
    const firstId = (so && so.ids[0]) || (sv && sv.ids[0]);
    if (!firstId) { msg('请至少选择订单或视频数据', true); return; }
    try {
        await bitable.dashboard.saveConfig({
            // dataConditions 是仪表盘要求的数据源(用于数据变化通知);统计本身由插件自己读表计算
            dataConditions: [{ tableId: firstId, series: 'COUNTA' }],
            customConfig: { srcOrder: $('srcOrder').value, srcVideo: $('srcVideo').value, period: state.period, custom: state.custom || null }
        });
        msg('已保存到仪表盘');
    } catch (e) { msg('保存失败:' + (e && e.message || e), true); }
}

function msg(t, err) { $('msg').hidden = !t; $('msg').textContent = t || ''; $('msg').className = 'msg' + (err ? ' err' : ''); }
function progress(p) { const el = $('progress'); el.classList.toggle('show', p != null && p < 1); el.firstElementChild.style.width = ((p || 0) * 100) + '%'; }
const reading = new Map();
function showReading() {
    let n = 0, total = 0; const names = [];
    for (const [name, p] of reading) { n += p.n; total += p.total; if (p.n < p.total || !p.total) names.push(name); }
    if (!reading.size) return;
    msg(`正在读取${names.length ? '「' + names.slice(0, 2).join('」「') + '」' + (names.length > 2 ? ' 等' : '') : ''}… ${fmtInt(n)} / ${fmtInt(total)} 行`);
    progress(total ? n / total : 0);
}
async function readSource(kind, fromDay) {
    const v = $(kind === 'order' ? 'srcOrder' : 'srcVideo').value;
    const opt = srcOpts[kind].find(o => o.v === v);
    if (!opt) return null;
    const parts = await Promise.all(opt.ids.map(id => {
        const name = (tables.find(t => t.id === id) || {}).name || id;
        return readTable(id, kind === 'order' ? ORDER_COLS : VIDEO_COLS, kind === 'order' ? 'Created Time' : 'Time', fromDay, (n, total) => { reading.set(name, { n, total }); showReading(); });
    }));
    return parts.flat();
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
        const [orders, videos] = await Promise.all([readSource('order', prev[0]), readSource('video', prev[0])]);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        msg(''); progress(null);
        const loaded = [...reading.values()].reduce((s, p) => s + p.n, 0);
        if (loaded) $('range').title = `读取 ${fmtInt(loaded)} 行,用时 ${secs} 秒`;
        $('out').hidden = false;
        const oc = orders && orderStats(orders, range), op = orders && orderStats(orders, prev);
        const vc = videos && videoStats(videos, range), vp = videos && videoStats(videos, prev);
        if (vc) { view = { vc, vp, range, prev }; renderMetrics(); renderInsights(vc, vp, oc); renderCreators(vc, vp); renderVideos(vc); }
        else {
            view = null;
            for (const id of ['metrics', 'legend', 'insights', 'creators', 'videos']) $(id).innerHTML = '';
            $('mainChart').innerHTML = '<div class="empty">请在上方选择视频数据</div>';
        }
        renderOrderSide(vc, oc, op);
        const lbl = [$('srcVideo'), $('srcOrder')].map(s => s.selectedIndex > 0 ? s.options[s.selectedIndex].text.replace(/\s*\(\d+ 张表\)$/, '') : '').filter(Boolean);
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

async function init() {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
    try {
        tables = await Promise.race([bitable.base.getTableMetaList(), timeout]);
    } catch (e) {
        msg('没有连上多维表格。请在飞书多维表格的「扩展脚本」或「仪表盘 → 添加插件组件」里打开这个页面,而不是直接在浏览器里打开。', true);
        return;
    }
    if (isDash) {
        document.body.classList.add('dash');
        if (isDashView) document.body.classList.add('dash-view');
        else { $('saveCfg').hidden = false; $('cfgHint').hidden = false; }
        await loadDashConfig();
        $('saveCfg').onclick = saveDashConfig;
        try {
            bitable.dashboard.onConfigChange(async () => { await loadDashConfig(); $('srcOrder').value = ''; $('srcVideo').value = ''; rebuildSources(); refresh(); });
            let t;
            bitable.dashboard.onDataChange(() => { clearTimeout(t); t = setTimeout(() => { cache.clear(); refresh(); }, 5000); });
        } catch (e) {}
    }
    try {
        const th = await bitable.bridge.getTheme();
        document.documentElement.dataset.theme = /dark/i.test(th) ? 'dark' : 'light';
        bitable.bridge.onThemeChange(ev => { document.documentElement.dataset.theme = /dark/i.test((ev && ev.data && ev.data.theme) || '') ? 'dark' : 'light'; renderMainChart(); });
    } catch (e) {}
    rebuildSources();
    const onTablesChanged = async () => {
        try {
            const before = JSON.stringify([srcOpts.order, srcOpts.video].map(l => l.map(o => o.v + o.ids)));
            tables = await bitable.base.getTableMetaList();
            rebuildSources();
            if (JSON.stringify([srcOpts.order, srcOpts.video].map(l => l.map(o => o.v + o.ids))) !== before) { msg('检测到子表有变化,已更新列表'); refresh(); }
        } catch (e) {}
    };
    try { bitable.base.onTableAdd(onTablesChanged); bitable.base.onTableDelete(onTablesChanged); } catch (e) {}
    window.addEventListener('focus', onTablesChanged);
    refreshTables = onTablesChanged;
    if (state.custom) { $('cs').value = state.custom[0]; $('ce').value = state.custom[1]; }
    const link = (from, to) => {
        const v = $(from).value;
        if ((v.startsWith('shop:') || v === 'all') && [...$(to).options].some(o => o.value === v)) $(to).value = v;
        save({ srcOrder: $('srcOrder').value, srcVideo: $('srcVideo').value });
        refresh();
    };
    $('srcOrder').onchange = () => link('srcOrder', 'srcVideo');
    $('srcVideo').onchange = () => link('srcVideo', 'srcOrder');
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
    $('reload').onclick = async () => { cache.clear(); await refreshTables(); refresh(); };
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
    if (state.size && !isDash) { try { Promise.resolve(bitable.ui.setHostContainerSize(state.size)).catch(() => {}); } catch (e) {} }
    refresh();
}
init();
