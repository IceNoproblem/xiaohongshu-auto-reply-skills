// cdp-core.mjs — 零依赖 CDP 客户端核心（骨架，可独立复用到任何 CDP 场景）
// 技术：Node 内置 WebSocket + fetch，无 puppeteer/playwright
// 说明：以下为通用传输层，不含任何平台选择器。完整版见仓库主流程。
import fs from 'fs';

// 北京时间时间戳（本地时间组件拼装，避免 UTC 差 8h 的日志错位）
export function tsLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- 极简 CDP 客户端：msgId→pending Map 配对，20s 超时兜底 ----
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e?.message || 'ws error');
    });
    ws.onmessage = (ev) => this._onMessage(ev.data);
  }
  _onMessage(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  }
  send(method, params = {}) {
    return Promise.race([
      (async () => {
        await this.opened;
        const id = ++this.msgId;
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.ws.send(JSON.stringify({ id, method, params }));
        });
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CDP timeout: ' + method)), 20000)),
    ]);
  }
}

// 浏览器级 WS 地址（浏览器需以 --remote-debugging-port=<port> 启动）
export async function getBrowserWs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    const j = await r.json();
    return j.webSocketDebuggerUrl || null;
  } catch { return null; }
}

// 工具：页面滚动（鼠标滚轮，真人节奏由调用方控制间隔）
export async function scrollPage(pcdp, times = 5, baseDelayMs = 1200, jitterMs = 400) {
  for (let i = 0; i < times; i++) {
    await pcdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 1200 + Math.floor(Math.random() * 800),
    });
    await sleep(baseDelayMs + Math.floor(Math.random() * jitterMs));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

// ---- 互斥锁（mkdir 原子性）：防多脚本并发写 state/抢浏览器 ----
// 崩溃残留锁：mtime 超过 staleMs 自动接管（防死锁）
export function acquireLock(lockDir, staleMs = 10 * 60 * 1000) {
  try { fs.mkdirSync(lockDir); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') return false;
    try {
      const st = fs.statSync(lockDir);
      if (Date.now() - st.mtimeMs > staleMs) { fs.rmdirSync(lockDir); fs.mkdirSync(lockDir); return true; }
    } catch {}
    return false;
  }
}
export function releaseLock(lockDir) { try { fs.rmdirSync(lockDir); } catch {} }
