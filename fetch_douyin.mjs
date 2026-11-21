// 抖音指数（原巨量算数）关键词走势 —— 两京十五日。
//
// 一个口，POST、只吃登录 cookie，不要 msToken / a_bogus：
//   POST https://creator.douyin.com/api/v2/index/get_multi_keyword_hot_trend
//     {keyword_list:["两京十五日"], start_date:"20261019", end_date:"20261119", app_name:"aweme"}
//   ⚠日期必须写成 8 位数字。带横线的写法回 200 + status:0，但正文只有 119 字节空壳，
//     是假成功；keyword_list 传字符串回 500，字段名写成 camelCase 回 422。
//
// 回包 data 是一段 base64 密文，响应用哪个钥匙看响应头 x-encrypted（这里见过 "2"）。
//   钥匙是两把写死的 AES-128-CBC key/iv，不在 header 里、也不随请求变 ——
//   两条不同请求的密文前 128 个字符完全相同，这就是静态钥匙的证据。
//   这张表来自公开实现（github.com/gallagherjas/everyone-content，
//   collector/sources/douyin-index/protocol.ts），本机拿真密文实测解开过。
//
// 口径（页面自己写的）：
//   搜索指数 = 关键词及其相关内容的搜索量加权，页面明写「并不等于实际搜索量」；
//   综合指数 = 内容量 + 搜索 + 观看 + 互动加权。两个都是绝对量级，不是 0–100 归一化。
//   窗口尾到 T-2：11-21 跑，最新一天是 11-19。
//
// 一次请求给 32 天，比窗口长，所以档案只按天累加、不重刷历史。
// 拉不到就不动旧档案，只把原因印出来。
//
// 环境变量：DY_COOKIE(必需) DY_OUT(默认 douyin.json) DY_KEYWORD(默认 两京十五日)
//           DY_DAYS(默认 30) DY_KEEP(默认 400) DY_PROBE=1 取数打印不写文件

import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_TREND = 'https://creator.douyin.com/api/v2/index/get_multi_keyword_hot_trend';
const OUT = process.env.DY_OUT || path.join(HERE, 'douyin.json');
const KW = process.env.DY_KEYWORD || '两京十五日';
const DAYS = Number(process.env.DY_DAYS || 30);
const KEEP = Number(process.env.DY_KEEP || 400);
const PROBE = process.env.DY_PROBE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const KEYS = {
  '1': ['kbSjOqn9O7APLqUZxdCkTQ==', 'JuhL1cOV5JH9ojzt2g2EPg=='],
  '2': ['SjXbYTJb7zXoUToSicUL3A==', 'OekMLjghRg8vlX/PemLc+Q=='],
};

const p2 = n => String(n).padStart(2, '0');
const bjParts = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric',
}).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
const bjStamp = d => { const p = bjParts(d); return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`; };
const bjDay = d => bjStamp(d).slice(0, 10);
const ymd8 = d => bjDay(d).replaceAll('-', '');

// 窗口尾落在 T-2；万一那天还没出数，回包给到哪一天就以哪一天为尾。
function windowEnd(now) {
  const d = new Date(now.getTime() - 2 * 86400000);
  return ymd8(d);
}
function shift8(s, n) {
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

function decrypt(b64, mode) {
  const pair = KEYS[String(mode)];
  if (!pair) throw new Error(`x-encrypted=${mode}，这把钥匙表里没有`);
  const [key, iv] = pair.map(v => Buffer.from(v, 'base64'));
  const c = createDecipheriv('aes-128-cbc', key, iv);
  const txt = Buffer.concat([c.update(Buffer.from(b64, 'base64')), c.final()]).toString('utf8');
  return JSON.parse(txt);
}

async function trend(cookie, start, end) {
  const r = await fetch(URL_TREND, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', appsource: 'PC',
      Cookie: cookie,
      Referer: 'https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/analysis',
      Origin: 'https://creator.douyin.com',
    },
    body: JSON.stringify({ keyword_list: [KW], start_date: start, end_date: end, app_name: 'aweme' }),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error(`登录态不认（HTTP ${r.status}）`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${txt.slice(0, 80)}`);
  if (/^\s*</.test(txt)) throw new Error('回的是页面，多半是登录跳走或被人机拦下');
  let j; try { j = JSON.parse(txt); } catch { throw new Error(`回包不是 JSON：${txt.slice(0, 80)}`); }
  if (Number(j.status) !== 0) throw new Error(`接口回 status=${j.status} msg=${j.msg || ''}`);
  const mode = r.headers.get('x-encrypted');
  if (!mode) return { body: j.data, mode: null };
  if (typeof j.data !== 'string') throw new Error(`说encrypted=${mode}但 data 不是字符串`);
  return { body: decrypt(j.data, mode), mode };
}

