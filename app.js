// 店铺周报看板 · 飞书多维表格扩展脚本
// 用飞书官方 Base JS SDK 读当前多维表格(读的是打开表格的人自己的权限,不需要 App Secret)
import { bitable } from 'https://cdn.jsdelivr.net/npm/@lark-base-open/js-sdk@1.0.2/dist/index.mjs';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Math.round(n || 0).toLocaleString('en-US');
const fmtMoney = n => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const LS = 'shop_dash_v1';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } };
const save = p => { try { localStorage.setItem(LS, JSON.stringify(Object.assign(load(), p))); } catch (e) {} };

/* ---------- 日期 ---------- */
// 表格里的日期 = 当地时间按 GMT+8 存(和导出插件一致),所以 +8 小时取出来就是导出里的日期
const dayOf = ms => (typeof ms === 'number' && ms > 0) ? new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) : '';
const shift = (s, d) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) + 1;
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
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

/* ---------- 读表 ---------- */
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
const cache = new Map();   // tableId -> rows(按字段名取值的对象数组)
async function readTable(tableId, wanted, onPage) {
    if (cache.has(tableId)) return cache.get(tableId);
    const table = await bitable.base.getTableById(tableId);
    const metas = await table.getFieldMetaList();
    const byName = new Map(metas.map(m => [m.name, m.id]));
    // 带币种的列名(如 "Video GMV ($)")按前缀匹配
    const ids = wanted.map(w => [w, byName.get(w) || (metas.find(m => m.name.startsWith(w + ' (')) || {}).id]).filter(x => x[1]);
    const rows = [];
    let pageToken, total = 0;
    do {
        const res = await table.getRecordsByPage({ pageSize: 200, pageToken });
        total = res.total || total;
        for (const r of res.records) {
            const o = {};
            for (const [w, id] of ids) o[w] = r.fields[id];
            rows.push(o);
        }
        pageToken = res.hasMore ? res.pageToken : undefined;
        onPage && onPage(rows.length, total);
    } while (pageToken);
    cache.set(tableId, rows);
    return rows;
}

const ORDER_COLS = ['Order ID', 'Order Status', 'Created Time', 'Quantity', 'Order Amount', 'Seller SKU', 'Product Name', 'Variation'];
const VIDEO_COLS = ['Video ID', 'Creator name', 'Creator ID', 'Video Info', 'Time', 'Video views', 'Attributed SKU orders', 'Video-attributed GMV', 'Video-attributed items sold'];

/* ---------- 数据源选项 ---------- */
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

