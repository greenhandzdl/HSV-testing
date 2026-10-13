/**
 * 分享：URL 查询参数 + base64url 压缩载荷。
 *   题目： ?h=210&s=45&l=60&d=5
 *   成绩： ?share=result&data=<base64url>
 *   历史： ?share=history&data=<base64url>
 *   卡片二维码专用短链： ?share=r&data=<瘦载荷>   （r/h 是 result/history 的别名，旧链接照旧可用）
 * 全部基于 location.origin + pathname 拼装，GitHub Pages 子路径同样可用。
 */
import { CONFIG } from './config.js?v=16';
import { num } from './utils.js?v=16';
import { sanitizeColor } from './color.js?v=16';

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
 * 本题卡二维码专用：带「目标色 + 三次猜测（各含分数）+ 最终分」的瘦载荷。
 * 与 resultUrl（复制链接那条）同构，落地页 renderSharedResult 据此画出目标色 + 三个猜测圆点并标最佳。
 * 三次猜测都带上（用户要「当前题三次猜测也要」）：实测线上口径 ~167 字、落在 v9（53 格），
 * 340px 边长下每格仍 5px，与只带最佳那次同样疏密，不必放大本题卡。score.total 已由 rules.js round1
 * 过（最多一位小数），不会把载荷顶爆 qrMaxLength。version 不写（读侧只认 t）。超阈值则退回站点根地址。
 */
export function cardUrl(round) {
  if (!round || !round.target || !round.attempts || !round.attempts.length) return siteUrl();
  const g = round.attempts.slice(0, CONFIG.MAX_GUESSES).map((a) => [a.h, a.s, a.l, a.score.total]);
  const url = buildUrl({
    share: 'r',
    data: encode({
      t: 'r',
      d: round.difficulty,
      c: [round.target.h, round.target.s, round.target.l],
      g,
      f: round.final,
    }),
  });
  return url.length > CONFIG.SHARE.qrMaxLength ? siteUrl() : url;
}

/**
 * 历史卡二维码专用：摘要数字（n / avg / max / min / std）+ 尽量多带的逐题完整颜色。
 * 逐题一行 = [题号, 难度, 最终分, 目标色 c=[h,s,l], 三次猜测 g=[[h,s,l,total]×3]]，
 * 与分享链接的 rounds 同构，落地页据此画出目标色方块 + 三个猜测圆点。一题完整颜色
 * ~90 字符，从最近一题往上贪心追加，加到超出 qrColorMaxLength（对齐放大后的可扫密度）就停；
 * 得分取整是为了压字节（扫码预览不需要一位小数），颜色本就存的是整数 HSL。
 * 连摘要都超阈值则退回站点首页，宁可少一个入口也不给一张扫不出来的图。
 */
export function historyCardUrl(entries, stats, scope) {
  if (!stats || !stats.count) return siteUrl();
  const list = Array.isArray(entries) ? entries : [];
  // entries 已是最近优先；得分缺失时退回三次最高，不把 0 写进载荷
  const cells = list.map((e) => {
    const guesses = Array.isArray(e.guesses) ? e.guesses : [];
    const totals = guesses.map((g) => g.total);
    const f = Number.isFinite(e.final) ? e.final : (totals.length ? Math.max(...totals) : 0);
    const cell = [e.question, e.difficulty, Math.round(num(f, 0, 100, 0))];
    if (e.target) cell.push([e.target.h, e.target.s, e.target.l]); // 目标色 c
    cell.push(guesses.map((g) => [g.h, g.s, g.l, Math.round(num(g.total, 0, 100, 0))])); // 三次猜测 g
    return cell;
  });
  const build = (k) => {
    const payload = {
      t: 'h',
      scope: scopeLabel(entries, scope),
      n: stats.count,
      avg: stats.avg,
      max: stats.max,
      min: stats.min,
      std: stats.std,
    };
    if (k > 0) payload.r = cells.slice(0, k);
    return buildUrl({ share: 'h', data: encode(payload) });
  };
  let best = build(0); // 至少带摘要
  const cap = Math.min(cells.length, CONFIG.SHARE.qrColorRounds);
  for (let k = 1; k <= cap; k += 1) {
    const url = build(k);
    if (url.length > CONFIG.SHARE.qrColorMaxLength) break;
    best = url;
  }
  return best.length > CONFIG.SHARE.qrColorMaxLength ? siteUrl() : best;
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
