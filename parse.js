'use strict';
// 服务端渲染 HTML 的解析(单双引号均兼容,已实测)
const num = (s) => (s == null ? null : parseInt(s.replace(/,/g, ''), 10));

function parseStatus(html) {
  const loggedIn = !html.includes('请先登录');
  const pct = html.match(/总额度已用<\/span><span>(\d+)%/);
  const seat = html.match(/席位额度<\/span><span>([\d,]+)\s*\/\s*([\d,]+)/);
  const claimed = html.match(/已领共享额度<\/span><span>([\d,]+)/);
  const usedClaimed = html.match(/已领额度已用<\/span><span>([\d,]+)\s*\/\s*([\d,]+)/);
  const forms = [...html.matchAll(/<form[^>]*data-task=["'](\w+)["'][^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
    task: m[1],
    disabled: /<button[^>]*\bdisabled/.test(m[2]),
    csrf: (m[2].match(/name=["']csrf["']\s+value=["']([^"']+)["']/) || [])[1],
  }));
  if (loggedIn && (!pct || forms.length === 0)) {
    throw new Error('页面结构可能已变化:无法解析用量或任务表单,请检查 bot.log 并更新解析逻辑');
  }
  return {
    loggedIn,
    pct: pct ? num(pct[1]) : null,
    seat: seat ? num(seat[1]) : null,
    seatTotal: seat ? num(seat[2]) : null,
    claimed: claimed ? num(claimed[1]) : null,
    usedClaimed: usedClaimed ? num(usedClaimed[1]) : null,
    forms,
  };
}

// 领取失败原因 → [中文说明, 冷却秒数]
const REASONS = {
  grant_remaining: ['未达领取门槛', 60],
  not_done: ['任务未完成或核验记录延迟', 600],
  unavailable: ['核验服务暂不可用', 120],
  task_already_claimed: ['该任务已领取过', 3600],
  checked_in_today: ['今日已签到', 86400],
  slots_gone: ['今日签到名额已领完', 86400],
  qoder_error: ['发放失败,额度未变动', 120],
  qoder_unavailable: ['额度服务暂不可用', 120],
  duplicate: ['重复请求', 0],
  person_cap: ['已达本周期个人上限', 21600],
  pool_frozen: ['共享池暂停放量', 1800],
  daily_limit: ['今日放量已发完', 86400],
  no_cycle: ['领取周期未开放', 1800],
  budget_spent: ['本批额度已发完', 1800],
  csrf: ['页面过期', 0],
};

module.exports = { parseStatus, REASONS };