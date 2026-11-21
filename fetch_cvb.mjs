// CVB（中国视听大数据，广电总局）黄金时段电视剧日榜 —— 两京十五日。
//
// 两个口，全匿名 GET、不要 cookie、不要签名：
//   GET /prod-api/cvb/dayrankings/datelist
//     → {total:7, rows:["2026-11-19","2026-11-18",…]} —— 只给最近 7 天，没有更深的历史口。
//   GET /prod-api/cvb/dayrankings/list?date=YYYY-MM-DD&pageSize=20
//     → {total:10, rows:[{sort,name,channel,episode,audienceRating,ratingShare,
//         broadcastType,provinceCode:"NATIONAL",date,createdAt,…}]}
//     收视率和份额是**带百分号的字符串**（"3.402%"），这里剥成数存；原样不留，
//     因为它和字段本身只差一个符号，留着只会让人猜哪个是准的。
//
// ⚠ 这个后端带跨域 Origin 头的请求一律 403「Invalid CORS request」（同源 Origin 和裸请求都 200），
//   所以浏览器直连是走不通的，只能由采集器写档案、页面只读档案。
//
// 落库时刻：11-19 那期 createdAt = 2026-11-20T09:14（T+1 早上九点一刻），
//   但 11-21 13:26 再看，datelist 最新仍是 11-19 —— 所以那个时刻只当观察值，别当承诺。
//   工作流一天两拍（09:30 / 21:30），早那拍接不住就有晚那拍兜。
//
// 榜只有 10 行（黄金时段电视剧），本剧没进榜不等于采集坏了，档案里单独存 inBoard。
//
// 环境变量：CVB_OUT(默认 cvb.json) CVB_NAME(默认 两京十五日) CVB_KEEP(默认 400)
//           CVB_HEARTBEAT(默认 50 分钟) CVB_PROBE=1 取数打印不写文件

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://www.cavbd.cn/prod-api/cvb/dayrankings/';
const OUT = process.env.CVB_OUT || path.join(HERE, 'cvb.json');
const NAME = process.env.CVB_NAME || '两京十五日';
const KEEP = Number(process.env.CVB_KEEP || 400);
const HEARTBEAT = Number(process.env.CVB_HEARTBEAT) || 50;
const PROBE = process.env.CVB_PROBE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const p2 = n => String(n).padStart(2, '0');
const bjParts = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric',
}).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
const bjStamp = d => { const p = bjParts(d); return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`; };
const bjDay = d => bjStamp(d).slice(0, 10);
const clean = s => String(s == null ? '' : s).replace(/[​-‏　]/g, '').trim();
const pct = s => { const n = parseFloat(String(s == null ? '' : s).replace('%', '')); return Number.isFinite(n) ? n : null; };

async function get(qs) {
  const r = await fetch(API + qs, {
    headers: { 'User-Agent': UA, Accept: 'application/json',
               Referer: 'https://www.cavbd.cn/information.html' },
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${txt.slice(0, 60)}`);
  let j; try { j = JSON.parse(txt); } catch { throw new Error(`响应不是 JSON（多半是被拦成页面）：${txt.slice(0, 60)}`); }
  if (j.code != null && j.code !== 200) throw new Error(`接口回 code=${j.code} msg=${j.msg || ''}`);
  return j;
}

/* 榜 → 本剧那一天。 */
export function pickRow(rows, name) {
  if (!Array.isArray(rows)) return { ok: false, msg: '榜不是数组（接口改了结构或被拦成页面）' };
  const hit = rows.find(x => clean(x.name) === name) || null;
  return { ok: true, row: hit, size: rows.length, top: rows[0] ? clean(rows[0].name) : '',
             names: rows.map(x => clean(x.name)) };
}

export function foldRow(row) {
  if (!row) return null;
  return {
    date: String(row.date), rank: row.sort, name: clean(row.name),
    rating: pct(row.audienceRating), share: pct(row.ratingShare),
    episode: clean(row.episode), channel: clean(row.channel),
  };
}