/* ---------- 统计 ---------- */
function orderStats(rows, [a, b]) {
    const orders = new Map();
    const sku = new Map();
    const byDay = new Map();
    let qty = 0;
    for (const r of rows) {
        const d = dayOf(cellNum(r['Created Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Order ID']).trim();
        if (!id) continue;
        const canceled = /cancel/i.test(cellText(r['Order Status']));
        if (!orders.has(id)) orders.set(id, { amount: cellNum(r['Order Amount']), canceled, day: d });
        const q = cellNum(r['Quantity']);
        if (!canceled) {
            qty += q;
            const key = cellText(r['Seller SKU']) || cellText(r['Product Name']);
            const s = sku.get(key) || { name: cellText(r['Product Name']), variation: cellText(r['Variation']), qty: 0, orders: new Set() };
            s.qty += q; s.orders.add(id); sku.set(key, s);
        }
    }
    let valid = 0, sales = 0, canceled = 0;
    for (const o of orders.values()) {
        const dd = byDay.get(o.day) || { orders: 0, sales: 0 };
        if (o.canceled) canceled++;
        else { valid++; sales += o.amount; dd.orders++; dd.sales += o.amount; }
        byDay.set(o.day, dd);
    }
    return { all: orders.size, valid, canceled, sales, qty, aov: valid ? sales / valid : NaN, cancelRate: orders.size ? canceled / orders.size : NaN, byDay, sku };
}
function videoStats(rows, [a, b]) {
    const vids = new Map();
    for (const r of rows) {
        const d = dayOf(cellNum(r['Time']) || null);
        if (!d || d < a || d > b) continue;
        const id = cellText(r['Video ID']).trim();
        if (!id || vids.has(id)) continue;
        vids.set(id, {
            id, day: d, creator: cellText(r['Creator name']), creatorId: cellText(r['Creator ID']), info: cellText(r['Video Info']),
            views: cellNum(r['Video views']), orders: cellNum(r['Attributed SKU orders']), gmv: cellNum(r['Video-attributed GMV']), items: cellNum(r['Video-attributed items sold'])
        });
    }
    const list = [...vids.values()];
    const creators = new Map();
    for (const v of list) {
        const c = creators.get(v.creatorId || v.creator) || { name: v.creator, videos: 0, gmv: 0, views: 0, orders: 0 };
        c.videos++; c.gmv += v.gmv; c.views += v.views; c.orders += v.orders;
        creators.set(v.creatorId || v.creator, c);
    }
    const sum = k => list.reduce((s, v) => s + v[k], 0);
    return { list, count: list.length, views: sum('views'), gmv: sum('gmv'), orders: sum('orders'), selling: list.filter(v => v.orders > 0).length, creators };
}

/* ---------- 渲染 ---------- */
function delta(cur, prev, lowerIsBetter) {
    if (!isFinite(cur) || !isFinite(prev) || prev === 0) return '<div class="d flat">上期 —</div>';
    const r = (cur - prev) / Math.abs(prev);
    const good = lowerIsBetter ? r < 0 : r > 0;
    const cls = Math.abs(r) < 0.0005 ? 'flat' : good ? 'up' : 'down';
    return `<div class="d ${cls}">${r > 0 ? '▲' : r < 0 ? '▼' : ''} ${Math.abs(r * 100).toFixed(1)}% <span style="color:var(--sub)">较上期</span></div>`;
}
const kpi = (k, v, d) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div>${d}</div>`;
function renderOrders(cur, prev, range) {
    $('orderKpis').innerHTML = [
        kpi('有效订单', fmtInt(cur.valid), delta(cur.valid, prev.valid)),
        kpi('销售额(不含取消)', fmtMoney(cur.sales), delta(cur.sales, prev.sales)),
        kpi('售出件数', fmtInt(cur.qty), delta(cur.qty, prev.qty)),
        kpi('客单价', isFinite(cur.aov) ? fmtMoney(cur.aov) : '—', delta(cur.aov, prev.aov)),
        kpi('取消订单', `${fmtInt(cur.canceled)} <small style="font-size:12px;color:var(--sub)">${fmtPct(cur.cancelRate)}</small>`, delta(cur.cancelRate, prev.cancelRate, true))
    ].join('');
    // 每日柱状(订单数)+ 折线(销售额)
    const ds = []; for (let d = range[0]; d <= range[1]; d = shift(d, 1)) ds.push(d);
    const W = 640, H = 200, L = 34, R = 44, T = 10, B = 26, n = ds.length;
    const vals = ds.map(d => cur.byDay.get(d) || { orders: 0, sales: 0 });
    const maxO = Math.max(1, ...vals.map(v => v.orders)), maxS = Math.max(1, ...vals.map(v => v.sales));
    const bw = (W - L - R) / n;
    const x = i => L + bw * i + bw / 2, yO = v => T + (H - T - B) * (1 - v / maxO), yS = v => T + (H - T - B) * (1 - v / maxS);
    const step = Math.ceil(n / 10);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日订单与销售额">`;
    for (let k = 0; k <= 4; k++) { const y = T + (H - T - B) * k / 4; svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`; svg += `<text x="${L - 4}" y="${y + 3}" text-anchor="end">${fmtInt(maxO * (1 - k / 4))}</text><text x="${W - R + 4}" y="${y + 3}">${'$' + fmtInt(maxS * (1 - k / 4))}</text>`; }
    vals.forEach((v, i) => {
        const h = (H - T - B) - (yO(v.orders) - T);
        svg += `<rect x="${x(i) - bw * 0.32}" y="${yO(v.orders)}" width="${bw * 0.64}" height="${Math.max(0, h)}" rx="2" fill="var(--bar-2)"><title>${ds[i]}:${v.orders} 单,${fmtMoney(v.sales)}</title></rect>`;
        if (i % step === 0) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${ds[i].slice(5)}</text>`;
    });
    svg += `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${vals.map((v, i) => `${x(i)},${yS(v.sales)}`).join(' ')}"/>`;
    vals.forEach((v, i) => { svg += `<circle cx="${x(i)}" cy="${yS(v.sales)}" r="2.5" fill="var(--accent)"><title>${ds[i]}:${fmtMoney(v.sales)}</title></circle>`; });
    svg += '</svg>';
    $('orderChart').innerHTML = `<div class="legend"><span><i style="background:var(--bar-2)"></i>有效订单数(左轴)</span><span><i style="background:var(--accent)"></i>销售额(右轴)</span></div>` + svg;
    const top = [...cur.sku.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 10);
    $('topSku').innerHTML = top.length ? `<table><thead><tr><th>#</th><th>SKU</th><th class="n">件数</th><th class="n">订单</th></tr></thead><tbody>${top.map(([k, s], i) =>
        `<tr><td>${i + 1}</td><td>${esc(k)}<div class="s">${esc((s.name || '').slice(0, 60))}${s.variation ? ' · ' + esc(s.variation) : ''}</div></td><td class="n">${fmtInt(s.qty)}</td><td class="n">${fmtInt(s.orders.size)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">这段时间没有订单</div>';
}
function renderVideos(cur, prev) {
    $('videoKpis').innerHTML = [
        kpi('发布视频', fmtInt(cur.count), delta(cur.count, prev.count)),
        kpi('出单视频', `${fmtInt(cur.selling)} <small style="font-size:12px;color:var(--sub)">${fmtPct(cur.selling / cur.count)}</small>`, delta(cur.selling, prev.selling)),
        kpi('播放量', fmtInt(cur.views), delta(cur.views, prev.views)),
        kpi('视频归因 GMV', fmtMoney(cur.gmv), delta(cur.gmv, prev.gmv)),
        kpi('视频归因订单', fmtInt(cur.orders), delta(cur.orders, prev.orders)),
        kpi('发视频达人', fmtInt(cur.creators.size), delta(cur.creators.size, prev.creators.size))
    ].join('');
    const tc = [...cur.creators.values()].sort((a, b) => b.gmv - a.gmv || b.views - a.views).slice(0, 10);
    $('topCreator').innerHTML = tc.length ? `<table><thead><tr><th>#</th><th>达人</th><th class="n">视频</th><th class="n">播放</th><th class="n">GMV</th></tr></thead><tbody>${tc.map((c, i) =>
        `<tr><td>${i + 1}</td><td><a href="https://www.tiktok.com/@${encodeURIComponent(c.name)}" target="_blank" rel="noopener">${esc(c.name)}</a></td><td class="n">${fmtInt(c.videos)}</td><td class="n">${fmtInt(c.views)}</td><td class="n">${fmtMoney(c.gmv)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">这段时间没有发布的视频</div>';
    const tv = cur.list.slice().sort((a, b) => b.gmv - a.gmv || b.views - a.views).slice(0, 10);
    $('topVideo').innerHTML = tv.length ? `<table><thead><tr><th>#</th><th>视频</th><th class="n">播放</th><th class="n">订单</th><th class="n">GMV</th></tr></thead><tbody>${tv.map((v, i) =>
        `<tr><td>${i + 1}</td><td><a href="https://www.tiktok.com/@${encodeURIComponent(v.creator)}/video/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.creator)}</a> <span class="s">${v.day}</span><div class="s">${esc((v.info || '').slice(0, 50))}</div></td><td class="n">${fmtInt(v.views)}</td><td class="n">${fmtInt(v.orders)}</td><td class="n">${fmtMoney(v.gmv)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">这段时间没有发布的视频</div>';
}

/* ---------- 主流程 ---------- */
const state = Object.assign({ period: 'lastweek', custom: null }, load());
let srcOpts = { order: [], video: [] };
let refreshTables = async () => {};
function rebuildSources() {
    srcOpts = { order: sources('order'), video: sources('video') };
    fillSelect($('srcOrder'), srcOpts.order, $('srcOrder').value || load().srcOrder, /订单/);
    fillSelect($('srcVideo'), srcOpts.video, $('srcVideo').value || load().srcVideo, /视频/);
}
function msg(t, err) { $('msg').hidden = !t; $('msg').textContent = t || ''; $('msg').className = 'msg' + (err ? ' err' : ''); }
function progress(p) { const el = $('progress'); el.classList.toggle('show', p != null && p < 1); el.firstElementChild.style.width = ((p || 0) * 100) + '%'; }

async function readSource(kind) {
    const v = $(kind === 'order' ? 'srcOrder' : 'srcVideo').value;
    const opt = srcOpts[kind].find(o => o.v === v);
    if (!opt) return null;
    const rows = [];
    for (const id of opt.ids) {
        const name = (tables.find(t => t.id === id) || {}).name || id;
        rows.push(...await readTable(id, kind === 'order' ? ORDER_COLS : VIDEO_COLS, (n, total) => {
            msg(`正在读取「${name}」… ${fmtInt(n)} / ${fmtInt(total)} 行`);
            progress(total ? n / total : 0);
        }));
    }
    return rows;
}
async function refresh() {
    const range = periodOf(state.period, state.custom), prev = prevOf(range);
    document.querySelectorAll('.pill').forEach(b => b.classList.toggle('on', b.dataset.p === state.period));
    $('custom').classList.toggle('show', state.period === 'custom');
    $('range').textContent = `统计 ${range[0]} ~ ${range[1]}(${days(...range)} 天),对比上期 ${prev[0]} ~ ${prev[1]}`;
    $('reload').disabled = true;
    try {
        const [orders, videos] = [await readSource('order'), await readSource('video')];
        msg(''); progress(null);
        $('out').hidden = false;
        if (orders) renderOrders(orderStats(orders, range), orderStats(orders, prev), range);
        else { $('orderKpis').innerHTML = '<div class="empty">没有选择订单数据</div>'; $('orderChart').innerHTML = ''; $('topSku').innerHTML = ''; }
        if (videos) renderVideos(videoStats(videos, range), videoStats(videos, prev));
        else { $('videoKpis').innerHTML = '<div class="empty">没有选择视频数据</div>'; $('topCreator').innerHTML = ''; $('topVideo').innerHTML = ''; }
    } catch (e) {
        progress(null);
        msg('读取失败:' + (e && e.message || e), true);
    } finally { $('reload').disabled = false; }
}

async function init() {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
    try {
        tables = await Promise.race([bitable.base.getTableMetaList(), timeout]);
    } catch (e) {
        msg('没有连上多维表格。请在飞书多维表格里通过「扩展脚本 → 新增脚本」打开这个页面,而不是直接在浏览器里打开。', true);
        return;
    }
    try {
        const th = await bitable.bridge.getTheme();
        document.documentElement.dataset.theme = /dark/i.test(th) ? 'dark' : 'light';
        bitable.bridge.onThemeChange(ev => { document.documentElement.dataset.theme = /dark/i.test((ev && ev.data && ev.data.theme) || '') ? 'dark' : 'light'; });
    } catch (e) {}
    rebuildSources();
    // 表格里新增 / 删除子表时自动更新下拉框;新分表(如 订单_店铺ID_2)会自动并入对应店铺
    const onTablesChanged = async () => {
        try {
            const before = JSON.stringify([srcOpts.order, srcOpts.video].map(l => l.map(o => o.v + o.ids)));
            tables = await bitable.base.getTableMetaList();
            rebuildSources();
            if (JSON.stringify([srcOpts.order, srcOpts.video].map(l => l.map(o => o.v + o.ids))) !== before) { msg('检测到子表有变化,已更新列表'); refresh(); }
        } catch (e) {}
    };
    try { bitable.base.onTableAdd(onTablesChanged); bitable.base.onTableDelete(onTablesChanged); } catch (e) {}
    window.addEventListener('focus', onTablesChanged);   // 改了表名等情况,切回看板时再检查一次
    refreshTables = onTablesChanged;
    if (state.custom) { $('cs').value = state.custom[0]; $('ce').value = state.custom[1]; }
    // 订单 / 视频选同一个店铺(或「全部合计」)时联动
    const link = (from, to) => {
        const v = $(from).value;
        if ((v.startsWith('shop:') || v === 'all') && [...$(to).options].some(o => o.value === v)) $(to).value = v;
        save({ srcOrder: $('srcOrder').value, srcVideo: $('srcVideo').value });
        refresh();
    };
    $('srcOrder').onchange = () => link('srcOrder', 'srcVideo');
    $('srcVideo').onchange = () => link('srcVideo', 'srcOrder');
    $('pills').onclick = e => {
        const b = e.target.closest('.pill'); if (!b) return;
        state.period = b.dataset.p; save({ period: state.period });
        if (state.period !== 'custom' || state.custom) refresh(); else $('custom').classList.add('show');
    };
    $('apply').onclick = () => {
        const c = [$('cs').value, $('ce').value];
        if (!c[0] || !c[1] || c[0] > c[1]) { msg('请选择有效的开始和结束日期', true); return; }
        state.custom = c; save({ custom: c, period: 'custom' }); state.period = 'custom'; refresh();
    };
    $('reload').onclick = async () => { cache.clear(); await refreshTables(); refresh(); };
    refresh();
}
init();
