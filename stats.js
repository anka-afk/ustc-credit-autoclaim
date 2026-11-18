'use strict';
// 统计数据持久化 + 静态 dashboard 渲染
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'stats-data.json');
const OUT_FILE = path.join(ROOT, 'stats.html');
const TEMPLATE_FILE = path.join(ROOT, 'dashboard.html');
const MAX_POINTS = 2880; // 30s 轮询 × 24h
const MAX_CLAIMS = 500;
const MAX_FAILURES = 200;

function createStats(log) {
  let data = { history: [], claims: [], failures: [], current: null };
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      log(`(警告)stats-data.json 损坏,统计从零开始: ${e.message}`);
    }
  }
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  if (!template.includes('"__STATS_DATA__"')) throw new Error('dashboard.html 缺少数据占位符');

  function save() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    const json = JSON.stringify({ ...data, generatedAt: Date.now() }).replace(/</g, '\\u003c');
    fs.writeFileSync(OUT_FILE, template.replace('"__STATS_DATA__"', json));
  }

  const trim = (arr, max) => { if (arr.length > max) arr.splice(0, arr.length - max); };

  return {
    poll(st) {
      const t = Date.now();
      data.current = {
        t, pct: st.pct, seat: st.seat, seatTotal: st.seatTotal,
        claimed: st.claimed, usedClaimed: st.usedClaimed,
        enabled: st.forms.filter((f) => !f.disabled).length,
      };
      data.history.push({ t, pct: st.pct, used: st.usedClaimed, claimed: st.claimed });
      trim(data.history, MAX_POINTS);
      save();
    },
    claim(task, amount) {
      data.claims.push({ t: Date.now(), task, amount });
      trim(data.claims, MAX_CLAIMS);
      save();
    },
    fail(task, desc) {
      data.failures.push({ t: Date.now(), task, desc });
      trim(data.failures, MAX_FAILURES);
      save();
    },
  };
}

module.exports = { createStats };