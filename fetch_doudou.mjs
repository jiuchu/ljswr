// 抖音剧集榜 + 小红书剧集榜 —— 两京十五日。
//
// 一个口，匿名 GET，回包带 Access-Control-Allow-Origin:* 和 no-store：
//   GET https://doudou.txw.hair/api/data
//
// 这一发回 45 万字节，里面绝大多数是另一部剧的逐 5 分钟历史格子，本剧要的那几行
// 全在 latest 底下：dyBoards 三张（实时/日/周，各 20 条）+ xhsBoards 一张（10 条）。
// 所以这里只切本剧那一行 + 榜头字样 + 前三名，落成一个 2 KB 上下的档案。
//
// 榜名和时段字样一律照抄回包自己给的：dyBoardsMeta 的 name、dyMeta 的 headLabel
// （"小时榜 17:00 - 18:00"）、activeText、xhsBoards.statDate —— 不自造名词。
//
// 名次取哪个字段：抖音那三张给 officialRank（第 11 名起官方不给名次、按热度补齐，
// 页上那句「第 11 名起抖音官方未给出名次」就是这么来的），小红书那张给 rank。
// 两个都照抄，不自己数下标。
//
// 环境变量：DD_OUT(默认 doudou.json) DD_TITLE(默认 两京十五日)
//           DD_KEEP(默认 72，小时档攒 3 天) DD_PROBE=1 取数打印不写文件

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://doudou.txw.hair/api/data';
const OUT = process.env.DD_OUT || path.join(HERE, 'doudou.json');
const TITLE = process.env.DD_TITLE || '两京十五日';
const KEEP = Number(process.env.DD_KEEP || 72);
const PROBE = process.env.DD_PROBE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const p2 = n => String(n).padStart(2, '0');
const bjStamp = d => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`;
};

async function pull() {
  const t0 = Date.now();
  const r = await fetch(API, {
    headers: { 'User-Agent': UA, Referer: 'https://doudou.txw.hair/', Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(90000),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${txt.slice(0, 80)}`);
  if (/^\s*</.test(txt)) throw new Error('回的是页面，不是数据');
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`回包不是 JSON：${txt.slice(0, 80)}`); }
  if (!j.latest) throw new Error('回包里没有 latest 那层');
  console.log(`取回 ${(txt.length / 1024).toFixed(0)} KB · 用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  return j;
}

/* 抖音那三张榜：榜名从 dyBoardsMeta 抄，时段字样从 dyMeta 抄。 */
function dyBoards(j) {
  const names = new Map((j.dyBoardsMeta || []).map(x => [x.id, x.name]));
  return (j.dyBoardsMeta || []).map(b => {
    const box = (j.latest.dyBoards || {})[b.id] || {};
    const items = box.items || [];
    const meta = (j.latest.dyMeta || {})[b.id] || {};
    const hit = items.find(x => x.title === TITLE);
    // 官方没给名次的那几行（第 11 名起）不参与「本剧第几名」，只当榜内条数看。
    return {
      id: b.id,
      name: names.get(b.id) || b.name,
      label: meta.headLabel || '',
      range: meta.rangeText || '',
      active: meta.activeText || '',
      version: meta.version ?? null,
      size: items.length,
      rank: hit ? (hit.officialRank ?? hit.rank ?? null) : null,
      score: hit ? hit.score ?? null : null,
      wannaSee: hit ? hit.wannaSee ?? null : null,
      comments: hit ? hit.comments ?? null : null,
      episodes: hit ? hit.episodes ?? null : null,
      actors: hit ? hit.actors || '' : '',
      tags: hit ? hit.tags || '' : '',
      releaseDate: hit ? hit.releaseDate || '' : '',
      top: items.slice(0, 3).map(x => ({ title: x.title, score: x.score ?? null })),
    };
  });
}

function xhsBoard(j) {
  const box = (j.latest.xhsBoards || {}).xhsTv || {};
  const items = box.items || [];
  const name = ((j.xhsBoardsMeta || []).find(x => x.id === 'xhsTv') || {}).name || '';
  const hit = items.find(x => x.title === TITLE);
  return {
    name,
    statDate: box.statDate || '',
    size: items.length,
    rank: hit ? hit.rank ?? null : null,
    score: hit ? hit.score ?? null : null,
    discuss: hit ? hit.discuss ?? null : null,
    totalView: hit ? hit.totalView ?? null : null,
    totalDiscuss: hit ? hit.totalDiscuss ?? null : null,
    trend: hit ? hit.trend || '' : '',
    rankDelta: hit ? hit.rankDelta ?? null : null,
    actors: hit ? hit.actors || '' : '',
    tags: hit ? hit.tags || '' : '',
    top: items.slice(0, 3).map(x => ({ title: x.title, score: x.score ?? null })),
  };
}

/* 小时档按 label 累加（同一小时重拍只覆盖那一条），日档按 statDate 累加。 */
function keepBy(oldList, fresh, key, cap) {
  const map = new Map((oldList || []).map(x => [x[key], x]));
  if (fresh[key]) map.set(fresh[key], fresh);
  return [...map.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key]))).slice(-cap);
}

async function main() {
  const j = await pull();
  const dy = dyBoards(j);
  const xhs = xhsBoard(j);
  const rt = dy.find(x => x.id === 'dyRealTime') || {};
  if (PROBE) {
    dy.forEach(b => console.log(`  ${b.name} ${b.label} 本剧第 ${b.rank ?? '—'} 名 · 热度 ${b.score ?? '—'} · 榜内 ${b.size} 条`));
    console.log(`  ${xhs.name} ${xhs.statDate} 本剧第 ${xhs.rank ?? '—'} 名 · 当日浏览 ${xhs.score ?? '—'} · 讨论 ${xhs.discuss ?? '—'}`);
    return;
  }

  let old = null;
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 第一拍没有底本 */ }
  const at = new Date();
  const out = {
    title: TITLE,
    at: bjStamp(at),
    fetchedAt: at.toISOString(),
    runs: (old?.runs || 0) + 1,
    dy,
    xhs,
    hourly: keepBy(old?.hourly, {
      hour: rt.label || bjStamp(at).slice(11, 16),
      at: at.toISOString(),
      rank: rt.rank ?? null,
      score: rt.score ?? null,
    }, 'hour', KEEP),
    daily: keepBy(old?.daily, {
      date: xhs.statDate || bjStamp(at).slice(0, 10),
      xhsRank: xhs.rank ?? null,
      xhsScore: xhs.score ?? null,
      dyDailyRank: (dy.find(x => x.id === 'dyDaily') || {}).rank ?? null,
      dyDailyScore: (dy.find(x => x.id === 'dyDaily') || {}).score ?? null,
    }, 'date', 60),
    lastError: '',
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`写 ${path.basename(OUT)} · 小时档 ${out.hourly.length} 格 · 日档 ${out.daily.length} 天`);
  dy.forEach(b => console.log(`  ${b.name} ${b.label} → 本剧${b.rank == null ? '不在榜' : `第 ${b.rank} 名`} · ${b.score ?? '—'}`));
  console.log(`  ${xhs.name} ${xhs.statDate} → 本剧${xhs.rank == null ? '不在榜' : `第 ${xhs.rank} 名`} · 当日浏览 ${xhs.score ?? '—'}`);
}

main().catch(e => {
  const msg = String(e?.message || e);
  console.log(`::error::剧集榜取数失败：${msg}`);
  if (PROBE) return;
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (old.lastError !== msg) { old.lastError = msg; fs.writeFileSync(OUT, JSON.stringify(old, null, 2) + '\n'); }
    console.log('旧档案没动，原因记在 lastError');
  } catch { console.log('档案是空的，这次没留下东西'); }
  process.exit(1);
});
