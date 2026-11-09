// 店铺经营看板 · 飞书多维表格插件(侧边栏扩展脚本 / 仪表盘插件 两用)
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
    'Attributed SKU orders', 'Video-attributed GMV', 'Video-attributed items sold'];

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
// 订单状态分组:顺序 = 配色槽位顺序(颜色跟着状态走,不随排名变)
const STATUS = [
    { key: 'shipped', name: '已发货', color: 'var(--series-1)', re: /ship|transit/i },
    { key: 'canceled', name: '已取消', color: 'var(--series-2)', re: /cancel/i },
    { key: 'completed', name: '已完成', color: 'var(--series-3)', re: /complet|deliver/i },
    { key: 'toship', name: '待发货', color: 'var(--series-4)', re: /to ship|awaiting|process/i, darkInk: true },
    { key: 'pending', name: '待付款/处理中', color: 'var(--series-5)', re: /unpaid|pending|hold/i },
    { key: 'other', name: '其他', color: 'var(--series-6)', re: /./ }
];
const statusOf = s => {
    if (/cancel/i.test(s)) return 'canceled';
    if (/to ship|awaiting|process/i.test(s)) return 'toship';
    for (const g of STATUS) if (g.key !== 'other' && g.re.test(s)) return g.key;
    return 'other';
};
const AOV_BINS = [[0, 10], [10, 20], [20, 30], [30, 40], [40, 60], [60, 100], [100, Infinity]];
function orderStats(rows, [a, b]) {
    const orders = new Map();
    const sku = new Map();
    let qty = 0;
    for (const r of rows) {
        const ms = cellNum(r['Created Time']);
        const d = dayOf(ms || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Order ID']).trim();
        if (!id) continue;
        const st = statusOf(cellText(r['Order Status']));
        let o = orders.get(id);
        if (!o) {
            const w = wallOf(ms);
            o = { day: d, hour: w.getUTCHours(), wd: (w.getUTCDay() + 6) % 7, st, canceled: st === 'canceled', amount: cellNum(r['Order Amount']),
                refund: cellNum(r['Order Refund Amount']), state: cellText(r['State']).trim(), buyer: cellText(r['Buyer Username']).trim() };
            orders.set(id, o);
        }
        if (!o.canceled) {
            const q = cellNum(r['Quantity']);
            qty += q;
            const key = cellText(r['Seller SKU']) || cellText(r['Product Name']) || '(无 SKU)';
            const s = sku.get(key) || { key, name: cellText(r['Product Name']), variation: cellText(r['Variation']), qty: 0, revenue: 0, orders: new Set() };
            s.qty += q; s.revenue += cellNum(r['SKU Subtotal After Discount']); s.orders.add(id); sku.set(key, s);
        }
    }
    const byDay = new Map(dayList([a, b]).map(d => [d, { orders: 0, sales: 0 }]));
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const status = new Map(STATUS.map(g => [g.key, 0]));
    const states = new Map(), buyers = new Map();
    const aov = AOV_BINS.map(() => 0);
    let valid = 0, sales = 0, canceled = 0, refund = 0;
    for (const o of orders.values()) {
        status.set(o.st, status.get(o.st) + 1);
        if (o.canceled) { canceled++; continue; }
        valid++; sales += o.amount; refund += o.refund;
        const dd = byDay.get(o.day); if (dd) { dd.orders++; dd.sales += o.amount; }
        heat[o.wd][o.hour]++;
        if (o.state) { const s = states.get(o.state) || { orders: 0, sales: 0 }; s.orders++; s.sales += o.amount; states.set(o.state, s); }
        if (o.buyer) buyers.set(o.buyer, (buyers.get(o.buyer) || 0) + 1);
        const bi = AOV_BINS.findIndex(([lo, hi]) => o.amount >= lo && o.amount < hi); if (bi >= 0) aov[bi]++;
    }
    const repeat = [...buyers.values()].filter(n => n >= 2).length;
    return { all: orders.size, valid, canceled, sales, qty, refund, aov: valid ? sales / valid : NaN, cancelRate: orders.size ? canceled / orders.size : NaN,
        byDay, heat, status, states, sku, buyers: buyers.size, repeatRate: buyers.size ? repeat / buyers.size : NaN, aovBins: aov };
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
            orders: cellNum(r['Attributed SKU orders']), gmv: cellNum(r['Video-attributed GMV']), items: cellNum(r['Video-attributed items sold'])
        });
    }
    const list = [...vids.values()];
    const creators = new Map();
    const byDay = new Map(dayList([a, b]).map(d => [d, { posted: 0, selling: 0, gmv: 0 }]));
    for (const v of list) {
        const c = creators.get(v.creatorId) || { name: v.creator, videos: 0, selling: 0, gmv: 0, views: 0, orders: 0 };
        c.videos++; c.gmv += v.gmv; c.views += v.views; c.orders += v.orders; if (v.orders > 0) c.selling++;
        creators.set(v.creatorId, c);
        const dd = byDay.get(v.day); if (dd) { dd.posted++; if (v.orders > 0) dd.selling++; dd.gmv += v.gmv; }
    }
    const sum = k => list.reduce((s, v) => s + v[k], 0);
    return { list, count: list.length, views: sum('views'), imp: sum('imp'), clicks: sum('clicks'), gmv: sum('gmv'), orders: sum('orders'),
        selling: list.filter(v => v.orders > 0).length, creators, byDay };
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
// 给带 data-tip 的元素绑定提示(内容存在 tipData 里,避免把数据拼进 HTML)
function bindTips(root, tipData) {
    root.addEventListener('pointermove', e => { const el = e.target.closest('[data-tip]'); if (!el) { hideTip(); return; } const d = tipData[+el.dataset.tip]; showTip(e, d.title, d.rows); });
    root.addEventListener('pointerleave', hideTip);
}

