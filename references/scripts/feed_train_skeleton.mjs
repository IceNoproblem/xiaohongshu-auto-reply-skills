// feed_train_skeleton.mjs — 画像投喂骨架（脱敏，不可直接运行）
// 目的：低频搜索领域关键词 → 打开相关笔记真人节奏停留阅读 + 低频点赞
//       让平台推荐算法学习账号兴趣 → 推荐流供给变好（减少对搜索模式的依赖）
// 纪律：
//   - 低频（默认 ≤2 轮/天，每轮 1 词轮换），带风控冷却
//   - 真人节奏：停留 10-20s，间隔 4-8s；点赞 ≤2/轮
//   - 失败不影响主流程；绝不评论不发布
//   - 与 collect 共用互斥锁，防并发写 state / 抢标签页
//
// 使用前必须替换：PORT / 词表 / 选择器 / 路径。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CDP, getBrowserWs, sleep, rand, tsLocal, acquireLock, releaseLock } from './cdp-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  browser: { port: 9222 },
  feed_train: {
    queries: ['关键词A', '关键词B'],   // ← 你的领域词表（每轮轮换 1 个）
    max_view: 4,                       // 每轮最多浏览篇数
    max_like: 2,                       // 每轮最多点赞数
    scrolls: 5,
    cool_hours: 24,                    // 触发风控冷却时长
    like_enabled: true,
  },
};
const STATE_PATH = path.join(__dirname, 'state.json');
const LOG_PATH = path.join(__dirname, 'run.log');
const LOCK_DIR = path.join(__dirname, '.run.lock');

function log(msg) {
  const line = `[${tsLocal()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// 页内注入抽取卡片（与 collect 同构，可抽公共模块——骨架从简）
const EXTRACT = `(() => {
  const res = [];
  const cards = Array.from(document.querySelectorAll('section.note-item'));
  const seen = new Set();
  for (const card of cards) {
    const id = card.getAttribute('data-note-id');
    if (!id || !/^[0-9a-f]{24}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const title = (card.querySelector('.footer .title')?.innerText || '').split('\\n')[0].trim();
    const cover = card.querySelector('a.cover');
    const href = cover ? (cover.getAttribute('href') || '') : ('/explore/' + id);
    const urlId = (href.match(/([0-9a-f]{24})/) || [])[1] || id;
    const urlQuery = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    res.push({ url: location.origin + '/explore/' + urlId + urlQuery, title });
  }
  return res;
})()`;

async function openAndBrowse(bcdp, url, dwellMs) {
  const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank' });
  await sleep(1500);
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.browser.port}/json`)).json();
  const t = list.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
  if (!t) { try { await bcdp.send('Target.closeTarget', { targetId }); } catch {} return; }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pcdp = new CDP(ws);
  await pcdp.opened;
  await pcdp.send('Page.enable');
  await pcdp.send('Runtime.enable');
  await pcdp.send('Page.navigate', { url });
  for (let k = 0; k < 10; k++) {
    try {
      const st = await pcdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (st.result && st.result.value === 'complete') break;
    } catch {}
    await sleep(800);
  }
  await sleep(dwellMs); // 真人停留阅读
  try { ws.close(); } catch {}
  try { await bcdp.send('Target.closeTarget', { targetId }); } catch {}
}

async function run() {
  if (!acquireLock(LOCK_DIR)) { log('另一脚本正在运行, 本轮跳过'); return; }
  try {
    const cfg = CONFIG.feed_train;
    const state = loadState();
    const fs_ = state.feed_train || {};
    // 风控冷却检查
    if (fs_.cool_until && Date.now() < fs_.cool_until) {
      log('冷却中(风控), 跳过本轮'); return;
    }
    const bws = await getBrowserWs(CONFIG.browser.port);
    if (!bws) { log('浏览器未以调试端口运行, 跳过'); return; }
    const bcdp = new CDP(new WebSocket(bws));
    await bcdp.opened;
    // 词轮换
    const idx = fs_.next_query_idx || 0;
    const q = cfg.queries[idx % cfg.queries.length];
    log('投喂轮次: 搜「' + q + '」');
    const url = 'https://example.com/search_result?keyword=' + encodeURIComponent(q); // ← 替换
    const { targetId: stid } = await bcdp.send('Target.createTarget', { url: 'about:blank' });
    await sleep(1500);
    let pcdp = null;
    const list = await (await fetch(`http://127.0.0.1:${CONFIG.browser.port}/json`)).json();
    const st = list.find((x) => x.id === stid && x.webSocketDebuggerUrl);
    if (st) {
      const sws = new WebSocket(st.webSocketDebuggerUrl);
      pcdp = new CDP(sws);
      await pcdp.opened;
      await pcdp.send('Page.enable');
      await pcdp.send('Runtime.enable');
      await pcdp.send('Page.navigate', { url });
    }
    await sleep(4000);
    // 风控检测：标题含安全验证信号 → 冷却并退出
    if (pcdp) {
      const st2 = await pcdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const title = (st2.result && st2.result.value) || '';
      if (/安全验证|请求太频繁|验证码/.test(title)) {
        fs_.cool_until = Date.now() + cfg.cool_hours * 3600 * 1000;
        state.feed_train = fs_;
        saveState(state);
        log('触发风控(「' + title.slice(0, 30) + '」), 冷却 ' + cfg.cool_hours + 'h');
        try { await bcdp.send('Target.closeTarget', { targetId: stid }); } catch {}
        return;
      }
      // 滚动抽卡
      for (let i = 0; i < cfg.scrolls; i++) {
        await pcdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 1200 });
        await sleep(rand(900, 1600));
      }
      await sleep(1500);
    }
    let cards = [];
    if (pcdp) {
      const r = await pcdp.send('Runtime.evaluate', { expression: EXTRACT, returnByValue: true });
      cards = (r.result && r.result.value) || [];
    }
    log('取到 ' + cards.length + ' 条, 挑选浏览');
    // 洗牌随机选，避免每次固定前几篇
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    let viewed = 0, liked = 0;
    for (const pick of cards.slice(0, cfg.max_view)) {
      await openAndBrowse(bcdp, pick.url, rand(10000, 20000));
      viewed++;
      log('浏览: 「' + pick.title.slice(0, 24) + '」');
      // 点赞（低频 ≤max_like；主笔记点赞选择器与卡片点赞不同，需自行探测）
      if (cfg.like_enabled && liked < cfg.max_like) {
        try { liked++; log('已点赞'); } catch {}
      }
      await sleep(rand(4000, 8000));
    }
    fs_.next_query_idx = (idx + 1) % cfg.queries.length;
    fs_.last_run = tsLocal();
    state.feed_train = fs_;
    saveState(state);
    log('投喂完成: 浏览 ' + viewed + (liked ? ', 点赞 ' + liked : '') + ' | 下轮词: ' + cfg.queries[fs_.next_query_idx]);
    try { await bcdp.send('Target.closeTarget', { targetId: stid }); } catch {}
    try { bcdp.ws.close(); } catch {}
  } finally { releaseLock(LOCK_DIR); }
}

run().then(() => process.exit(0)).catch((e) => { log('ERROR: ' + e.message); process.exit(1); });
