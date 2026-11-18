'use strict';
// Qoder 共享额度自动领取监控
// 架构:Edge(CDP) 只负责登录和会话续期;监控/领取全部走纯 HTTP API
const fs = require('fs');
const path = require('path');
const net = require('net');
const { launchEdge, CDP, sleep } = require('./cdp');
const { unprotect } = require('./secret');
const { parseStatus, REASONS } = require('./parse');
const { createStats } = require('./stats');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LOG_FILE = path.join(ROOT, 'bot.log');
const CLAIM_URL = 'https://id.ustc.edu.cn/tokenworks/credits/api/claim';

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ---------- 纯 HTTP 轮询与领取 ----------
const isRedirect = (res) => res.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(res.status);

async function fetchPage(cookieHeader) {
  const res = await fetch(cfg.creditsUrl, {
    headers: { Cookie: cookieHeader },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

async function postClaim(cookieHeader, task, csrf) {
  const res = await fetch(CLAIM_URL, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ task_id: task, csrf }),
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  if (isRedirect(res)) return { sessionExpired: true };
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`领取接口返回非 JSON(HTTP ${res.status}),可能会话已过期`);
  }
  return data;
}

// ---------- 浏览器登录(CDP) ----------
async function extractCookies(cdp) {
  const { cookies } = await cdp.send('Network.getCookies', { urls: [cfg.creditsUrl] });
  if (!cookies.length) throw new Error('浏览器中没有 id.ustc.edu.cn 的 Cookie');
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function setWindowState(cdp, state) {
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
  } catch (e) {
    log(`(提示)调整窗口状态失败: ${e.message}`);
  }
}

async function ensureLogin(cdp, username, password) {
  await cdp.navigate(cfg.creditsUrl);
  if (!(await cdp.eval(`document.body.innerText.includes('请先登录')`))) return;

  log('会话失效,开始自动登录…');
  if (!cfg.headless) await setWindowState(cdp, 'normal');
  await cdp.navigate(cfg.creditsUrl + 'auth/login');
  await cdp.waitFor(
    `location.pathname.startsWith('/tokenworks/credits') || !!document.querySelector('input[type=password]')`,
    { timeoutMs: 30000, desc: 'CAS 登录表单或 SSO 回跳' }
  );
  const ssoBack = await cdp.eval(
    `location.pathname.startsWith('/tokenworks/credits') && !document.body.innerText.includes('请先登录')`
  );
  if (ssoBack) {
    log('SSO 会话仍有效,免密续期成功');
    return;
  }

  // 关闭可能遮挡表单的「设备信息采集告知」弹窗,填写账号密码并提交
  const fillExpr = `(() => {
    const ack = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '知道了');
    if (ack) ack.click();
    const pwd = document.querySelector('input[type=password]');
    if (!pwd) return 'no_password_input';
    const form = pwd.closest('form') || document;
    const user = form.querySelector('input[placeholder*="学工号"], input[type=text]');
    if (!user) return 'no_username_input';
    const setVal = (el, v) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(user, ${JSON.stringify(username)});
    setVal(pwd, ${JSON.stringify(password)});
    const btn = [...form.querySelectorAll('button')].find(b => /登\\s*录/.test(b.textContent));
    if (!btn) return 'no_login_button';
    btn.click();
    return 'submitted';
  })()`;
  const r = await cdp.eval(fillExpr);
  if (r !== 'submitted') throw new Error(`CAS 登录表单异常: ${r}(页面结构可能已变化)`);

  const backCheck = `location.pathname.startsWith('/tokenworks/credits') && !document.body.innerText.includes('请先登录')`;
  try {
    await cdp.waitFor(backCheck, { timeoutMs: 30000, desc: '登录后跳回额度页' });
  } catch {
    const errText = await cdp.eval(`['caLoginFailTip', 'riskMessage']
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(e => e.innerText.trim())
      .filter(Boolean)
      .join(' | ')`);
    if (errText) throw new Error(`CAS 登录失败: ${errText}(请检查账号密码后重新运行 setup)`);
    log('⚠ 自动提交后未跳回,可能触发了验证码/二次认证。请在任务栏打开该 Edge 窗口手动完成登录(等待 10 分钟)…');
    await cdp.waitFor(backCheck, { timeoutMs: 600000, intervalMs: 3000, desc: '手动完成登录' });
  }
  log('登录成功');
}

