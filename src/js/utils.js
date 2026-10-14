/** 通用工具：数值钳位、格式化、随机数、HTML 转义。没有任何 DOM / 存储依赖，可在 Node 里直接测。 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round(v * 10) / 10;
export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const pad2 = (n) => String(n).padStart(2, '0');

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/** 数值安全转换，用于解析 localStorage / URL 中的不可信数据 */
export function num(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

export function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

/** 卡片文件名用的日期：2026-10-10 */
export function formatDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