/* ======================== 图表(SVG / HTML,无第三方库) ======================== */
const svgNS = 'http://www.w3.org/2000/svg';
// 4 格刻度的上限:每格是 1 / 2 / 2.5 / 5 × 10^n,保证刻度都是整齐的数
function niceMax(v) { if (!(v > 0)) return 4; const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; let st = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; if (st < 1) st = 1; return st * 4; }
const roundTopRect = (x, y, w, h, r) => { r = Math.min(r, w / 2, h); if (h <= 0) return ''; return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

// 折线(可多条、同一纵轴),十字线 + 提示
function lineChart(body, width, { labels, series, fmt, tipTitle, height = 220 }) {
    const L = 48, R = 14, T = 12, B = 26, H = height, W = Math.max(280, width);
    const n = labels.length, max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
    const x = i => n === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (n - 1), y = v => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (let k = 0; k <= 4; k++) { const yy = T + (H - T - B) * k / 4; s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${k === 4 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmt(max * (1 - k / 4), true)}</text>`; }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 56))));
    labels.forEach((lb, i) => { if (i % step === 0 || i === n - 1) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>`; });
    for (const se of series) {
        const pts = se.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        if (se.area) s += `<polygon points="${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}" fill="${se.color}" opacity=".10"/>`;
        s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (!se.muted && n) { const i = n - 1; s += `<circle cx="${x(i)}" cy="${y(se.values[i])}" r="4" fill="${se.color}" stroke="var(--card)" stroke-width="2"/>`; }
    }
    s += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>`;
    s += `<rect class="ov" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    body.innerHTML = s;
    const svg = body.querySelector('svg'), xh = svg.querySelector('.xh'), ov = svg.querySelector('.ov');
    ov.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
        const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, n - 1)))));
        xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
        showTip(e, tipTitle(i), series.map(se => ({ color: se.color, label: se.label ? se.label(i) : se.name, value: fmt(se.values[i]) })));
    });
    ov.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}