// ---------- 主循环 ----------
function acquireLock() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`已有监控实例在运行(端口 ${cfg.debugPort + 1} 被占用),请勿重复启动`));
      else reject(e);
    });
    srv.listen(cfg.debugPort + 1, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  if (!cfg.username) throw new Error('config.json 中缺少 username,请先运行「1-设置账号.bat」');
  const secretFile = path.join(ROOT, 'secret.dat');
  if (!fs.existsSync(secretFile)) throw new Error('缺少 secret.dat,请先运行「1-设置账号.bat」');
  const password = await unprotect(fs.readFileSync(secretFile, 'utf8').trim());
  await acquireLock();

  log('=== Qoder 额度自动领取监控启动 ===');
  log(`轮询间隔 ${cfg.pollIntervalSec}s | 阈值由服务端判定(总额度 90%)| 日志: ${LOG_FILE}`);

  const edgeOpts = {
    edgePath: cfg.edgePath,
    profileDir: path.resolve(ROOT, cfg.profileDir),
    port: cfg.debugPort,
    headless: cfg.headless,
  };
  await launchEdge(edgeOpts);
  let cdp = await CDP.connect(cfg.debugPort);
  await ensureLogin(cdp, cfg.username, password);
  let cookies = await extractCookies(cdp);
  if (!cfg.headless) await setWindowState(cdp, 'minimized');
  log('Cookie 已提取,进入纯 HTTP 监控模式(浏览器仅在会话过期时再次介入)');

  // 会话续期:浏览器被用户关闭时自动重启 Edge
  const renewSession = async () => {
    if (cdp.ws.readyState !== WebSocket.OPEN) {
      log('浏览器连接已断开(窗口可能被关闭),重新启动 Edge…');
      try { cdp.close(); } catch {}
      await launchEdge(edgeOpts);
      cdp = await CDP.connect(cfg.debugPort);
    }
    await ensureLogin(cdp, cfg.username, password);
    cookies = await extractCookies(cdp);
    if (!cfg.headless) await setWindowState(cdp, 'minimized');
  };

  const cooldown = new Map();
  const stats = createStats(log);
  let consecutiveErrors = 0;

  for (;;) {
    let refetchNow = false;
    try {
      const res = await fetchPage(cookies);
      if (isRedirect(res)) {
        log(`会话过期(HTTP ${res.status}),重新登录…`);
        await renewSession();
        continue;
      }
      const st = parseStatus(await res.text());
      if (!st.loggedIn) {
        log('会话过期(页面要求登录),重新登录…');
        await renewSession();
        continue;
      }
      log(
        `用量 ${st.pct}% | 席位 ${st.seat}/${st.seatTotal} | 已领共享 ${st.claimed} | 已领已用 ${st.usedClaimed} | 可领按钮 ${st.forms.filter((f) => !f.disabled).length} 个`
      );
      stats.poll(st);

      const now = Date.now();
      for (const f of st.forms) {
        if (f.disabled) continue;
        if ((cooldown.get(f.task) || 0) > now) continue;
        if (!f.csrf) throw new Error(`任务 ${f.task} 的表单缺少 csrf token`);
        log(`尝试领取 [${f.task}] …`);
        const r = await postClaim(cookies, f.task, f.csrf);
        if (r.sessionExpired) {
          refetchNow = true;
          await renewSession();
          break;
        }
        if (r.ok) {
          log(`✔ 领取成功 [${f.task}] +${r.amount} credits`);
          stats.claim(f.task, r.amount);
          cooldown.delete(f.task);
          refetchNow = true; // 立即刷新页面,继续领下一个可领任务
          break;
        }
        const [desc, cdSec] = REASONS[r.reason] || [`未知原因(${r.reason})`, 300];
        log(`✘ 领取失败 [${f.task}]: ${desc}`);
        stats.fail(f.task, desc);
        if (cdSec === 0) refetchNow = true;
        else cooldown.set(f.task, Date.now() + cdSec * 1000);
      }
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      log(`轮询异常(连续第 ${consecutiveErrors} 次): ${e.message}`);
      if (consecutiveErrors >= 5) {
        log('连续异常,尝试重建浏览器会话…');
        try { cdp.close(); } catch {}
        await renewSession();
        consecutiveErrors = 0;
        refetchNow = true;
      }
    }
    if (!refetchNow) await sleep(cfg.pollIntervalSec * 1000);
  }
}

main().catch((e) => {
  log(`致命错误: ${e.message}`);
  process.exit(1);
});