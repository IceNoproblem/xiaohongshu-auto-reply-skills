// collect_skeleton.mjs — 采集脚本骨架（脱敏，不可直接运行）
// 职责：推荐流滚动采集 → 机械硬过滤（广告/老帖/去重）→ 落盘 candidates.json
// 语义判断一律不做——交给 LLM 层。这是本架构的核心分工。
//
// 使用前必须替换：CONFIG 中的端口/路径/地区/领域词/选择器全部换成你自己的。
// 安全提示：单轮滚动与间隔请遵循 references/risk-table.md，先低后高自测。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CDP, getBrowserWs, sleep, rand, tsLocal, scrollPage, acquireLock, releaseLock } from './cdp-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ 配置占位（必须替换）============
const CONFIG = {
  browser: { port: 9222 },
  target: {
    feed_url: 'https://example.com/explore', // ← 替换为目标平台发现页
    scrolls: 12,
    max_cards: 80,
    max_age_days: 45,
    seen_max: 3000,
  },
  risk: { max_candidates_per_round: 10 },
};
// ==========================================

const STATE_PATH = path.join(__dirname, 'state.json');
const CAND_PATH = path.join(__dirname, 'candidates.json');
const LOG_PATH = path.join(__dirname, 'run.log');
const LOCK_DIR = path.join(__dirname, '.run.lock');

function log(msg) {
  const line = `[${tsLocal()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { replied: [], seen: [] }; } }
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// 页内注入 JS：抽取卡片。选择器随平台改版会失效——卡片 0 条时输出页面诊断，
// 用 title/卡片节点数/body 前 150 字区分「选择器失效」「页面异常」「风控页」。
const EXTRACT = `(() => {
  const res = [];
  const cards = Array.from(document.querySelectorAll('section.note-item')); // ← 替换选择器
  const seen = new Set();
  for (const card of cards) {
    const id = card.getAttribute('data-note-id');
    // 平台笔记 id 通常为固定长度 hex；UUID 形式的多为广告/推荐位卡片
    if (!id || !/^[0-9a-f]{24}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const title = (card.querySelector('.footer .title')?.innerText || '').split('\\n')[0].trim();
    const cover = card.querySelector('a.cover');
    const coverImg = card.querySelector('a.cover img');
    const href = cover ? (cover.getAttribute('href') || '') : ('/explore/' + id);
    const urlId = (href.match(/([0-9a-f]{24})/) || [])[1] || id;
    const urlQuery = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    // 规范化为详情页 URL 并保留 query（xsec_token 类参数丢了详情页可能 404）
    const detailUrl = location.origin + '/explore/' + urlId + urlQuery;
    const snippet = (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 300).trim();
    const timeM = snippet.match(/(\\d+\\s*(?:分钟|小时|天|个月)前|去年|昨天\\d*:\\d*|\\d{4}-\\d{2}-\\d{2}|\\d{2}-\\d{2})/);
    const cover_img = coverImg ? coverImg.getAttribute('src') || '' : '';
    const isAd = /(赞助|广告|推广)/.test((card.innerText || '').slice(0, 60));
    res.push({ note_id: id, url: detailUrl, title, content: snippet, time_hint: timeM ? timeM[1] : '', cover_img, is_ad: isAd });
  }
  return res.slice(0, ${CONFIG.target.max_cards});
})()`;

// 时间硬过滤：去年/N个月前 直接跳；N天前 超限跳；YYYY-MM-DD 按年跳；
// MM-DD 短格式补今年 → 晚于今天回退一年 → 按距今天数判（防跨年误判新帖）
function isOldNote(timeHint) {
  if (!timeHint) return false;
  if (/去年|\d+\s*个月前/.test(timeHint)) return true;
  const d = timeHint.match(/(\d+)\s*天前/);
  if (d) return parseInt(d[1], 10) > CONFIG.target.max_age_days;
  const y = timeHint.match(/(\d{4})-\d{2}-\d{2}/);
  if (y) return parseInt(y[1], 10) < new Date().getFullYear();
  const md = timeHint.match(/^(\d{2})-(\d{2})$/);
  if (md) {
    const now = new Date();
    let dt = new Date(now.getFullYear(), parseInt(md[1], 10) - 1, parseInt(md[2], 10));
    if (dt > now) dt.setFullYear(now.getFullYear() - 1);
    return Math.floor((now - dt) / 86400000) > CONFIG.target.max_age_days;
  }
  return false;
}

// 机械去噪（非语义）：去重 / 广告卡 / 老帖。区域/领域判断可选在此打标，不硬过滤。
function prefilter(note, state) {
  const id = note.note_id || note.url;
  if (state.seen.includes(id)) return { ok: false, reason: 'seen' };
  if (note.is_ad) return { ok: false, reason: 'ad' };
  if (isOldNote(note.time_hint)) return { ok: false, reason: 'old:' + note.time_hint };
  return { ok: true };
}

async function collect(bcdp) {
  const page = await openPage(bcdp, CONFIG.target.feed_url);
  if (!page) return [];
  await scrollPage(page.pcdp, CONFIG.target.scrolls, 1500, 700);
  const r = await page.pcdp.send('Runtime.evaluate', { expression: EXTRACT, returnByValue: true });
  const cards = (r.result && r.result.value) || [];
  if (cards.length === 0) {
    const diag = await page.pcdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.title, count: document.querySelectorAll('section.note-item').length, body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,150), url: location.href })`,
      returnByValue: true,
    });
    log('页面诊断: ' + ((diag.result && diag.result.value) || '无'));
  }
  return cards;
}

