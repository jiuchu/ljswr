// 云合（enlightent）市占率 + 评级采集 —— 两京十五日。
//
// 一家口三个数，全匿名、无 cookie、无签名：
//   POST https://www.enlightent.cn/research/top/getReboTop.do  type=1&pageNo=1&pageSize=50
//   → 30 行（type/pageNo/pageSize 改了不给更多），每行
//     {reboRank,name,nameID,marketShare,releaseTime,dayPlatform,network,date,occurDays,status,
//      episodeUpdated:{maxIndex,notvipIndex,memberIndex},yunheLevel:[{date,level,minValue,diff,position,maxValue}]}
//   市占率在 marketShare，评级在 yunheLevel[].level —— 同一行，所以不需要反查 nameId。
//
//   POST /research/video/getLastLevel.do  nameId=<id>   → 本剧最近 1~2 天的档位（见下面 nameId 那段）
//   POST /research/top/getLevelStage.do   空 body        → 7 条 {date,level,minValue,maxValue}，
//     即各档「集均30天有效播放」的晋级线。这一发未打散（连敲两次全同、date 参数被忽略恒回最新），
//     是云合在匿名条件下唯一肯给的绝对数，存进档案的 stage 字段。
//
// 本剧 2026-11-20 首播，11-20 这拍跑还在 30 行外（榜是 T+1，11-19 那天的榜里没有它）。
// 榜外不等于采集坏了，所以档案里单独存 inBoard，页面要说得出这两件事的差别。
//
// nameID 一旦进榜就顺手记下来，之后 /research/video/getLastLevel.do?nameId= 能用它补档位历史。
// 那三个 minValue/maxValue/position 是未登录打散过的随机数（10-21 用《兰香如故》连测三次，
// level 三次全同、那三个数三次全不一样；11-21 在同一发榜里看到 C 档行的 minValue 是负数
// —— 播放量不可能为负，所以那是噪声不是低值），所以一个都不存。页面只拿字母去 stage 里查
// 晋级线，印的是「集均30天有效播放 ≥ X」这一句下界，不印点值。
//
// 日序列自己攒：接口只回最近 1~2 天，没有更深历史。读旧-追加-写新，和 billboard.json 一样。
//
// 环境变量：YUNHE_OUT(默认 yunhe.json) YUNHE_NAME(默认 两京十五日) YUNHE_KEEP(默认 400)
//           YUNHE_HEARTBEAT(默认 50 分钟) YUNHE_PROBE=1 取数打印不写文件

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REBO = 'https://www.enlightent.cn/research/top/getReboTop.do';
const LEVEL = 'https://www.enlightent.cn/research/video/getLastLevel.do';
const STAGE = 'https://www.enlightent.cn/research/top/getLevelStage.do';
const OUT = process.env.YUNHE_OUT || path.join(HERE, 'yunhe.json');
const NAME = process.env.YUNHE_NAME || '两京十五日';
const KEEP = Number(process.env.YUNHE_KEEP || 400);
const HEARTBEAT = Number(process.env.YUNHE_HEARTBEAT) || 50;
const PROBE = process.env.YUNHE_PROBE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const p2 = n => String(n).padStart(2, '0');
const bjParts = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric',
}).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
const bjStamp = d => { const p = bjParts(d); return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`; };
const bjDay = d => bjStamp(d).slice(0, 10);
const clean = s => String(s).replace(/[\u200b-\u200f\u3000]/g, '').trim();

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA,
               Referer: 'https://www.enlightent.cn/yunhe/rank-detail', Accept: 'application/json' },
    body, signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${txt.slice(0, 60)}`);
  try { return JSON.parse(txt); } catch { throw new Error(`响应不是 JSON：${txt.slice(0, 60)}`); }
}

export function pickRow(rows, name) {
  if (!Array.isArray(rows)) return { ok: false, msg: '榜不是数组（接口改了结构或被拦成页面）' };
  const hit = rows.find(x => clean(x.name) === name) || null;
  return { ok: true, row: hit, size: rows.length, top: rows[0] ? rows[0].name : '' };
}

