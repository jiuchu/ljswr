/* 猫眼专业版「网播热度」榜 —— 《两京十五日》的剧集名次与实时热度。
   站外直接请求 /dashboard/webHeatData 一律 403：那份请求要带美团 H5guard 现签的 mtgsig。
   所以不逆签名，让真浏览器打开榜单页，把它自己发出的那份回包截下来：
   名次 = dataList.list[] 里本剧的下标 + 1，热度 = 同一行的 barValue（明文浮点）。
   回包里 currHeat / historyMaxHeat 是 PUA 字形，读出来是空串，不碰、也不做 OCR。
   失败只写 lastError，保留上一次数值；采集间隔不足 6 分钟就跳过（--force 可跳过这个闸门）。 */
import { chromium } from 'playwright';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./maoyan.json', import.meta.url));
const TITLE = '两京十五日';
const PAGE = 'https://piaofang.maoyan.com/dashboard/web-heat';
const MIN_GAP_MIN = 6;
const WAIT_MAX_MS = 90000;
const force = process.argv.includes('--force');

const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3);
const ymd = ms => bj(ms).toISOString().slice(0, 10).replace(/-/g, '');
const hm = ms => bj(ms).toISOString().slice(0, 16).replace('T', ' ');

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const nameOf = row => {
  const info = row && (row.seriesInfo || row.si);
  return info && typeof info.name === 'string' ? info.name : null;
};

function readOld() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; }
}
function save(obj) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, FILE);
}
function fail(old, msg) {
  const out = old
    ? { ...old, lastError: msg }
    : { title: TITLE, at: null, fetchedAt: null, rank: null, heat: null, lastError: msg };
  save(out);
  console.error('猫眼采集失败：' + msg);
  process.exitCode = 1;
}

/* 回包结构会整层挪，按形状找：一串至少 3 条带剧名、且带明文 barValue 的列表。 */
function findLists(root) {
  const lists = [];
  const walk = node => {
    if (Array.isArray(node)) {
      const named = node.filter(x => x && typeof x === 'object' && nameOf(x));
      if (named.length >= 3 && named.some(x => num(x.barValue) != null)) lists.push(node);
      node.forEach(walk);
    } else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(root);
  return lists;
}
function findTrends(root) {
  let best = null;
  const walk = node => {
    if (Array.isArray(node)) {
      const rows = node.filter(x => x && typeof x === 'object'
        && /^\d{8}$/.test(String(x.date)) && num(x.heat) != null);
      if (rows.length >= 3 && (!best || rows.length > best.length)) best = rows;
      node.forEach(walk);
    } else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(root);
  return best;
}

function extract(payload) {
  for (const list of findLists(payload)) {
    const idx = list.findIndex(row => nameOf(row) === TITLE);
    if (idx < 0) continue;
    const row = list[idx];
    const heat = num(row.barValue);
    if (heat == null || heat <= 0) continue;
    const info = row.seriesInfo || row.si || {};
    const trends = (findTrends(payload) || []).map(t => {
      const s = String(t.date);
      return { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, heat: num(t.heat) };
    }).filter(t => t.heat != null).sort((a, b) => a.date.localeCompare(b.date));
    return {
      rank: idx + 1,
      total: list.length,
      heat,
      seriesId: num(info.seriesId ?? row.seriesId),
      platform: typeof info.platformDesc === 'string' ? info.platformDesc : '',
      releaseInfo: typeof info.releaseInfo === 'string' ? info.releaseInfo : '',
      trend: trends.slice(-30),
    };
  }
  return null;
}

const HOOK = () => {
  window.__mycap = { rows: [] };
  const save = (url, text) => {
    if (!/webHeatData/.test(String(url))) return;
    try { window.__mycap.rows.push({ url: String(url), at: Date.now(), data: JSON.parse(text) }); } catch {}
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const arg = args[0];
      const url = typeof arg === 'string' ? arg : (arg && arg.url) || res.url;
      res.clone().text().then(t => save(url, t)).catch(() => {});
    } catch {}
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__myurl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...rest) {
    this.addEventListener('load', () => {
      try { save(this.__myurl || this.responseURL, this.responseText); } catch {}
    });
    return origSend.apply(this, rest);
  };
};

const old = readOld();
if (!force && old && old.fetchedAt) {
  const ageMin = (Date.now() - Date.parse(old.fetchedAt)) / 60000;
  if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < MIN_GAP_MIN) {
    console.log(`距上次成功采集 ${ageMin.toFixed(0)} 分钟（< ${MIN_GAP_MIN}），这一轮跳过`);
    process.exit(0);
  }
}

let browser = null;
try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  }
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  await page.addInitScript(HOOK);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + WAIT_MAX_MS;
  let captured = 0;
  while (Date.now() < deadline) {
    captured = await page.evaluate(() => (window.__mycap && window.__mycap.rows.length) || 0);
    if (captured > 0) break;
    if (/verify\.meituan\.com|login\.meituan\.com/.test(page.url())) {
      throw new Error('页面被导向美团验证/登录页：' + page.url());
    }
    await page.waitForTimeout(2000);
  }
  if (!captured) throw new Error(`打开榜单页后 ${WAIT_MAX_MS / 1000} 秒内没有截到回包`);

  const caps = await page.evaluate(() => window.__mycap.rows);
  const today = ymd();
  let got = null, stale = null;
  for (const cap of [...caps].reverse()) {
    const show = (/showDate=(\d{8})/.exec(cap.url) || [])[1] || '';
    const one = extract(cap.data);
    if (!one) continue;
    if (show && show !== today) { stale = show; continue; }
    const day = show || today;
    got = { ...one, showDate: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` };
    break;
  }
  if (!got && stale) throw new Error(`榜单回的是 ${stale} 的统计日，不是今天 ${today}`);
  if (!got) throw new Error(`回包里没找到「${TITLE}」那一行（榜单本次不含本剧）`);
  if (!Number.isInteger(got.rank) || got.rank < 1 || got.rank > got.total) {
    throw new Error(`名次不合理：${got.rank} / ${got.total}`);
  }

  const now = Date.now();
  save({
    title: TITLE,
    at: hm(now),
    fetchedAt: new Date(now).toISOString(),
    showDate: got.showDate,
    rank: got.rank,
    total: got.total,
    heat: Number(got.heat.toFixed(2)),
    seriesId: got.seriesId,
    platform: got.platform,
    releaseInfo: got.releaseInfo,
    trend: got.trend,
    lastError: '',
  });
  console.log(`猫眼：第 ${got.rank} 名（共 ${got.total} 条），实时热度 ${got.heat}，${hm(now)}`);
} catch (e) {
  fail(old, String((e && e.message) || e).slice(0, 200));
} finally {
  if (browser) await browser.close().catch(() => {});
}