function toDays(body) {
  const hit = (body.hot_list || []).find(x => x.keyword === KW) || (body.hot_list || [])[0];
  if (!hit) throw new Error('回包里没有这一条关键词');
  const comp = new Map((hit.hot_list || []).map(x => [String(x.datetime), Number(x.index)]));
  const sear = new Map((hit.search_hot_list || []).map(x => [String(x.datetime), Number(x.index)]));
  const dates = [...new Set([...comp.keys(), ...sear.keys()])].sort();
  return {
    days: dates.map(d => ({ d, comp: comp.has(d) ? comp.get(d) : null, search: sear.has(d) ? sear.get(d) : null })),
    period: {
      date: dates.length ? dates[dates.length - 1] : null,
      compAvg: Number(hit.average?.average ?? NaN) || null,
      searchAvg: Number(hit.average?.search_average ?? NaN) || null,
      compPrevAvg: Number(hit.last_average?.average ?? NaN) || null,
      searchPrevAvg: Number(hit.last_average?.search_average ?? NaN) || null,
      compYearAvg: Number(hit.last_year_average?.average ?? NaN) || null,
      searchYearAvg: Number(hit.last_year_average?.search_average ?? NaN) || null,
    },
  };
}

function merge(old, fresh) {
  const map = new Map((old?.days || []).map(x => [String(x.d), x]));
  fresh.forEach(x => {
    const prev = map.get(x.d) || { d: x.d };
    map.set(x.d, { ...prev, ...(x.comp != null ? { comp: x.comp } : {}), ...(x.search != null ? { search: x.search } : {}) });
  });
  return [...map.values()].sort((a, b) => String(a.d).localeCompare(String(b.d))).slice(-KEEP);
}

async function main() {
  const cookie = (process.env.DY_COOKIE || '').trim();
  if (!cookie) throw new Error('DY_COOKIE 没填（抖音创作者中心的登录 cookie）');
  const end = windowEnd(new Date());
  const start = shift8(end, DAYS - 1);
  const t0 = new Date();
  const { body, mode } = await trend(cookie, start, end);
  const { days, period } = toDays(body);
  console.log(`窗口 ${start}~${end} · encrypted=${mode ?? '明文'} · 回 ${days.length} 天`);
  if (PROBE) { days.forEach(x => console.log(`  ${x.d} 综合 ${x.comp} 搜索 ${x.search}`)); return; }

  let old = null;
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 第一拍没有底本 */ }
  const out = {
    keyword: KW, at: bjStamp(t0), fetchedAt: t0.toISOString(),
    encrypted: mode ?? '', window: { start, end },
    runs: (old?.runs || 0) + 1,
    days: merge(old, days), period,
    lastError: '',
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  const l = out.days[out.days.length - 1];
  console.log(`写 ${path.basename(OUT)} · ${out.days.length} 天 · 最新 ${l?.d} 综合 ${l?.comp} 搜索 ${l?.search}`);
}

main().catch(e => {
  const msg = String(e?.message || e);
  console.log(`::error::抖音指数取数失败：${msg}`);
  if (PROBE) return;
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (old.lastError !== msg) { old.lastError = msg; fs.writeFileSync(OUT, JSON.stringify(old, null, 2) + '\n'); }
    console.log('旧档案没动，原因记在 lastError');
  } catch { console.log('档案是空的，这次没留下东西'); }
  // 退出码要非 0：工作流里这一步是 continue-on-error，红了不拖另外四家，
  // 但「没建 DY_COOKIE」和「拿到了数」在 Actions 页面上必须是两样颜色。
  process.exit(1);
});
