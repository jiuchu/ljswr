// 《两京十五日》爱奇艺：更新时间表 + 更新进度 + 预约人数。全匿名只读。
// 签名 = md5(按 key 字典序的 k=v 用 & 连接 + "&secret_key=howcuteitis") 取大写；secret_key 本身不发送。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE = '两京十五日';
const QIPU_ID = '3190714930072901';
const APP_VERSION = '17.112.26799';
const DEVICE_ID = '0000000000000000000000000000lj15';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
function signed(params) {
  const keys = Object.keys(params).sort();
  const raw = keys.map(k => `${k}=${params[k]}`).join('&') + '&secret_key=howcuteitis';
  params.sign = md5(raw).toUpperCase();
  return params;
}
const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.iqiyi.com/', ...headers } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 风控页会以 200 回 HTML，这里不当成功 */ }
  return { http: r.status, json, text };
}

/* 排播表本体：vipItems/nonVipItems 里的 albumOrder 就是页面上「1-4」那一格 */
async function calendar() {
  const p = signed({
    albumId: QIPU_ID, appVersion: APP_VERSION, deviceId: DEVICE_ID,
    src: 'tvg', timestamp: Date.now(), userId: '',
  });
  const { http, json } = await get('https://mesh.if.iqiyi.com/tvg/album_calendar_info?' + qs(p));
  const dates = json?.data?.dates;
  if (!Array.isArray(dates) || !dates.length) throw new Error(`album_calendar_info HTTP ${http} 没回 dates`);
  const span = arr => {
    const n = arr.map(x => Number(x.albumOrder)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!n.length) return '';
    return n.length === 1 ? String(n[0]) : `${n[0]}-${n[n.length - 1]}`;
  };
  return {
    rows: dates.map(d => ({
      date: String(d.origin_date || ''),
      label: String(d.date || ''),
      week: String(d.week || ''),
      vip: span(d.vipItems || []),
      nonVip: span(d.nonVipItems || []),
      stopped: !!d.isStopUpdate,
      stopReason: String(d.stopUpdateReason || ''),
    })),
    tail: String(json.data.more_txt || ''),
  };
}

/* 更新进度：看板要的那句「更新至4集/共26集」和两条放量规则原文 */
async function progress() {
  const p = signed({
    entity_id: QIPU_ID, res_node: 'base_data', src: 'pca_tvg', timestamp: Date.now(),
    user_id: '0', vip_type: '-1', vip_status: '0', device_id: '', auth_cookie: '',
    conduit_id: '', app_version: APP_VERSION, app_mode: '', ext: '',
  });
  const { http, json } = await get('https://mesh.if.iqiyi.com/tvg/v2/base_info?' + qs(p));
  const b = json?.data?.base_data;
  if (!b) throw new Error(`base_info HTTP ${http} 没回 base_data`);
  const u = b.update_info || {};
  const total = Number(b.total_episode) || null;
  const m = String(u.update_status || '').match(/更新至\s*(\d+)\s*集\s*\/\s*共\s*(\d+)\s*集/);
  return {
    update_status: String(u.update_status || ''),
    update_notification: String(u.update_notification || ''),
    display_update_notification: String(u.display_update_notification || ''),
    extra_tip: String(u.extra_tip || ''),
    ep_now: m ? Number(m[1]) : null,
    ep_total: m ? Number(m[2]) : (total || null),
    total_episode: total,
    album_finish: b.album_finish,
    heat: Number(b.heat) || null,
    publish_date: String(b.publish_date || ''),
  };
}

/* 预约人数：paibo 的 C 路，subType 必须给 2 —— 给 1 或 3 回 count:0 而 code 照样 A00000 */
async function reserve() {
  const { http, json } = await get(
    'https://subscription.iqiyi.com/services/subscribe/countAndState.htm'
    + `?subType=2&agentType=30&version=17.103.26647&subKeys=${QIPU_ID}`);
  if (json?.code !== 'A00000' || !json.data) throw new Error(`countAndState HTTP ${http} code=${json?.code}`);
  const n = Number((json.data[String(QIPU_ID)] || {}).count);
  if (!Number.isFinite(n)) throw new Error('回包里这一条没有 count');
  return n;
}

const out = { title: TITLE, qipuId: QIPU_ID, captured_at: new Date().toISOString() };
const errs = [];
try { out.calendar = await calendar(); } catch (e) { errs.push('排播表: ' + e.message); }
await new Promise(r => setTimeout(r, 1500));
try { out.progress = await progress(); } catch (e) { errs.push('更新进度: ' + e.message); }
await new Promise(r => setTimeout(r, 1500));
try { out.reserve = await reserve(); } catch (e) { errs.push('预约人数: ' + e.message); }
out.errors = errs;

fs.writeFileSync(path.join(HERE, 'iqiyi.json'), JSON.stringify(out, null, 1));
const c = out.calendar?.rows || [];
console.log(`${TITLE}  排播表 ${c.length ? c.length + ' 天 ' + c[0].date + '→' + c[c.length - 1].date : '取不到'}`
  + ` | 进度 ${out.progress?.update_status || '取不到'}`
  + ` | VIP规则「${out.progress?.update_notification || '-'}」`
  + ` | 非会员「${out.progress?.display_update_notification || '-'}」`
  + ` | 预约 ${out.reserve != null ? out.reserve.toLocaleString() : '取不到'}`
  + (errs.length ? `\n  失败：${errs.join(' / ')}` : ''));
if (c.length) console.log('  首两行：' + c.slice(0, 2).map(x => `${x.label}${x.week} 会员${x.vip || '-'} 非会员${x.nonVip || '-'}`).join(' ｜ ') + ` ｜ 表尾「${out.calendar.tail}」`);
