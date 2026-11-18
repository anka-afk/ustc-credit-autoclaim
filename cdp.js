'use strict';
// 零依赖 CDP 客户端:启动/复用 Edge,通过 WebSocket 控制页面
const { spawn } = require('child_process');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function isDebugPortAlive(port) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
    return true;
  } catch {
    return false;
  }
}

async function launchEdge({ edgePath, profileDir, port, headless }) {
  if (await isDebugPortAlive(port)) return { reused: true };
  if (!fs.existsSync(edgePath)) throw new Error(`找不到 Edge: ${edgePath}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-implicit-sign-in',
    '--disable-sync',
    '--disable-features=msEdgeSidebarV2',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(edgePath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await isDebugPortAlive(port)) return { reused: false, pid: child.pid };
    await sleep(500);
  }
  throw new Error(
    `Edge 调试端口 ${port} 未就绪。若该 profile 的 Edge 窗口已在运行(不带调试端口),请先关闭它再重试。`
  );
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已断开'));
      this.pending.clear();
    });
  }

  static async connect(port) {
    let targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pages = targets.filter((t) => t.type === 'page' && !/^(devtools|edge|chrome):/.test(t.url));
    let page = pages.find((t) => /^https?:/.test(t.url)) || pages[0];
    if (!page) {
      page = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, 5000).catch(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        return res.json();
      });
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('无法连接 CDP WebSocket')), { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  async navigate(url, timeoutMs = 30000) {
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.on('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
    });
    const res = await this.send('Page.navigate', { url });
    if (res.errorText) throw new Error(`导航失败: ${res.errorText}`);
    await loaded;
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面脚本异常: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, { timeoutMs = 30000, intervalMs = 500, desc = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return;
      await sleep(intervalMs);
    }
    throw new Error(`等待超时(${timeoutMs}ms): ${desc}`);
  }

  close() {
    this.ws.close();
  }
}

module.exports = { launchEdge, CDP, sleep, isDebugPortAlive };