// 柱状(单系列)
function columnChart(body, width, { labels, values, fmt, tipTitle, color = 'var(--series-1)', height = 200, labelEvery }) {
    const L = 40, R = 8, T = 16, B = 26, H = height, W = Math.max(260, width);
    const n = labels.length, max = niceMax(Math.max(1, ...values)), band = (W - L - R) / Math.max(1, n), bw = Math.min(24, band * 0.62);
    const y = v => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (let k = 0; k <= 4; k++) { const yy = T + (H - T - B) * k / 4; s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${k === 4 ? 'var(--axis)' : 'var(--grid)'}"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmt(max * (1 - k / 4), true)}</text>`; }
    const step = labelEvery || Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 48))));
    const peak = values.indexOf(Math.max(...values));
    values.forEach((v, i) => {
        const cx = L + band * i + band / 2;
        s += `<rect class="hit" data-tip="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`;
        if (v > 0) s += `<path class="bar" d="${roundTopRect(cx - bw / 2, y(v), bw, H - B - y(v), 4)}" fill="${color}" pointer-events="none"/>`;
        if (i === peak && v > 0) s += `<text class="val" x="${cx}" y="${y(v) - 5}" text-anchor="middle">${fmt(v)}</text>`;
        if (i % step === 0) s += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`;
    });
    body.innerHTML = s + '</svg>';
    bindTips(body, values.map((v, i) => ({ title: tipTitle(i), rows: [{ label: '', value: fmt(v) }] })));
}
// 横向条形排行(HTML,文字清晰、自动换行)
function barList(body, rows, { fmt, color = 'var(--series-1)', sub }) {
    if (!rows.length) { body.innerHTML = '<div class="empty">这段时间没有数据</div>'; return; }
    const max = Math.max(...rows.map(r => r.value), 1);
    body.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.6fr) auto;gap:8px 10px;align-items:center">${rows.map((r, i) => `
      <div data-tip="${i}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px" title="${esc(r.label)}">${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">${esc(r.label)}</a>` : esc(r.label)}${r.sub ? `<div class="s" style="color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis">${esc(r.sub)}</div>` : ''}</div>
      <div data-tip="${i}" style="height:24px;display:flex;align-items:center"><div style="height:12px;width:${Math.max(0.6, r.value / max * 100).toFixed(2)}%;background:${color};border-radius:0 4px 4px 0"></div></div>
      <div data-tip="${i}" style="font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right">${fmt(r.value)}</div>`).join('')}</div>`;
    bindTips(body, rows.map(r => ({ title: r.label, rows: r.tip || [{ label: '', value: fmt(r.value) }] })));
}
// 周 × 小时 热力图(单色由浅到深)
function heatmap(body, width, heat) {
    const W = Math.max(300, width), L = 36, T = 4, B = 22, R = 4;
    const cw = (W - L - R) / 24, ch = Math.min(26, Math.max(18, cw)), H = T + ch * 7 + B;
    const max = Math.max(1, ...heat.flat());
    const bin = v => v <= 0 ? 0 : Math.min(5, Math.ceil(v / max * 5));
    const tipData = [];
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    heat.forEach((row, d) => {
        s += `<text x="${L - 6}" y="${T + ch * d + ch / 2 + 4}" text-anchor="end">${WD[d]}</text>`;
        row.forEach((v, h) => {
            const b = bin(v);
            tipData.push({ title: `${WD[d]} ${pad(h)}:00–${pad(h)}:59`, rows: [{ label: '有效订单', value: fmtInt(v) }] });
            s += `<rect data-tip="${tipData.length - 1}" x="${L + cw * h + 1}" y="${T + ch * d + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${b ? `var(--seq-${b})` : 'var(--fill-2)'}"/>`;
        });
    });
    for (let h = 0; h < 24; h += 3) s += `<text x="${L + cw * h + cw / 2}" y="${H - 6}" text-anchor="middle">${h}时</text>`;
    body.innerHTML = s + '</svg>' + `<div class="legend" style="margin:6px 0 0">少 ${[1, 2, 3, 4, 5].map(b => `<i style="background:var(--seq-${b});margin:0"></i>`).join('')} 多 <span style="margin-left:8px">最多 ${fmtInt(max)} 单/小时</span></div>`;
    bindTips(body, tipData);
}
// 一条分段条:整体中的各部分
function segBar(body, width, parts, fmt) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) { body.innerHTML = '<div class="empty">这段时间没有订单</div>'; return; }
    const shown = parts.filter(p => p.value > 0);
    const avail = Math.max(200, width) - 2 * (shown.length - 1);
    body.innerHTML = `<div class="segbar">${shown.map((p, i) => {
        const w = p.value / total, px = w * avail, txt = (w * 100).toFixed(0) + '%';
        return `<div data-tip="${i}" class="${p.darkInk ? 'dark-ink' : ''}" style="flex:${p.value} 1 0;background:${p.color}">${px >= 40 ? txt : ''}</div>`;
    }).join('')}</div>
    <table><tbody>${parts.map(p => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${p.color};margin-right:8px;vertical-align:-1px"></span>${esc(p.name)}</td><td class="n">${fmt(p.value)}</td><td class="n" style="color:var(--muted)">${fmtPct(p.value / total)}</td></tr>`).join('')}</tbody></table>`;
    bindTips(body.querySelector('.segbar'), shown.map(p => ({ title: p.name, rows: [{ label: '订单', value: fmt(p.value) }, { label: '占比', value: fmtPct(p.value / total) }] })));
}
function sparkline(values, width = 220, height = 44) {
    if (values.length < 2) return '';
    const max = Math.max(...values, 1), min = 0;
    const x = i => 2 + (width - 4) * i / (values.length - 1), y = v => 4 + (height - 8) * (1 - (v - min) / (max - min || 1));
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${x(0)},${height} ${pts} ${x(values.length - 1)},${height}" fill="var(--series-1)" opacity=".10"/><polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

/* ======================== 卡片 ======================== */
const cards = new Map();   // key -> spec { title, sub, legend, draw(body,width), table() }
const cardView = new Map(); // key -> 'chart' | 'table'
function setCard(key, spec) { cards.set(key, spec); paintCard(key); }
function paintCard(key) {
    const el = document.querySelector(`[data-card="${key}"]`), spec = cards.get(key);
    if (!el || !spec) return;
    const view = cardView.get(key) || 'chart';
    el.innerHTML = `<div class="card-h"><div><h3>${esc(spec.title)}</h3>${spec.sub ? `<p>${esc(spec.sub)}</p>` : ''}</div>${spec.table ? `<button class="tbtn" data-toggle="${key}">${view === 'chart' ? '数据表' : '图表'}</button>` : ''}</div>
      ${view === 'chart' && spec.legend ? `<div class="legend">${spec.legend.map(l => `<span><i class="${l.line ? 'line' : ''}" style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}</div>` : ''}
      <div class="chart"></div>`;
    const body = el.querySelector('.chart');
    if (view === 'table' && spec.table) {
        const t = spec.table();
        body.innerHTML = `<div class="tablewrap"><table><thead><tr>${t.head.map((h, i) => `<th class="${t.num && t.num.includes(i) ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r => `<tr>${r.map((c, i) => `<td class="${t.num && t.num.includes(i) ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else spec.draw(body, body.clientWidth || el.clientWidth - 32);
}
document.addEventListener('click', e => {
    const b = e.target.closest('[data-toggle]'); if (!b) return;
    const k = b.dataset.toggle; cardView.set(k, (cardView.get(k) || 'chart') === 'chart' ? 'table' : 'chart'); paintCard(k);
});
let resizeT, lastW = 0;
new ResizeObserver(() => { const w = $('out').clientWidth; if (Math.abs(w - lastW) < 8) return; lastW = w; clearTimeout(resizeT); resizeT = setTimeout(() => cards.forEach((_, k) => paintCard(k)), 120); }).observe($('out'));

/* ======================== 指标卡 ======================== */
// 变化:up/down 按「这个指标涨了是好事吗」上色,并带 ▲▼ 符号
function deltaHtml(cur, prev, { lowerIsBetter = false, pp = false } = {}) {
    if (!isFinite(cur) || !isFinite(prev) || (!pp && prev === 0)) return '<div class="d">上期无数据</div>';
    const diff = pp ? (cur - prev) * 100 : (cur - prev) / Math.abs(prev) * 100;
    if (Math.abs(diff) < 0.05) return '<div class="d">与上期持平</div>';
    const good = lowerIsBetter ? diff < 0 : diff > 0;
    return `<div class="d"><span class="${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)}${pp ? ' 个百分点' : '%'}</span> 较上期</div>`;
}
const tile = (k, v, d, extra = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${extra ? `<div class="sub">${extra}</div>` : ''}${d}</div>`;
function renderKpis(oc, op, vc, vp, range) {
    const parts = [];
    if (oc) {
        const daily = dayList(range).map(d => oc.byDay.get(d).sales);
        parts.push(`<div class="tile hero"><div class="k">销售额(不含取消)</div><div class="v">${fmtMoney0(oc.sales)}</div>${deltaHtml(oc.sales, op.sales)}<div class="spark">${sparkline(daily)}</div></div>`);
        parts.push(tile('有效订单', fmtInt(oc.valid), deltaHtml(oc.valid, op.valid)));
        parts.push(tile('客单价', isFinite(oc.aov) ? fmtMoney(oc.aov) : '—', deltaHtml(oc.aov, op.aov)));
        parts.push(tile('售出件数', fmtInt(oc.qty), deltaHtml(oc.qty, op.qty)));
        parts.push(tile('取消率', fmtPct(oc.cancelRate), deltaHtml(oc.cancelRate, op.cancelRate, { lowerIsBetter: true, pp: true }), `${fmtInt(oc.canceled)} 单已取消`));
        parts.push(tile('复购买家占比', fmtPct(oc.repeatRate), deltaHtml(oc.repeatRate, op.repeatRate, { pp: true }), `共 ${fmtInt(oc.buyers)} 位买家`));
        if (oc.refund > 0 || op.refund > 0) parts.push(tile('退款金额', fmtMoney0(oc.refund), deltaHtml(oc.refund, op.refund, { lowerIsBetter: true })));
    }
    if (vc) {
        parts.push(tile('视频归因 GMV', fmtMoney0(vc.gmv), deltaHtml(vc.gmv, vp.gmv)));
        parts.push(tile('发布视频', fmtInt(vc.count), deltaHtml(vc.count, vp.count), `${fmtInt(vc.creators.size)} 位达人`));
        parts.push(tile('出单视频占比', fmtPct(vc.count ? vc.selling / vc.count : NaN), deltaHtml(vc.count ? vc.selling / vc.count : NaN, vp.count ? vp.selling / vp.count : NaN, { pp: true }), `${fmtInt(vc.selling)} 条出单`));
    }
    $('kpis').innerHTML = parts.join('') || '<div class="empty">没有选择数据</div>';
}

/* ======================== 数据洞察 ======================== */
function insights(oc, op, vc, vp, range) {
    const out = [];
    const pct = (a, b) => b ? (a - b) / Math.abs(b) : NaN;
    if (oc && oc.valid) {
        const ds = pct(oc.sales, op.sales), dor = pct(oc.valid, op.valid), da = pct(oc.aov, op.aov);
        if (isFinite(ds)) {
            const driver = Math.abs(dor) >= Math.abs(da) ? `主要来自订单数${dor >= 0 ? '增加' : '减少'} ${fmtPct(Math.abs(dor))}` : `主要来自客单价${da >= 0 ? '提高' : '下降'} ${fmtPct(Math.abs(da))}`;
            out.push({ tone: ds >= 0 ? 'up' : 'down', html: `销售额 <b>${fmtMoney0(oc.sales)}</b>,较上期${ds >= 0 ? '增长' : '下降'} <b>${fmtPct(Math.abs(ds))}</b>,${driver}(订单 ${dor >= 0 ? '+' : '−'}${fmtPct(Math.abs(dor))},客单价 ${da >= 0 ? '+' : '−'}${fmtPct(Math.abs(da))})。` });
        }
        const dd = [...oc.byDay.entries()].filter(([, v]) => v.orders > 0);
        if (dd.length > 1) {
            const best = dd.reduce((a, b) => b[1].sales > a[1].sales ? b : a), worst = dd.reduce((a, b) => b[1].sales < a[1].sales ? b : a);
            out.push({ tone: 'info', html: `销售额最高的一天是 <b>${md(best[0])}(${WD[(new Date(best[0] + 'T00:00:00Z').getUTCDay() + 6) % 7]})</b> ${fmtMoney0(best[1].sales)},最低是 ${md(worst[0])} ${fmtMoney0(worst[1].sales)}。` });
        }
        let pk = [0, 0, 0];
        oc.heat.forEach((r, d) => r.forEach((v, h) => { if (v > pk[2]) pk = [d, h, v]; }));
        const byHour = new Array(24).fill(0); oc.heat.forEach(r => r.forEach((v, h) => byHour[h] += v));
        let bestWin = [0, 0]; for (let h = 0; h < 24; h++) { const s = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24]; if (s > bestWin[1]) bestWin = [h, s]; }
        out.push({ tone: 'info', html: `下单最集中在 <b>${pad(bestWin[0])}:00–${pad((bestWin[0] + 3) % 24)}:00</b>(店铺当地时间),这 3 小时占全部订单的 <b>${fmtPct(bestWin[1] / oc.valid)}</b>;单个时段最高是 ${WD[pk[0]]} ${pad(pk[1])} 点。适合安排直播、投放或达人发布。` });
        const skus = [...oc.sku.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);
        if (skus.length) {
            const totalRev = skus.reduce((s, x) => s + x.revenue, 0) || 1, top = skus[0];
            const prevSku = op.sku;
            let grow = null;
            for (const s of skus.slice(0, 20)) { const p = prevSku.get(s.key); const g = p && p.qty >= 5 ? (s.qty - p.qty) / p.qty : null; if (g != null && (!grow || g > grow.g)) grow = { s, g }; }
            out.push({ tone: 'info', html: `<b>${esc(top.key)}</b> 卖得最好,贡献 <b>${fmtPct(top.revenue / totalRev)}</b> 的 SKU 销售额(${fmtInt(top.qty)} 件)${skus.length >= 3 ? `;前 3 个 SKU 合计占 ${fmtPct(skus.slice(0, 3).reduce((s, x) => s + x.revenue, 0) / totalRev)}` : ''}。${grow && grow.g > 0.2 ? `增长最快的是 <b>${esc(grow.s.key)}</b>,件数较上期 +${fmtPct(grow.g)}。` : ''}` });
        }
        if (isFinite(oc.cancelRate)) {
            const up = isFinite(op.cancelRate) && oc.cancelRate - op.cancelRate > 0.01;
            if (oc.cancelRate >= 0.05 || up) out.push({ tone: 'warn', html: `取消率 <b>${fmtPct(oc.cancelRate)}</b>${isFinite(op.cancelRate) ? `(上期 ${fmtPct(op.cancelRate)})` : ''},${up ? '比上期升高,' : ''}建议检查库存、发货时效和价格设置。` });
        }
        if (isFinite(oc.repeatRate) && oc.buyers >= 20) out.push({ tone: 'info', html: `${fmtInt(oc.buyers)} 位买家中有 <b>${fmtPct(oc.repeatRate)}</b> 在这段时间下了 2 单或以上。` });
        const st = [...oc.states.entries()].sort((a, b) => b[1].orders - a[1].orders);
        if (st.length >= 3) out.push({ tone: 'info', html: `订单最多的州是 <b>${esc(st[0][0])}</b>、${esc(st[1][0])}、${esc(st[2][0])},合计占 <b>${fmtPct((st[0][1].orders + st[1][1].orders + st[2][1].orders) / oc.valid)}</b>。` });
    }
    if (vc && vc.count) {
        const sellRate = vc.selling / vc.count;
        const cs = [...vc.creators.values()].sort((a, b) => b.gmv - a.gmv);
        const top3 = cs.slice(0, 3).reduce((s, c) => s + c.gmv, 0);
        const newC = [...vc.creators.keys()].filter(k => !vp.creators.has(k)).length;
        out.push({ tone: sellRate >= 0.3 ? 'up' : 'info', html: `发布 <b>${fmtInt(vc.count)}</b> 条视频,其中 <b>${fmtPct(sellRate)}</b> 带来了订单;${vc.gmv > 0 ? `前 3 位达人贡献了 <b>${fmtPct(top3 / vc.gmv)}</b> 的视频 GMV,` : ''}${newC ? `有 <b>${fmtInt(newC)}</b> 位达人是上期没有发过视频的新面孔。` : '发视频的都是上期的老达人。'}` });
        if (vc.views > 0) out.push({ tone: 'info', html: `视频转化:${fmtCompact(vc.views)} 次播放 → ${fmtCompact(vc.imp)} 次商品曝光 → ${fmtCompact(vc.clicks)} 次点击(点击率 <b>${fmtPct(vc.imp ? vc.clicks / vc.imp : NaN)}</b>)→ ${fmtInt(vc.orders)} 笔订单(转化率 <b>${fmtPct(vc.clicks ? vc.orders / vc.clicks : NaN)}</b>)。` });
        if (oc && oc.sales > 0 && vc.gmv > 0) out.push({ tone: 'info', html: `这段时间发布的视频带来的 GMV 相当于店铺销售额的 <b>${fmtPct(vc.gmv / oc.sales)}</b>(视频 GMV 为写入时的累计值,口径不完全相同,仅供参考)。` });
    }
    $('insights').innerHTML = out.length ? out.map(i => `<li><span class="ic ${i.tone}" aria-hidden="true">${i.tone === 'up' ? '↑' : i.tone === 'down' ? '↓' : i.tone === 'warn' ? '!' : 'i'}</span><div>${i.html}</div></li>`).join('') : '<li><span class="ic info">i</span><div>这段时间没有足够的数据。</div></li>';
}

/* ======================== 渲染全部 ======================== */
function renderOrders(oc, op, range, prev) {
    const ds = dayList(range), pds = dayList(prev);
    setCard('sales', {
        title: '每日销售额', sub: '与上一期同位置的日期对比',
        legend: [{ name: `本期 ${md(range[0])}–${md(range[1])}`, color: 'var(--series-1)', line: true }, { name: `上期 ${md(prev[0])}–${md(prev[1])}`, color: 'var(--prev)', line: true }],
        draw: (b, w) => lineChart(b, w, {
            labels: ds.map(md), fmt: (v, axis) => axis ? '$' + fmtCompact(v) : fmtMoney0(v), tipTitle: i => `${md(ds[i])} ${WD[(new Date(ds[i] + 'T00:00:00Z').getUTCDay() + 6) % 7]}`,
            series: [
                { name: '上期', color: 'var(--prev)', muted: true, values: pds.map(d => (op.byDay.get(d) || {}).sales || 0), label: i => `上期 ${md(pds[i] || '')}` },
                { name: '本期', color: 'var(--series-1)', area: true, values: ds.map(d => oc.byDay.get(d).sales), label: () => '本期' }
            ]
        }),
        table: () => ({ head: ['日期', '本期销售额', '本期订单', '上期日期', '上期销售额'], num: [1, 2, 4], rows: ds.map((d, i) => [d, fmtMoney(oc.byDay.get(d).sales), fmtInt(oc.byDay.get(d).orders), pds[i] || '', fmtMoney((op.byDay.get(pds[i]) || {}).sales || 0)]) })
    });
    setCard('orders', {
        title: '每日有效订单', sub: '已标出最高的一天',
        draw: (b, w) => columnChart(b, w, { labels: ds.map(md), values: ds.map(d => oc.byDay.get(d).orders), fmt: (v, axis) => axis ? fmtCompact(v) : fmtInt(v) + ' 单', tipTitle: i => ds[i] }),
        table: () => ({ head: ['日期', '有效订单', '销售额'], num: [1, 2], rows: ds.map(d => [d, fmtInt(oc.byDay.get(d).orders), fmtMoney(oc.byDay.get(d).sales)]) })
    });
    setCard('status', {
        title: '订单状态', sub: `共 ${fmtInt(oc.all)} 单(含已取消)`,
        draw: (b, w) => segBar(b, w, STATUS.map(g => ({ name: g.name, color: g.color, value: oc.status.get(g.key), darkInk: g.darkInk })), v => fmtInt(v) + ' 单')
    });
    setCard('heat', {
        title: '下单时段分布', sub: '星期 × 小时,店铺当地时间,颜色越深订单越多',
        draw: (b, w) => heatmap(b, w, oc.heat),
        table: () => ({ head: ['星期', ...Array.from({ length: 24 }, (_, h) => h + '时')], num: Array.from({ length: 24 }, (_, i) => i + 1), rows: oc.heat.map((r, d) => [WD[d], ...r.map(fmtInt)]) })
    });
    const skus = [...oc.sku.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);
    setCard('sku', {
        title: '热销 SKU', sub: '按 SKU 销售额(折后)排序,前 10',
        draw: b => barList(b, skus.slice(0, 10).map(s => ({ label: s.key, sub: [s.name, s.variation].filter(Boolean).join(' · ').slice(0, 70), value: s.revenue,
            tip: [{ label: '销售额', value: fmtMoney(s.revenue) }, { label: '件数', value: fmtInt(s.qty) }, { label: '订单', value: fmtInt(s.orders.size) }, { label: '上期件数', value: fmtInt((op.sku.get(s.key) || {}).qty || 0) }] })), { fmt: fmtMoney0 }),
        table: () => ({ head: ['SKU', '商品', '销售额', '件数', '订单', '上期件数'], num: [2, 3, 4, 5], rows: skus.map(s => [s.key, s.name.slice(0, 60), fmtMoney(s.revenue), fmtInt(s.qty), fmtInt(s.orders.size), fmtInt((op.sku.get(s.key) || {}).qty || 0)]) })
    });
    const sts = [...oc.states.entries()].sort((a, b) => b[1].orders - a[1].orders);
    setCard('state', {
        title: '订单地区', sub: '按州 / 省,前 10',
        draw: b => barList(b, sts.slice(0, 10).map(([k, v]) => ({ label: k, value: v.orders, tip: [{ label: '订单', value: fmtInt(v.orders) }, { label: '销售额', value: fmtMoney0(v.sales) }, { label: '占比', value: fmtPct(v.orders / oc.valid) }] })), { fmt: v => fmtInt(v) }),
        table: () => ({ head: ['州 / 省', '订单', '销售额', '占比'], num: [1, 2, 3], rows: sts.map(([k, v]) => [k, fmtInt(v.orders), fmtMoney(v.sales), fmtPct(v.orders / oc.valid)]) })
    });
    const binLabel = ([lo, hi]) => hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`;
    setCard('aovdist', {
        title: '订单金额分布', sub: `客单价 ${isFinite(oc.aov) ? fmtMoney(oc.aov) : '—'}`,
        draw: (b, w) => columnChart(b, w, { labels: AOV_BINS.map(binLabel), values: oc.aovBins, fmt: (v, axis) => axis ? fmtCompact(v) : fmtInt(v) + ' 单', tipTitle: i => '订单金额 ' + binLabel(AOV_BINS[i]), labelEvery: 1, color: 'var(--series-3)' }),
        table: () => ({ head: ['订单金额', '订单数', '占比'], num: [1, 2], rows: AOV_BINS.map((bn, i) => [binLabel(bn), fmtInt(oc.aovBins[i]), fmtPct(oc.aovBins[i] / (oc.valid || 1))]) })
    });
}
function renderVideos(vc, vp, range) {
    const ds = dayList(range);
    setCard('vdaily', {
        title: '每日发布视频', sub: '出单视频 = 带来至少 1 笔订单的视频',
        legend: [{ name: '发布视频', color: 'var(--series-1)', line: true }, { name: '出单视频', color: 'var(--series-2)', line: true }],
        draw: (b, w) => lineChart(b, w, {
            labels: ds.map(md), fmt: (v, axis) => axis ? fmtCompact(v) : fmtInt(v) + ' 条', tipTitle: i => ds[i], height: 200,
            series: [{ name: '发布视频', color: 'var(--series-1)', values: ds.map(d => vc.byDay.get(d).posted) }, { name: '出单视频', color: 'var(--series-2)', values: ds.map(d => vc.byDay.get(d).selling) }]
        }),
        table: () => ({ head: ['日期', '发布视频', '出单视频', '视频 GMV'], num: [1, 2, 3], rows: ds.map(d => { const v = vc.byDay.get(d); return [d, fmtInt(v.posted), fmtInt(v.selling), fmtMoney(v.gmv)]; }) })
    });
    const cs = [...vc.creators.values()].sort((a, b) => b.gmv - a.gmv || b.views - a.views);
    setCard('creators', {
        title: '达人 GMV 排行', sub: '前 10',
        draw: b => barList(b, cs.slice(0, 10).map(c => ({ label: c.name, href: 'https://www.tiktok.com/@' + encodeURIComponent(c.name), sub: `${fmtInt(c.videos)} 条视频 · ${fmtCompact(c.views)} 播放`, value: c.gmv,
            tip: [{ label: 'GMV', value: fmtMoney(c.gmv) }, { label: '视频', value: fmtInt(c.videos) }, { label: '出单视频', value: fmtInt(c.selling) }, { label: '播放', value: fmtInt(c.views) }, { label: '订单', value: fmtInt(c.orders) }] })), { fmt: fmtMoney0, color: 'var(--series-1)' }),
        table: () => ({ head: ['达人', '视频', '出单视频', '播放', '订单', 'GMV'], num: [1, 2, 3, 4, 5], rows: cs.map(c => [c.name, fmtInt(c.videos), fmtInt(c.selling), fmtInt(c.views), fmtInt(c.orders), fmtMoney(c.gmv)]) })
    });
    const steps = [['播放', vc.views], ['商品曝光', vc.imp], ['商品点击', vc.clicks], ['订单', vc.orders]];
    setCard('vfunnel', {
        title: '视频转化', sub: '这段时间发布的视频合计',
        draw: b => barList(b, steps.map(([k, v], i) => ({ label: k, sub: i ? `上一步的 ${fmtPct(steps[i - 1][1] ? v / steps[i - 1][1] : NaN)}` : '', value: v, tip: [{ label: k, value: fmtInt(v) }] })), { fmt: v => fmtCompact(v), color: 'var(--series-3)' }),
        table: () => ({ head: ['环节', '数量', '占上一步'], num: [1, 2], rows: steps.map(([k, v], i) => [k, fmtInt(v), i ? fmtPct(steps[i - 1][1] ? v / steps[i - 1][1] : NaN) : '']) })
    });
    const tv = vc.list.slice().sort((a, b) => b.gmv - a.gmv || b.views - a.views).slice(0, 15);
    setCard('videos', {
        title: '视频 GMV 排行', sub: '前 15',
        draw: b => {
            if (!tv.length) { b.innerHTML = '<div class="empty">这段时间没有发布的视频</div>'; return; }
            b.innerHTML = `<div class="tablewrap"><table><thead><tr><th>#</th><th>视频</th><th class="n">播放</th><th class="n">点击率</th><th class="n">订单</th><th class="n">GMV</th></tr></thead><tbody>${tv.map((v, i) =>
                `<tr><td>${i + 1}</td><td><a href="https://www.tiktok.com/@${encodeURIComponent(v.creator)}/video/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.creator)}</a> <span class="s">${md(v.day)}</span><div class="s">${esc((v.info || '').slice(0, 80))}</div></td><td class="n">${fmtInt(v.views)}</td><td class="n">${fmtPct(v.imp ? v.clicks / v.imp : NaN)}</td><td class="n">${fmtInt(v.orders)}</td><td class="n">${fmtMoney(v.gmv)}</td></tr>`).join('')}</tbody></table></div>`;
        }
    });
}
function clearKind(keys, text) { for (const k of keys) { cards.delete(k); const el = document.querySelector(`[data-card="${k}"]`); if (el) el.innerHTML = `<div class="empty">${text}</div>`; } }

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
    $('range').textContent = `${range[0]} 至 ${range[1]},共 ${days(...range)} 天 · 对比上期 ${prev[0]} 至 ${prev[1]}`;
    $('reload').disabled = true;
    $('out').classList.add('loading');   // 刷新时保留旧画面、降低透明度,不闪
    try {
        reading.clear();
        const t0 = performance.now();
        const [orders, videos] = await Promise.all([readSource('order', prev[0]), readSource('video', prev[0])]);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        msg(''); progress(null);
        const loaded = [...reading.values()].reduce((s, p) => s + p.n, 0);
        if (loaded) $('range').textContent += ` · 读取 ${fmtInt(loaded)} 行,${secs} 秒`;
        $('out').hidden = false;
        const oc = orders && orderStats(orders, range), op = orders && orderStats(orders, prev);
        const vc = videos && videoStats(videos, range), vp = videos && videoStats(videos, prev);
        renderKpis(oc, op, vc, vp, range);
        insights(oc, op, vc, vp, range);
        if (oc) renderOrders(oc, op, range, prev); else clearKind(['sales', 'orders', 'status', 'heat', 'sku', 'state', 'aovdist'], '没有选择订单数据');
        if (vc) renderVideos(vc, vp, range); else clearKind(['vdaily', 'creators', 'vfunnel', 'videos'], '没有选择视频数据');
        const lbl = [$('srcOrder'), $('srcVideo')].map(s => s.selectedIndex > 0 ? s.options[s.selectedIndex].text.replace(/\s*\(\d+ 张表\)$/, '') : '').filter(Boolean);
        $('eyebrow').textContent = lbl.length ? [...new Set(lbl)].join(' / ') : 'TikTok Shop';
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
        bitable.bridge.onThemeChange(ev => { document.documentElement.dataset.theme = /dark/i.test((ev && ev.data && ev.data.theme) || '') ? 'dark' : 'light'; cards.forEach((_, k) => paintCard(k)); });
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