/* 追加同一天：值变了按「标错不删数据」留原值进 fixes，不静默覆盖。 */
export function mergeDays(oldDays, fresh, at) {
  const days = (Array.isArray(oldDays) ? oldDays : []).map(x => ({ ...x }));
  const fixes = [];
  const idx = new Map(days.map((x, i) => [x.date, i]));
  let changed = false;
  for (const f of fresh) {
    const i = idx.get(f.date);
    if (i == null) { days.push({ ...f, at }); changed = true; }
    else if (days[i].rating !== f.rating || days[i].share !== f.share || days[i].rank !== f.rank) {
      fixes.push({ date: f.date, from: `${days[i].rating}/${days[i].share}/第${days[i].rank}`,
                   to: `${f.rating}/${f.share}/第${f.rank}`, at });
      days[i] = { ...f, at, revisedAt: at }; changed = true;
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days: days.slice(-KEEP), fixes, changed };
}

export function needWrite(old, now, changed, heartbeatMin = 50) {
  const rollover = !old || old.atDay !== bjDay(now);
  const t = Date.parse(String((old && old.fetchedAt) || ''));
  const stale = !Number.isFinite(t) || (now.getTime() - t) >= heartbeatMin * 6e4;
  return { write: !!changed || rollover || stale, changed: !!changed, rollover, stale };
}

const old = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })();

const dl = await get('datelist');
const dates = (Array.isArray(dl.rows) ? dl.rows : []).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(String(x)));
if (!dates.length) { console.error('::error::CVB 日期清单是空的（接口改了或被拦）'); process.exit(1); }
const newest = dates[0];
const have = new Set((Array.isArray(old?.days) ? old.days : []).map(x => x.date));

/* 只补两类：最新那天（可能改口）+ 清单里档案还没有的。上限 7 发。 */
const todo = [...new Set([newest, ...dates.filter(d => !have.has(d))])].slice(0, 7);
const now = new Date(), at = bjStamp(now);
const fresh = [];
let newestBoard = null;
for (const d of todo) {
  const j = await get(`list?date=${d}&pageSize=20`);
  const found = pickRow(j.rows, NAME);
  if (!found.ok) { console.error(`::error::CVB ${d} 榜读不出：${found.msg}`); process.exit(1); }
  /* board 只记最新那期——todo 是从最新往旧走的，最后一发是最早的那天，别拿它当榜头 */
  if (d === newest) newestBoard = { date: d, size: found.size, inBoard: !!found.row, top: found.top };
  if (found.row) {
    fresh.push({ ...foldRow(found.row), at });
    console.log(`CVB 榜内 ${found.row.name}：${d} 收视率 ${found.row.audienceRating} `
      + `份额 ${found.row.ratingShare} 排第 ${found.row.sort} · ${found.row.channel} ${clean(found.row.episode)}`);
  } else {
    console.log(`CVB ${d} 那期 ${found.size} 行里没有《${NAME}》（榜首 ${found.top}）—— 记为未收录，不算采集失败`
      + (d === newest ? `；这一期榜内：${found.names.join('、')}` : ''));
  }
  if (d !== todo[todo.length - 1]) await new Promise(r => setTimeout(r, 400));
}

const m = mergeDays(old?.days, fresh, at);
const gate = needWrite(old, now, m.changed || !!fresh.length, HEARTBEAT);
const body = {
  name: NAME, at, atDay: bjDay(now), fetchedAt: now.toISOString(),
  runs: (Number(old?.runs) || 0) + 1,
  /* 上游只留最近 7 天，档案是唯一能往回看的东西；available 记下这次清单覆盖到哪天 */
  available: { from: dates[dates.length - 1], to: newest, days: dates.length },
  board: newestBoard || { date: newest, size: 0, inBoard: false, top: '' },
  inBoard: !!(newestBoard && newestBoard.inBoard),
  latest: fresh.length ? fresh[fresh.length - 1] : (m.days.length ? m.days[m.days.length - 1] : null),
  days: m.days,
  fixes: (Array.isArray(old?.fixes) ? old.fixes : []).concat(m.fixes),
};

console.log(`CVB · ${NAME} ${at} | 档案共 ${body.days.length} 天`
  + (body.days.length ? `：${body.days[0].date}→${body.days[body.days.length - 1].date}` : '（还一天没有）')
  + ` | 上游清单 ${body.available.from}→${body.available.to}（${body.available.days} 天）`
  + (m.fixes.length ? ` | 上游改口 ${m.fixes.map(f => `${f.date} ${f.from}→${f.to}`).join(' / ')}` : ''));

if (PROBE) { console.log('探测模式：不写文件。'); process.exit(0); }
if (!gate.write) { console.log(`没有新数据、没跨日、距上次写盘不到 ${HEARTBEAT} 分钟 —— 不写盘。`); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify(body, null, 2) + '\n');
console.log(`已写 ${OUT}（${m.changed ? '有新数' : !old ? '第一次建档' : gate.rollover ? '跨日' : '心跳'}）`);