async function openPage(bcdp, url) {
  const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank' }); // 先空标签再导航，规避某些内核坑
  await sleep(1500);
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.browser.port}/json`)).json();
  const t = list.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pcdp = new CDP(ws);
  await pcdp.opened;
  await pcdp.send('Page.enable');
  await pcdp.send('Runtime.enable');
  await pcdp.send('Page.navigate', { url });
  for (let i = 0; i < 12; i++) {
    try {
      const st = await pcdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (st.result && st.result.value === 'complete') break;
    } catch {}
    await sleep(800);
  }
  await sleep(rand(1500, 3000));
  return { pcdp, targetId };
}

async function run() {
  if (!acquireLock(LOCK_DIR)) { log('另一脚本正在运行, 本轮跳过'); return; }
  try {
    const state = loadState();
    // pending 未清 → 跳过刷新保护候选；超 3h 归档防死锁
    if ((state.pending || []).length > 0) {
      let stale = true;
      try {
        const cands = JSON.parse(fs.readFileSync(CAND_PATH, 'utf8'));
        if (Array.isArray(cands) && cands.length > 0 && cands[0].ts) {
          stale = (Date.now() - new Date(cands[0].ts).getTime()) > 3 * 3600 * 1000;
        }
      } catch { stale = true; }
      if (stale) {
        state.skipped = [...(state.skipped || []), ...state.pending];
        state.pending = [];
        log('pending 超 3h 未处理, 归档 skipped 防死锁');
      } else {
        log('上轮候选未处理完, 本轮跳过刷新'); return;
      }
    }
    const bws = await getBrowserWs(CONFIG.browser.port);
    if (!bws) { log('浏览器未以调试端口运行, 跳过'); return; }
    const bcdp = new CDP(new WebSocket(bws));
    await bcdp.opened;
    const candidates = [];
    const cards = await collect(bcdp);
    log('采集 ' + cards.length + ' 条');
    for (const note of cards) {
      const id = note.note_id || note.url;
      if (state.replied.includes(id) || (state.skipped || []).includes(id)) continue;
      const { ok, reason } = prefilter(note, state);
      if (!ok) continue;
      note.ts = tsLocal();
      note.prefilter = reason;
      candidates.push(note);
      if (!state.seen.includes(id)) state.seen.push(id);
    }
    if (candidates.length > CONFIG.risk.max_candidates_per_round) candidates.length = CONFIG.risk.max_candidates_per_round;
    state.pending = candidates.map((n) => n.note_id || n.url);
    if (state.seen.length > CONFIG.target.seen_max) state.seen = [...new Set(state.seen)].slice(-CONFIG.target.seen_max);
    saveState(state);
    fs.writeFileSync(CAND_PATH, JSON.stringify(candidates, null, 2));
    log('候选 ' + candidates.length + ' 条, pending=' + state.pending.length);
    try { bcdp.ws.close(); } catch {}
  } finally { releaseLock(LOCK_DIR); }
}

run().then(() => process.exit(0)).catch((e) => { log('ERROR: ' + e.message); process.exit(1); });
