// 《两京十五日》德塔文：景气指数（当日全榜 + 自攒日序列）+ 剧集付费力榜。
// 站点自己就是匿名 JSON 接口，历史能追到 2018-08-06，所以日序列不需要每天敲 history —— 一天一发 /api/indices 自己攒。
// 用法：node fetch_detawen.mjs            当日采集 + 并入序列
//       node fetch_detawen.mjs --backfill 2026-10-01 2026-11-19   一次性回补（只在建档那天跑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://www.datawinfilmtv.top';
const TITLE = '两京十五日';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAID_LABELS = ['观众包场', '云周边', '品牌广告', '主创投入'];

async function get(p) {
  const r = await fetch(BASE + p, { headers: { 'user-agent': UA } });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${p}`);
  return JSON.parse(await r.text());
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s).replace(/[\u200b-\u200f\u3000]/g, '').trim();
const pick = list => (list || []).find(x => clean(x.name) === TITLE) || null;
const pickPaid = rows => (rows || []).find(r => clean(r.name) === TITLE) || null;

function fold(row, board) {
  if (!row) return null;
  return {
    d: null, board, rank: row.rank, idx: row.index_value, trend: row.trend || '',
    platform: (row.platform && row.platform.display) || '',
    tv: (row.platform && row.platform.tv) || [],
    web: (row.platform && row.platform.web) || [],
    roles: (row.role_contributions || []).map(x => ({
      actor: x.actor_name, role: x.role_name,
      contribute: x.role_contribute, yiren: x.yiren_contribute,
    })),
  };
}

/* ---- 一次性回补：按天敲 history，只留本剧那一行 ---- */
async function backfill(from, to) {
  const file = path.join(HERE, 'detawen.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { series: [] };
  const byDay = new Map((prev.series || []).map(x => [x.d, x]));
  let hit = 0, miss = 0;
  for (let t = Date.parse(from + 'T00:00:00+08:00'); t <= Date.parse(to + 'T00:00:00+08:00'); t += 86400000) {
    const d = new Date(t + 8 * 3600000).toISOString().slice(0, 10);
    try {
      const j = await get('/api/indices/history/' + d);
      const on = pick(j.onair), up = pick(j.upcoming);
      const row = fold(on || up, on ? 'onair' : 'upcoming');
      if (row) { row.d = d; byDay.set(d, row); hit++; } else { miss++; }
    } catch (e) { miss++; }
    await sleep(600);
  }
  prev.series = [...byDay.values()].sort((a, b) => a.d < b.d ? -1 : 1);
  prev.backfill = { from, to, hit, miss, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(prev, null, 1));
  console.log(`回补 ${from}→${to}：命中 ${hit} 天、榜外 ${miss} 天，序列共 ${prev.series.length} 点`);
  const first = prev.series.find(x => x.board === 'onair');
  console.log(`首次进已播榜 ${first ? first.d + ' 指数 ' + first.idx + ' rank' + first.rank : '未见'}`);
}

/* ---- 当日采集 ---- */
async function today() {
  const ix = await get('/api/indices');
  const pp = await get('/api/paid-power-rank');
  const on = pick(ix.onair), up = pick(ix.upcoming);
  const mine = fold(on || up, on ? 'onair' : 'upcoming');
  const paidRow = pickPaid(pp.rows);

  const file = path.join(HERE, 'detawen.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { series: [] };
  const byDay = new Map((prev.series || []).map(x => [x.d, x]));
  const stamp = String(ix.real_date || ix.db_date || '');
  if (stamp && mine) { const row = { ...mine, d: stamp }; byDay.set(stamp, row); }

  const out = {
    title: TITLE, captured_at: new Date().toISOString(),
    stamp: { real_date: ix.real_date, real_time: ix.real_time, db_date: ix.db_date, update_time: ix.update_time },
    archive: { earliest: ix.earliest_date, latest: ix.latest_date, days: (ix.all_dates || []).length },
    board: {
      onair: (ix.onair || []).map(x => ({ rank: x.rank, name: x.name, idx: x.index_value, trend: x.trend })),
      upcoming: (ix.upcoming || []).map(x => ({ rank: x.rank, name: x.name, idx: x.index_value, trend: x.trend })),
    },
    mine,
    paid: {
      date: pp.latest_date, update_time: pp.update_time,
      labels: PAID_LABELS,
      rows: (pp.rows || []).map(r => ({ rank: r.rank, name: r.name, daily: r.daily_level, cumulative: r.cumulative_level })),
      mine: paidRow ? {
        rank: paidRow.rank, daily: paidRow.daily_level, cumulative: paidRow.cumulative_level,
        parts: PAID_LABELS.map((k, i) => ({ name: k, level: paidRow.levels[i] || '0', blocks: paidRow.blocks[i] || 0 })),
      } : null,
    },
    series: [...byDay.values()].sort((a, b) => a.d < b.d ? -1 : 1),
    backfill: prev.backfill || null,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 1));

  console.log(`${TITLE}  德塔文回话 ${out.stamp.real_date} ${out.stamp.real_time}`
    + ` | ${mine ? (mine.board === 'onair' ? '已播榜' : '待播榜') + ' rank' + mine.rank + ' 指数 ' + mine.idx + ' ' + (mine.trend || '-') : '不在两张榜上'}`
    + ` | 付费力榜 ${paidRow ? 'rank' + paidRow.rank + ' 日增' + paidRow.daily_level + ' 累计' + paidRow.cumulative_level : '未收录'}`
    + ` | 序列 ${out.series.length} 点 ${out.series[0]?.d || '-'}→${out.series[out.series.length - 1]?.d || '-'}`);
  if (mine && mine.roles.length) console.log('  角色贡献度：' + mine.roles.map(r => `${r.role}(${r.actor}) ${(r.contribute * 100).toFixed(1)}%`).join(' '));
}

const args = process.argv.slice(2);
if (args[0] === '--backfill') await backfill(args[1], args[2]);
else await today();