/* 一行 → 一天。level 取 yunheLevel 里与 date 同天的那条，取不到就用第一条。 */
export function foldRow(row) {
  if (!row) return null;
  const lv = (Array.isArray(row.yunheLevel) ? row.yunheLevel : [])
    .filter(x => x && /^[A-Za-z][+-]?$/.test(String(x.level || '').trim()));
  const today = lv.find(x => x.date === row.date) || lv[0] || null;
  return {
    date: String(row.date), rank: row.reboRank, share: row.marketShare,
    level: today ? String(today.level).trim().toUpperCase() : '',
    occurDays: row.occurDays, dayPlatform: row.dayPlatform,
    nameId: row.nameID || null,
    ep: row.episodeUpdated ? { max: row.episodeUpdated.maxIndex ?? null, notvip: row.episodeUpdated.notvipIndex ?? null } : null,
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
    else if (days[i].share !== f.share || days[i].level !== f.level) {
      fixes.push({ date: f.date, from: `${days[i].share}/${days[i].level || '-'}`, to: `${f.share}/${f.level || '-'}`, at });
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

const rows = await post(REBO, 'type=1&pageNo=1&pageSize=50');
const found = pickRow(rows, NAME);
if (!found.ok) { console.error(`::error::云合榜读不出：${found.msg}`); process.exit(1); }
const now = new Date(), at = bjStamp(now);
let fresh = [];
if (found.row) {
  fresh = [foldRow(found.row)];
  console.log(`云合榜内 ${found.row.name}：${found.row.date} 市占 ${found.row.marketShare}% 排第 ${found.row.reboRank}`
    + ` 评级 ${(found.row.yunheLevel || []).map(x => `${x.date} ${x.level}`).join('、') || '还没出档'}`);
} else {
  console.log(`云合榜 30 行里没有《${NAME}》（榜是 T+1；当天榜首 ${found.top}）—— 记为未收录，不算采集失败`);
}

/* 进过榜拿到 nameId 之后，再单敲一次档位历史，把更早的档补进序列 */
const nameId = fresh[0]?.nameId || old?.nameId || null;
const extra = [];
if (nameId) {
  try {
    const j = await post(LEVEL, 'nameId=' + encodeURIComponent(nameId));
    for (const x of (Array.isArray(j) ? j : [])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))) continue;
      const lv = String(x.level || '').trim();
      if (!/^[A-Za-z][+-]?$/.test(lv)) continue;
      extra.push({ date: String(x.date), rank: null, share: null, level: lv.toUpperCase(), nameId });
    }
  } catch (e) { console.log(`getLastLevel 没取到（不影响榜那一行）：${e.message}`); }
}

const m = mergeDays(old?.days, [...extra, ...fresh], at);

/* 定级线：云合工具箱「定级线」那一页背后的口，匿名、未打散（同一发回包两次全同）。
   它给的是各档「集均30天有效播放」的区间，minValue 就是官方那句「各评级最后一名」那条晋级线。
   榜里那三个数（minValue/maxValue/position）是加过随机噪声的（C 档行会出负数），一个都不存；
   能存的只有这个口——所以它只用来把字母翻译成一句下界，不用来编点值。 */
let stage = null;
try {
  const s = await post(STAGE, '');
  const bands = {};
  for (const x of (Array.isArray(s) ? s : [])) {
    const lv = String(x.level || '').trim().toUpperCase();
    if (!/^[A-Z][+]?$/.test(lv)) continue;
    if (!Number.isFinite(+x.minValue) || !Number.isFinite(+x.maxValue)) continue;
    bands[lv] = { min: +x.minValue, max: +x.maxValue };
  }
  if (Object.keys(bands).length) {
    stage = { date: String(Array.isArray(s) && s[0] ? s[0].date : ''), bands };
  }
} catch (e) { console.log(`定级线没取到（不影响榜那一行）：${e.message}`); }
if (!stage && old && old.stage) stage = old.stage;   // 留上一份好的，页面那行会自己报它是哪天取的

const lvNow = fresh[0] && fresh[0].level ? fresh[0].level : (m.days.length ? m.days[m.days.length - 1].level : '');
const line = stage && lvNow && stage.bands[lvNow] ? stage.bands[lvNow].min : null;
if (line != null) console.log(`定级线 ${stage.date}：${lvNow} 级晋级线 ${line.toLocaleString('en-US')}（集均30天有效播放下界）`);

const gate = needWrite(old, now, m.changed || !!fresh.length, HEARTBEAT);
const body = {
  name: NAME, nameId, at, atDay: bjDay(now), fetchedAt: now.toISOString(),
  runs: (Number(old?.runs) || 0) + 1,
  board: { date: String(Array.isArray(rows) && rows[0] ? rows[0].date : ''), size: found.size, inBoard: !!found.row },
  inBoard: !!found.row,
  latest: fresh[0] || (m.days.length ? m.days[m.days.length - 1] : null),
  stage,
  days: m.days,
  fixes: (Array.isArray(old?.fixes) ? old.fixes : []).concat(m.fixes),
};

console.log(`云合 · ${NAME} ${at} | 档案共 ${body.days.length} 天`
  + (body.days.length ? `：${body.days[0].date}→${body.days[body.days.length - 1].date}` : '（还一天没有）')
  + (m.fixes.length ? ` | 上游改口 ${m.fixes.map(f => `${f.date} ${f.from}→${f.to}`).join(' / ')}` : ''));

if (PROBE) { console.log('探测模式：不写文件。'); process.exit(0); }
if (!gate.write) { console.log(`没有新数据、没跨日、距上次写盘不到 ${HEARTBEAT} 分钟 —— 不写盘。`); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify(body, null, 2) + '\n');
console.log(`已写 ${OUT}（${m.changed ? '有新数' : !old ? '第一次建档' : gate.rollover ? '跨日' : '心跳'}）`);
