/**
 * 分享：URL 查询参数 + base64url 压缩载荷。
 *   题目： ?h=210&s=45&l=60&d=5
 *   成绩： ?share=result&data=<base64url>
 *   历史： ?share=history&data=<base64url>
 *   卡片二维码专用短链： ?share=r&data=<瘦载荷>   （r/h 是 result/history 的别名，旧链接照旧可用）
 * 全部基于 location.origin + pathname 拼装，GitHub Pages 子路径同样可用。
 */
import { CONFIG } from './config.js';
import { num } from './utils.js';
import { sanitizeColor } from './color.js';

function utf8ToBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUtf8(codes) {
  let b64 = String(codes).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encode(payload) {
  try {
    return utf8ToBase64Url(JSON.stringify(payload));
  } catch (err) {
    return '';
  }
}

export function decode(text) {
  try {
    const obj = JSON.parse(base64UrlToUtf8(text));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    return null;
  }
}

function buildUrl(params) {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

export function puzzleUrl(color, difficulty) {
  return buildUrl({ h: color.h, s: color.s, l: color.l, d: difficulty });
}

/** scope 字段存可读值：'all' 或具体难度数字（不存 'difficulty' 这种内部枚举） */
function scopeLabel(entries, scope) {
  if (scope === 'global') return 'all';
  return entries && entries[0] ? entries[0].difficulty : 'unknown';
}

/** 历史载荷：默认带三次猜测颜色；链接过长时退化为"仅摘要 + 最佳色" */
export function historyUrl(entries, stats, scope) {
  const scopeLabelValue = scopeLabel(entries, scope);
  const slim = (withColors) => ({
    t: 'h',
    v: CONFIG.SHARE.version,
    scope: scopeLabelValue,
    n: stats.count,
    avg: stats.avg,
    max: stats.max,
    min: stats.min,
    std: stats.std,
    rounds: entries.slice(0, CONFIG.SHARE.maxRounds).map((e) => {
      const totals = e.guesses.map((g) => g.total);
      const best = e.guesses[totals.indexOf(Math.max(...totals))] || e.guesses[0];
      const round = { q: e.question, d: e.difficulty, f: e.final };
      if (withColors) {
        round.c = [e.target.h, e.target.s, e.target.l];
        round.g = e.guesses.map((g) => [g.h, g.s, g.l, g.total]);
      } else if (best) {
        // 退化时带上 best 自己的得分，否则读不到只能拿整题 final 当"第 1 次"分数
        round.b = [best.h, best.s, best.l, best.total];
      }
      return round;
    }),
  });
  let data = encode(slim(true));
  if (buildUrl({ share: 'history', data }).length > CONFIG.SHARE.maxLength) {
    data = encode(slim(false));
  }
  return buildUrl({ share: 'history', data });
}

export function resultUrl(round) {
  const payload = {
    t: 'r',
    v: CONFIG.SHARE.version,
    d: round.difficulty,
    c: [round.target.h, round.target.s, round.target.l],
    g: round.attempts.map((a) => [a.h, a.s, a.l, a.score.total]),
    f: round.final,
  };
  return buildUrl({ share: 'result', data: encode(payload) });
}

/** 站点根地址（卡片没有可分享的成绩时的兜底） */
export function siteUrl() {
  return buildUrl({});
}

/**
 * 卡片二维码专用：只带「目标色 + 最佳那次 + 最终分」的瘦载荷。
 * 二维码要留在 v7-L（约 150 字节）以内才谈得上扫得动，所以这里既省字段名也省字段：
 * 三次猜测只留最佳那次，version 也不写（读侧只认 t 不认 v）。
 * 超阈值就退回站点根地址，宁可少一个入口也不给一张扫不出来的图。
 */
export function cardUrl(round) {
  if (!round || !round.target || !round.attempts || !round.attempts.length) return siteUrl();
  const totals = round.attempts.map((a) => a.score.total);
  const best = round.attempts[totals.indexOf(Math.max(...totals))];
  const url = buildUrl({
    share: 'r',
    data: encode({
      t: 'r',
      d: round.difficulty,
      c: [round.target.h, round.target.s, round.target.l],
      g: [[best.h, best.s, best.l, best.score.total]],
      f: round.final,
    }),
  });
  return url.length > CONFIG.SHARE.qrMaxLength ? siteUrl() : url;
}

/**
 * 历史卡二维码专用：只带摘要数字（n / avg / max / min / std），不带逐题记录。
 * 逐题行每加一条约多 16 字符（含目标色更多），四条就冲出 v10-M，而 v10 在 340px
 * 边长下只剩 4.86px/格，对着屏幕基本扫不出来。所以完整逐题成绩由卡片图自己承担，
 * 扫码只看摘要；超阈值同样退回站点首页。
 */
export function historyCardUrl(entries, stats, scope) {
  if (!stats || !stats.count) return siteUrl();
  const url = buildUrl({
    share: 'h',
    data: encode({
      t: 'h',
      scope: scopeLabel(entries, scope),
      n: stats.count,
      avg: stats.avg,
      max: stats.max,
      min: stats.min,
      std: stats.std,
    }),
  });
  return url.length > CONFIG.SHARE.qrMaxLength ? siteUrl() : url;
}

// 用 Map 而不是对象查表：对象会顺着原型链命中 toString / constructor 之类，
// 那等于把 ?share=constructor 也当成合法分享类型
const SHARE_ALIASES = new Map([
  ['result', 'result'],
  ['r', 'result'],
  ['history', 'history'],
  ['h', 'history'],
]);

/** 解析地址栏 -> { share } | { puzzle } | null */
export function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const shareKind = SHARE_ALIASES.get(params.get('share'));
  if (shareKind) {
    const payload = decode(params.get('data') || '');
    const want = shareKind === 'history' ? 'h' : 'r';
    return payload && payload.t === want ? { share: shareKind, payload } : { share: shareKind, payload: null };
  }
  if (params.has('h') && params.has('s') && params.has('l')) {
    const color = sanitizeColor({
      h: Number(params.get('h')),
      s: Number(params.get('s')),
      l: Number(params.get('l')),
    });
    const difficulty = Math.round(
      num(
        params.get('d'),
        CONFIG.DIFFICULTY.min,
        CONFIG.DIFFICULTY.max,
        CONFIG.DIFFICULTY.default
      )
    );
    return { puzzle: color ? { color, difficulty } : null };
  }
  return {};
}
