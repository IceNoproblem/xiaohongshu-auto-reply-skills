// reply_skeleton.mjs — 发布脚本骨架（脱敏，不可直接运行）
// 职责：打开详情页 → 滚动到评论区 → 聚焦输入框 → 输入 → 检查回显 → 点发送 → 页面回显验证
// 纪律：
//   1. 以「页面出现回复片段」为准判定成功（输入框清空仅辅助），杜绝误记
//   2. 成功才写 replied + 日志；失败不落库、不重试
//   3. finally 关闭自己开的标签页（单标签页纪律）
//   4. 本脚本应只由「人工/语义层审核通过」显式调用——预览模式绝不发帖
//
// 使用前必须替换：PORT / 路径 / DOM 选择器（随平台改版，请自行探测更新）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9222;                                  // ← 替换
const STATE_PATH = path.join(__dirname, 'state.json');
const REPLY_LOG = path.join(__dirname, 'replies_log.json');
const URL = process.argv[2];
const TEXT = process.argv[3];

if (!URL || !TEXT) { console.error('用法: node reply_skeleton.mjs <详情URL> "<回复文本>"'); process.exit(1); }

function tsLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function log(msg) {
  const line = `[${tsLocal()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(__dirname, 'run.log'), line + '\n'); } catch {}
}

async function main() {
  let targetId = null;
  let bsend = null;
  try {
    // 1. 连浏览器级 WS
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => (bws.onopen = r));
    let mid = 0; const pend = new Map();
    bws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.error ? { error: m.error } : m.result); pend.delete(m.id); } };
    bsend = (method, params = {}) => new Promise((res) => { const id = ++mid; pend.set(id, res); bws.send(JSON.stringify({ id, method, params })); });

    // 2. 打开详情页
    const t0 = await bsend('Target.createTarget', { url: URL });
    targetId = t0.targetId;
    await new Promise((r) => setTimeout(r, 7000));
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const t = list.find((x) => x.id === targetId);
    if (!t) { log('❌ 找不到页面 target'); return; }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let pid = 0; const ppend = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && ppend.has(m.id)) { ppend.get(m.id)(m.error ? { error: m.error } : m.result); ppend.delete(m.id); } };
    const psend = (method, params = {}) => new Promise((res) => { const id = ++pid; ppend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    await psend('Page.enable');
    await psend('Runtime.enable');

    // 3. 滚动到评论区（让评论区懒加载完成）
    for (let i = 0; i < 6; i++) {
      await psend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 1200 });
      await new Promise((r) => setTimeout(r, 800));
    }
    await new Promise((r) => setTimeout(r, 2500));

    // 4. 聚焦评论输入框（选择器占位——随平台改版请自行探测，内容可编辑元素 + contenteditable）
    const focusR = await psend('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[contenteditable="true"].content-input'); // ← 替换选择器
        if (!el) return 'NO_INPUT';
        el.scrollIntoView({ block: 'center' });
        el.focus();
        return 'OK';
      })()`,
      returnByValue: true,
    });
    if (focusR.result?.value !== 'OK') { log('❌ 找不到评论输入框: ' + JSON.stringify(focusR.result?.value)); return; }
    await new Promise((r) => setTimeout(r, 800));
    await psend('Input.insertText', { text: TEXT });
    await new Promise((r) => setTimeout(r, 1500));

    // 5. 检查回显 + 发送（按钮 disabled 则放弃——可能是风控限制）
    const checkR = await psend('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[contenteditable="true"].content-input');
        const echo = el ? el.innerText.slice(0, 40) : '';
        const btn = document.querySelector('button.btn.submit'); // ← 替换选择器
        return JSON.stringify({ echo, btnDisabled: btn ? btn.disabled : true });
      })()`,
      returnByValue: true,
    });
    log('输入回显: ' + (checkR.result?.value || ''));
    const clickR = await psend('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button.btn.submit');
        if (!btn || btn.disabled) return 'BTN_DISABLED';
        btn.click();
        return 'CLICKED';
      })()`,
      returnByValue: true,
    });
    log('发送按钮: ' + (clickR.result?.value || ''));

    // 6. 验证：以「页面出现回复前 12 字片段」为准（输入框清空仅辅助）
    await new Promise((r) => setTimeout(r, 3500));
    const verifyR = await psend('Runtime.evaluate', {
      expression: `(() => {
        const body = document.body.innerText || '';
        const snippet = ${JSON.stringify(TEXT.slice(0, 12))};
        const found = body.includes(snippet);
        const inputCleared = (document.querySelector('[contenteditable="true"].content-input')?.innerText || '').trim() === '';
        return JSON.stringify({ found, inputCleared });
      })()`,
      returnByValue: true,
    });
    const v = JSON.parse(verifyR.result?.value || '{}');
    log('验证: 评论区出现回复片段=' + v.found + ', 输入框已清空=' + v.inputCleared);

    // 7. 仅 found=true 才落库
    if (v.found) {
      const entry = { url: URL.split('?')[0], replied_text: TEXT, replied_at: tsLocal() };
      let logArr = [];
      try { logArr = JSON.parse(fs.readFileSync(REPLY_LOG, 'utf8')); if (!Array.isArray(logArr)) logArr = []; } catch { logArr = []; }
      logArr.push(entry);
      fs.writeFileSync(REPLY_LOG, JSON.stringify(logArr, null, 2));
      let state = { replied: [], seen: [] };
      try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
      if (!Array.isArray(state.replied)) state.replied = [];
      const noteId = (URL.match(/[0-9a-f]{24}/) || [''])[0];
      if (noteId) state.replied.push(noteId);
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      log('✅ 已记录, replied=' + noteId);
    } else {
      log('⚠️ 未确认发布成功(可能被风控或按钮未激活), 未记录日志');
    }
  } finally {
    // 无论成败关闭自己开的标签页，防残留
    if (targetId && bsend) { try { await bsend('Target.closeTarget', { targetId }); } catch {} }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
