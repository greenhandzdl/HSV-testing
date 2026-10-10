'use strict';

/* ======================================================================
 * 颜色比色挑战 · script.js
 *
 * 模块顺序：
 *   1. 可调常量   2. 通用工具   3. 评分算法   4. 出题与难度
 *   5. 历史存储   6. 分享编解码 7. 状态与DOM  8. 渲染
 *   9. 交互事件   10. 启动入口
 * 依赖：原生 DOM + localStorage，无任何构建/后端依赖。
 * ==================================================================== */

/* ----------------------------------------------------------------------
 * 1. 可调常量：难度参数、评分权重、颜色范围、机会数、历史条数等
 * -------------------------------------------------------------------- */
const CONFIG = Object.freeze({
  MAX_GUESSES: 3, // 每题提交机会
  // 每题开始时滑块的初始值（中性灰蓝，不泄露目标色）
  ROUND_DEFAULT: Object.freeze({ h: 180, s: 50, l: 50 }),

  SCORE: Object.freeze({
    weights: Object.freeze({ h: 0.65, s: 0.2, l: 0.15 }), // 色相权重最高
    hueMaxDistance: 180, // 色相环形距离上限
    finalRule: 'max', // 最终得分口径：'max' | 'avg' | 'last'
  }),

  DIFFICULTY: Object.freeze({
    min: 1,
    max: 10,
    default: 1,
    // 饱和度均值随难度左移：meanS = clamp(85 - d * 6, 15, 85)
    meanSatBase: 85,
    meanSatPerLevel: 6,
    meanSatFloor: 15,
    meanSatCeil: 85,
    satStd: 12, // 高斯分布标准差
    hueMin: 0,
    hueMax: 360,
    lightMin: 25, // 避免过黑
    lightMax: 80, // 避免过白
  }),

  // 自动递增难度：考得好升级，考得差降级
  AUTO: Object.freeze({ upThreshold: 88, downThreshold: 45 }),

  // 连续高分记录口径
  STREAK: Object.freeze({ threshold: 95 }),

  HISTORY: Object.freeze({
    recentDefault: 5, // 默认显示最近 5 题
    recentOptions: Object.freeze([5, 8, 10]),
    maxPerBucket: 30, // 每个难度桶 / 全局最多保留 30 条，防 localStorage 膨胀
  }),

  RATINGS: Object.freeze([
    Object.freeze({ min: 95, label: '神之眼' }),
    Object.freeze({ min: 85, label: '非常接近' }),
    Object.freeze({ min: 70, label: '不错' }),
    Object.freeze({ min: 50, label: '继续努力' }),
    Object.freeze({ min: 0, label: '色感有待提升' }),
  ]),

  SHARE: Object.freeze({
    version: 1,
    maxRounds: 8, // 分享链接里最多带 8 题
    maxLength: 1800, // 超过则退化为"仅摘要"，避免链接过长被 IM 截断
  }),

  STORAGE_KEY: 'hsvColorMatch.history.v1',
});

/* ----------------------------------------------------------------------
 * 2. 通用工具
 * -------------------------------------------------------------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad2 = (n) => String(n).padStart(2, '0');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/** 数值安全转换，用于解析 localStorage / URL 中的不可信数据 */
function num(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/**
 * Box-Muller 变换：两个均匀分布随机数 -> 一个标准正态分布随机数
 * u/v 取不到 0（log(0) = -Infinity），故循环重取
 */
function gaussian(mean, std) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const standard = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + standard * std;
}

/** 合法颜色对象：H/S/L 均为整数，越界即截断 */
function sanitizeColor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = Number(raw.h);
  const s = Number(raw.s);
  const l = Number(raw.l);
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return {
    h: clamp(Math.round(h), 0, 360),
    s: clamp(Math.round(s), 0, 100),
    l: clamp(Math.round(l), 0, 100),
  };
}

const hslCss = ({ h, s, l }) => `hsl(${h}, ${s}%, ${l}%)`;
const hslLabel = ({ h, s, l }) => `H ${h}° · S ${s}% · L ${l}%`;
const hslPlain = ({ h, s, l }) => `${h}, ${s}%, ${l}%`;

/**
 * HSL -> HSV 换算（仅用于展示，站内模型与评分仍是 HSL）
 * V = L + S·min(L, 1−L)；S_hsv = 2·S·min(L, 1−L) / V（V=0 时为 0）
 */
function hsvOf({ h, s, l }) {
  const S = s / 100;
  const L = l / 100;
  const m = Math.min(L, 1 - L);
  const v = L + S * m;
  return {
    h,
    s: v > 0 ? Math.round(((2 * S * m) / v) * 100) : 0,
    v: Math.round(v * 100),
  };
}

/** 浮层文本：两行——HSL 原值 + HSV 换算（+ 该次得分，若有） */
function tipText(label, c) {
  const hsv = hsvOf(c);
  const score = Number.isFinite(c.total) ? ` · ${c.total.toFixed(1)} 分` : '';
  return `${label} · HSL ${c.h}°, ${c.s}%, ${c.l}%${score}\nHSV ${hsv.h}°, ${hsv.s}%, ${hsv.v}%`;
}

/** 把浮层文本写成属性值：esc 后再把换行显式写成 &#10;，避免 HTML 源里的裸换行被规范化 */
const tipAttr = (label, c) => esc(tipText(label, c)).replace(/\n/g, '&#10;');

/** 读屏播报用的同一句话（HTML 模板路径），换行换成分隔符 */
const tipAria = (label, c) => esc(tipText(label, c).replace('\n', ' · '));

/**
 * setAttribute 路径专用：setAttribute 不会解码 HTML 实体，
 * 拿 esc/&#10; 写的串当原文写进属性，浮层就会把 "&#10;" 当字面文本显示，
 * 所以这里一律给未转义的裸文本（换行真实保留）。
 */
const tipPlain = (label, c) => tipText(label, c).replace('\n', ' · ');

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

/* ----------------------------------------------------------------------
 * 3. 评分算法
 *    色相用环形距离（0-180），饱和度/明度用线性差值（0-100）
 *    total = 100 * (0.65*scoreH + 0.20*scoreS + 0.15*scoreL)
 * -------------------------------------------------------------------- */
function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return Math.min(diff, 360 - diff);
}

function scoreOf(target, guess) {
  const w = CONFIG.SCORE.weights;
  const dH = hueDistance(target.h, guess.h);
  const cH = 1 - dH / CONFIG.SCORE.hueMaxDistance;
  const cS = 1 - Math.abs(target.s - guess.s) / 100;
  const cL = 1 - Math.abs(target.l - guess.l) / 100;
  return {
    dH: round1(dH),
    h: round1(cH * 100),
    s: round1(cS * 100),
    l: round1(cL * 100),
    total: round1(100 * (w.h * cH + w.s * cS + w.l * cL)),
  };
}

/** 三次得分 -> 最终得分（默认取最高分，可切平均分/末次）+ 最佳那次下标 */
function resolveFinal(attempts) {
  const totals = attempts.map((a) => a.score.total);
  const maxTotal = Math.max(...totals);
  const bestIndex = totals.indexOf(maxTotal);
  let final = maxTotal;
  if (CONFIG.SCORE.finalRule === 'avg') {
    final = round1(totals.reduce((sum, t) => sum + t, 0) / totals.length);
  } else if (CONFIG.SCORE.finalRule === 'last') {
    final = totals[totals.length - 1];
  }
  return { final, bestIndex };
}

function ratingFor(score) {
  const hit = CONFIG.RATINGS.find((r) => score >= r.min);
  return hit ? hit.label : CONFIG.RATINGS[CONFIG.RATINGS.length - 1].label;
}

/* ----------------------------------------------------------------------
 * 4. 出题与难度
 * -------------------------------------------------------------------- */

/** 难度越高 -> 饱和度高斯均值越左移（整体更"灰"，越难辨认） */
function meanSaturationFor(difficulty) {
  const d = CONFIG.DIFFICULTY;
  return clamp(
    d.meanSatBase - difficulty * d.meanSatPerLevel,
    d.meanSatFloor,
    d.meanSatCeil
  );
}

function generateTarget(difficulty) {
  const d = CONFIG.DIFFICULTY;
  return sanitizeColor({
    h: randInt(d.hueMin, d.hueMax - 1),
    s: clamp(Math.round(gaussian(meanSaturationFor(difficulty), d.satStd)), 0, 100),
    l: randInt(d.lightMin, d.lightMax),
  });
}

/* ----------------------------------------------------------------------
 * 5. 历史记录存储模块（localStorage 封装）
 *    结构：{ version, byDifficulty: { "3": [entry...] } }
 *    —— 难度桶是唯一事实来源："全部难度"列表与各项汇总（最高分 / 累计题数 /
 *       高分连击）均由桶实时派生，所以清空某个难度后不会出现两处数据自相矛盾。
 *    entry：{ id, time, question, difficulty, target, guesses:[{h,s,l,total}], final }
 *    列表一律"最新在前"；切换难度只影响读取哪个桶，绝不清空其它难度的数据。
 * -------------------------------------------------------------------- */
const HistoryStore = (() => {
  const blank = () => ({ version: 1, byDifficulty: {} });

  let cached = null;
  let available = true;

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const target = sanitizeColor(raw.target);
    if (!target) return null;
    const guesses = (Array.isArray(raw.guesses) ? raw.guesses : [])
      .slice(0, CONFIG.MAX_GUESSES)
      .map((g) => {
        const c = sanitizeColor(g);
        if (!c) return null;
        return { ...c, total: num(g && g.total, 0, 100, 0) };
      })
      .filter(Boolean);
    if (!guesses.length) return null;
    const difficulty = Math.round(num(raw.difficulty, CONFIG.DIFFICULTY.min, CONFIG.DIFFICULTY.max, CONFIG.DIFFICULTY.default));
    const totals = guesses.map((g) => g.total);
    const final = num(raw.final, 0, 100, Math.max(...totals));
    return {
      id: typeof raw.id === 'string' ? raw.id : `d${difficulty}-${totals.length}-${final}`,
      time: num(raw.time, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      question: Math.round(num(raw.question, 0, Number.MAX_SAFE_INTEGER, 0)),
      difficulty,
      target,
      guesses,
      final,
    };
  }

  function normalize(raw) {
    const base = blank();
    if (!raw || typeof raw !== 'object') return base;
    const push = (entry) => {
      const key = String(entry.difficulty);
      if (!base.byDifficulty[key]) base.byDifficulty[key] = [];
      base.byDifficulty[key].push(entry);
    };
    // 以难度桶的 key 为准（key 与 entry.difficulty 不一致时以 key 修正，避免读到错桶）
    if (raw.byDifficulty && typeof raw.byDifficulty === 'object') {
      Object.keys(raw.byDifficulty).forEach((key) => {
        const bucketKey = Math.round(num(key, CONFIG.DIFFICULTY.min, CONFIG.DIFFICULTY.max, NaN));
        const list = Array.isArray(raw.byDifficulty[key]) ? raw.byDifficulty[key] : [];
        list.forEach((item) => {
          const entry = normalizeEntry(item);
          if (!entry) return;
          push(Number.isFinite(bucketKey) ? { ...entry, difficulty: bucketKey } : entry);
        });
      });
    }
    // 兼容旧版结构里单独存放的 global 数组：按各自难度归入桶中
    if (Array.isArray(raw.global)) {
      raw.global.forEach((item) => {
        const entry = normalizeEntry(item);
        if (entry) push(entry);
      });
    }
    Object.keys(base.byDifficulty).forEach((key) => {
      base.byDifficulty[key] = base.byDifficulty[key]
        .sort((a, b) => b.time - a.time)
        .slice(0, CONFIG.HISTORY.maxPerBucket);
      if (!base.byDifficulty[key].length) delete base.byDifficulty[key];
    });
    return base;
  }

  function read() {
    if (cached) return cached;
    let raw = null;
    try {
      const text = window.localStorage.getItem(CONFIG.STORAGE_KEY);
      if (text) raw = JSON.parse(text);
    } catch (err) {
      // 隐私模式 / 配额满 / JSON 损坏：降级为内存存储，本次会话仍可用
      available = false;
    }
    cached = normalize(raw);
    return cached;
  }

  function write() {
    if (!available) return false;
    try {
      window.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(cached));
      return true;
    } catch (err) {
      available = false;
      return false;
    }
  }

  function add(entry) {
    const data = read();
    const key = String(entry.difficulty);
    if (!data.byDifficulty[key]) data.byDifficulty[key] = [];
    data.byDifficulty[key] = [entry, ...data.byDifficulty[key]].slice(0, CONFIG.HISTORY.maxPerBucket);
    return write();
  }

  /** 跨难度合并（最新在前），"全部难度"视图与派生统计都走这里 */
  function all() {
    const data = read();
    const merged = [];
    Object.keys(data.byDifficulty).forEach((key) => merged.push(...data.byDifficulty[key]));
    return merged.sort((a, b) => b.time - a.time);
  }

  /** scope: 'difficulty' | 'global' */
  function list(scope, difficulty) {
    if (scope === 'global') return all();
    return read().byDifficulty[String(difficulty)] || [];
  }

  /** 清空：scope='global' 清所有难度桶，否则只清该难度桶（派生数据自动跟着变） */
  function clear(scope, difficulty) {
    const data = read();
    if (scope === 'global') data.byDifficulty = {};
    else delete data.byDifficulty[String(difficulty)];
    return write();
  }

  /** 汇总指标全部从现存记录派生，不额外落盘，因此删掉哪桶、指标就立刻反映哪桶 */
  function meta() {
    const desc = all();
    const out = {
      totalRounds: desc.length,
      bestScore: 0,
      bestScoreDifficulty: 0,
      currentStreak: 0,
      bestStreak: 0,
    };
    desc.forEach((e) => {
      if (e.final > out.bestScore) {
        out.bestScore = e.final;
        out.bestScoreDifficulty = e.difficulty;
      }
    });
    // 当前连击：从最新一题往回连续 >= 阈值
    for (const e of desc) {
      if (e.final >= CONFIG.STREAK.threshold) out.currentStreak += 1;
      else break;
    }
    // 最长连击：按时间正序扫描一遍
    let run = 0;
    for (let i = desc.length - 1; i >= 0; i -= 1) {
      run = desc[i].final >= CONFIG.STREAK.threshold ? run + 1 : 0;
      out.bestStreak = Math.max(out.bestStreak, run);
    }
    return out;
  }

  function isAvailable() {
    if (available) {
      try {
        window.localStorage.setItem(`${CONFIG.STORAGE_KEY}.probe`, '1');
        window.localStorage.removeItem(`${CONFIG.STORAGE_KEY}.probe`);
        return true;
      } catch (err) {
        available = false;
      }
    }
    return false;
  }

  return { add, list, all, clear, meta, isAvailable, _read: read };
})();

/** 最近 N 题的统计口径：平均分（即准确率）/ 最高 / 最低 / 稳定度（标准差） */
function computeStats(entries, limit) {
  const list = entries.slice(0, limit);
  if (!list.length) {
    return { count: 0, avg: 0, max: 0, min: 0, std: 0, best: null };
  }
  const scores = list.map((e) => e.final);
  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = sum / scores.length;
  const variance = scores.reduce((a, b) => a + (b - avg) ** 2, 0) / scores.length;
  const max = Math.max(...scores);
  const best = list.find((e) => e.final === max) || null;
  return {
    count: scores.length,
    avg: round1(avg),
    max: round1(max),
    min: round1(Math.min(...scores)),
    std: round1(Math.sqrt(variance)),
    best,
  };
}

/* ----------------------------------------------------------------------
 * 6. 分享：URL 查询参数 + base64url 压缩载荷
 *    题目： ?h=210&s=45&l=60&d=5
 *    成绩： ?share=result&data=<base64url>
 *    历史： ?share=history&data=<base64url>
 *    全部基于 location.origin + pathname 拼装，GitHub Pages 子路径同样可用。
 * -------------------------------------------------------------------- */
const Share = (() => {
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

  function encode(payload) {
    try {
      return utf8ToBase64Url(JSON.stringify(payload));
    } catch (err) {
      return '';
    }
  }

  function decode(text) {
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

  function puzzleUrl(color, difficulty) {
    return buildUrl({ h: color.h, s: color.s, l: color.l, d: difficulty });
  }

  /** 历史载荷：默认带三次猜测颜色；链接过长时退化为"仅摘要 + 最佳色" */
  function historyUrl(entries, stats, scope) {
    // scope 字段存可读值：'all' 或具体难度数字（不存 'difficulty' 这种内部枚举）
    const scopeLabel = scope === 'global' ? 'all' : entries[0] ? entries[0].difficulty : 'unknown';
    const slim = (withColors) => ({
      t: 'h',
      v: CONFIG.SHARE.version,
      scope: scopeLabel,
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
          // 退化时带上 best 自己的得分，否则读不到只能拿整题 final 当“第 1 次”分数
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

  function resultUrl(round) {
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

  /** 解析地址栏 -> { share } | { puzzle } | null */
  function readRoute() {
    const params = new URLSearchParams(window.location.search);
    const shareKind = params.get('share');
    if (shareKind === 'history' || shareKind === 'result') {
      const payload = decode(params.get('data') || '');
      return payload && payload.t === (shareKind === 'history' ? 'h' : 'r')
        ? { share: shareKind, payload }
        : { share: shareKind, payload: null };
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

  return { buildUrl, puzzleUrl, historyUrl, resultUrl, readRoute, encode, decode };
})();

/* ----------------------------------------------------------------------
 * 6.5 即时数值浮层：悬停 / 键盘聚焦 / 触屏点击都能看到 HSL 与 HSV
 *     数值以前只挂在 title 上：触屏与键盘拿不到，原生提示还要等约一秒。
 *     浮层挂在 body 上用 position:fixed 定位，不会被 .history 的 overflow 滚动容器裁掉；
 *     用 document 委托监听，历史列表反复 innerHTML 重渲染也不需重新绑定。
 * -------------------------------------------------------------------- */
const Tip = (() => {
  const box = document.createElement('div');
  box.className = 'tip';
  box.hidden = true;
  let current = null;

  const owner = (e) => (e.target && e.target.closest ? e.target.closest('[data-tip]') : null);

  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) {
      hide();
      return;
    }
    if (box.textContent !== text) box.textContent = text;
    box.hidden = false;
    current = target;
    // 先量尺寸再定位（hidden=false 之后才能量到）
    const r = target.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    let left = r.left + r.width / 2 - b.width / 2;
    left = clamp(left, 8, Math.max(8, window.innerWidth - b.width - 8));
    let top = r.top - b.height - 8;
    if (top < 8) top = r.bottom + 8; // 上方放不下就翻到下方
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hide() {
    current = null;
    box.hidden = true;
  }

  function bind() {
    document.body.appendChild(box);
    document.addEventListener('mouseover', (e) => {
      const t = owner(e);
      if (t) show(t);
      else if (current) hide();
    });
    document.addEventListener('focusin', (e) => {
      const t = owner(e);
      if (t) show(t);
      else if (current) hide();
    });
    document.addEventListener('focusout', () => {
      if (current) hide();
    });
    // 触屏没有 hover，点一下色块同样出数值
    document.addEventListener('click', (e) => {
      const t = owner(e);
      if (t) show(t);
    });
    document.addEventListener('mouseleave', hide);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    window.addEventListener('scroll', () => {
      if (current) hide();
    }, true);
    window.addEventListener('resize', hide);
  }

  return { bind, show, hide };
})();

/* ----------------------------------------------------------------------
 * 7. 状态与 DOM 引用
 * -------------------------------------------------------------------- */
const state = {
  difficulty: CONFIG.DIFFICULTY.default,
  target: generateTarget(CONFIG.DIFFICULTY.default),
  guess: { ...CONFIG.ROUND_DEFAULT },
  attempts: [], // [{h,s,l,score:{h,s,l,total,dH}}]
  finalized: false,
  final: 0,
  bestIndex: -1,
  autoAdvance: false,
  revealTarget: false,
  scope: 'difficulty', // 最近几题读取口径
  recentCount: CONFIG.HISTORY.recentDefault,
  fromLink: false, // 由分享题目链接进入
  readOnly: false,
};

const el = {};
function cacheDom() {
  [
    'levelBadge',
    'contextBanner',
    'mainLayout',
    'shareView',
    'shareTitle',
    'shareBody',
    'btnExitShare',
    'difficultySelect',
    'autoDifficulty',
    'revealTarget',
    'levelHint',
    'targetSwatch',
    'guessSwatch',
    'targetReadout',
    'guessReadout',
    'guessList',
    'stageNote',
    'rangeHue',
    'rangeSat',
    'rangeLight',
    'outHue',
    'outSat',
    'outLight',
    'btnSubmit',
    'submitCount',
    'btnReset',
    'btnNext',
    'feedbackCard',
    'resultCard',
    'shareLink',
    'btnCopyLink',
    'btnCopyResult',
    'historyPanel',
    'recentCount',
    'stats',
    'metaLine',
    'historyList',
    'historyEmpty',
    'btnViewHistory',
    'btnShareHistory',
    'btnClearHistory',
    'toast',
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
  el.segButtons = Array.from(document.querySelectorAll('.seg__btn'));
}

/* ----------------------------------------------------------------------
 * 8. 渲染
 * -------------------------------------------------------------------- */
let toastTimer = null;
function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', Boolean(isError));
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

function renderLevelRow() {
  el.levelBadge.textContent = `难度 ${state.difficulty}`;
  el.difficultySelect.value = String(state.difficulty);
  const meanS = Math.round(meanSaturationFor(state.difficulty));
  el.levelHint.textContent = `本难度饱和度均值 ≈ ${meanS}%（难度越高越灰，越难辨认）`;
}

function renderSwatches() {
  el.targetSwatch.style.backgroundColor = hslCss(state.target);
  el.guessSwatch.style.backgroundColor = hslCss(state.guess);

  const showTarget = state.revealTarget || state.finalized;
  el.targetReadout.textContent = showTarget ? hslLabel(state.target) : 'H *** · S *** · L ***';
  el.targetReadout.classList.toggle('is-muted', !showTarget);
  el.guessReadout.textContent = `${hslLabel(state.guess)}（当前调整）`;

  // 色块悬停即出 HSL / HSV；目标色在未揭晓时不给浮层（防作弊）
  // 此处用 setAttribute，必须写未转义的裸文本（见 tipPlain 注释）
  el.guessSwatch.setAttribute('data-tip', tipText('我的颜色', state.guess));
  el.guessSwatch.setAttribute('aria-label', tipPlain('我的颜色', state.guess));
  if (showTarget) {
    el.targetSwatch.setAttribute('data-tip', tipText('目标色', state.target));
    el.targetSwatch.setAttribute('aria-label', tipPlain('目标色', state.target));
  } else {
    el.targetSwatch.removeAttribute('data-tip');
    el.targetSwatch.setAttribute('aria-label', '目标颜色（数值未揭晓）');
  }
}

function renderSliders() {
  el.rangeHue.value = String(state.guess.h);
  el.rangeSat.value = String(state.guess.s);
  el.rangeLight.value = String(state.guess.l);
  el.outHue.textContent = `${state.guess.h}°`;
  el.outSat.textContent = `${state.guess.s}%`;
  el.outLight.textContent = `${state.guess.l}%`;

  const { h, s, l } = state.guess;
  // 饱和度 / 明度轨道跟着当前取值变，所见即所得；色相条由 CSS 固定为彩虹（.range--hue）
  // 饱和度轨道的 L 先限制在 [12,88]：取真实的 0 / 100 时整条会塌成纯黑或纯白，等于没有反馈
  const lPrev = clamp(l, 12, 88);
  el.rangeSat.style.setProperty(
    '--track',
    `linear-gradient(to right, hsl(${h}, 0%, ${lPrev}%), hsl(${h}, 100%, ${lPrev}%))`
  );
  el.rangeLight.style.setProperty(
    '--track',
    `linear-gradient(to right, hsl(${h}, ${s}%, 0%), hsl(${h}, ${s}%, 50%), hsl(${h}, ${s}%, 100%))`
  );

  // 读数框之外再给屏幕阅读器一条带单位的播报（原生 range 只会念裸数字）
  el.rangeHue.setAttribute('aria-valuetext', `${state.guess.h} 度`);
  el.rangeSat.setAttribute('aria-valuetext', `${state.guess.s}%`);
  el.rangeLight.setAttribute('aria-valuetext', `${state.guess.l}%`);
}

/** 三个圆形猜测记录位：未用=虚线空心圆；已用=纯色；结算后才附数值 */
function renderGuessList() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < CONFIG.MAX_GUESSES; i += 1) {
    const attempt = state.attempts[i];
    const li = document.createElement('li');
    li.className = 'guess';

    const dot = document.createElement('span');
    dot.className = 'guess__dot';
    dot.setAttribute('role', 'img');
    const label = document.createElement('span');
    label.className = 'guess__label';
    label.textContent = `第 ${i + 1} 次`;

    if (attempt) {
      dot.style.backgroundColor = hslCss(attempt);
      if (state.finalized && i === state.bestIndex) {
        li.classList.add('is-best');
      }
      // 猜测色是自己的输入，不是答案，提交完立刻可 hover 回看；
      // 需要被守到结算的只有目标色（见 renderSwatches）
      const tipColor = { ...attempt, total: attempt.score.total };
      dot.setAttribute('data-tip', tipText(`第 ${i + 1} 次`, tipColor));
      dot.setAttribute('aria-label', tipPlain(`第 ${i + 1} 次`, tipColor));
      if (state.finalized) {
        // 结算后：圆点下方再补一份写死的 HSL 与得分，并标出最佳那次
        const detail = document.createElement('p');
        detail.className = 'guess__detail';
        detail.innerHTML =
          `${esc(hslPlain(attempt))}<br><strong>${esc(attempt.score.total.toFixed(1))}</strong>` +
          (state.bestIndex === i ? ' ★' : '');
        li.append(dot, label, detail);
      } else {
        li.append(dot, label);
      }
    } else {
      dot.classList.add('is-empty');
      dot.textContent = String(i + 1);
      dot.style.color = '#b1b5bf';
      li.append(dot, label);
    }
    frag.appendChild(li);
  }
  el.guessList.replaceChildren(frag);

  const used = state.attempts.length;
  el.stageNote.textContent = state.finalized
    ? '三次机会已用完，圆点带 ★ 的是本题最佳一次。点"下一题"继续。'
    : used === 0
    ? '提交后，本次猜测会凝固成圆形色块；悬停 / 点击色块可回看它的 HSL 与 HSV。'
    : `已用 ${used} / ${CONFIG.MAX_GUESSES} 次机会，可继续微调滑块再提交（旧圆点悬停可看数值）。`;
}

function renderFeedback() {
  const card = el.feedbackCard;
  if (!state.attempts.length || state.finalized) {
    card.hidden = true;
    return;
  }
  const last = state.attempts[state.attempts.length - 1];
  const left = CONFIG.MAX_GUESSES - state.attempts.length;
  card.hidden = false;
  card.innerHTML = `
    <h3 class="card__title">第 ${state.attempts.length} 次提交 · 本次得分</h3>
    <p class="card__score">${esc(last.score.total.toFixed(1))}<small> / 100</small></p>
    <dl class="card__grid">
      <div><dt>色相得分（权重 ${CONFIG.SCORE.weights.h}）</dt><dd>${esc(last.score.h.toFixed(1))}</dd></div>
      <div><dt>饱和度得分（权重 ${CONFIG.SCORE.weights.s}）</dt><dd>${esc(last.score.s.toFixed(1))}</dd></div>
      <div><dt>明度得分（权重 ${CONFIG.SCORE.weights.l}）</dt><dd>${esc(last.score.l.toFixed(1))}</dd></div>
      <div><dt>色相环形偏差</dt><dd>${esc(last.score.dH.toFixed(1))}°</dd></div>
    </dl>
    <p class="card__rating" style="color:var(--ink-soft)">还剩 ${left} 次机会，可继续调整后再提交。</p>
  `;
}

function renderResultCard() {
  const card = el.resultCard;
  if (!state.finalized) {
    card.hidden = true;
    return;
  }
  const best = state.attempts[state.bestIndex];
  const rows = state.attempts
    .map(
      (a, i) => `
        <li>
          <span class="card__chip" style="background:${esc(hslCss(a))}"></span>
          <span>第 ${i + 1} 次 · HSL ${esc(hslPlain(a))} · ${esc(a.score.total.toFixed(1))} 分</span>
          ${i === state.bestIndex ? '<strong>★ 最佳</strong>' : ''}
        </li>`
    )
    .join('');
  card.hidden = false;
  card.innerHTML = `
    <h3 class="card__title">本题结算 · 最终得分（三次最高）</h3>
    <p class="card__score">${esc(state.final.toFixed(1))}<small> / 100</small></p>
    <p class="card__rating">${esc(ratingFor(state.final))}</p>
    <dl class="card__grid">
      <div><dt>最佳那次 · 色相得分</dt><dd>${esc(best.score.h.toFixed(1))}</dd></div>
      <div><dt>最佳那次 · 饱和度得分</dt><dd>${esc(best.score.s.toFixed(1))}</dd></div>
      <div><dt>最佳那次 · 明度得分</dt><dd>${esc(best.score.l.toFixed(1))}</dd></div>
      <div><dt>难度</dt><dd>${esc(state.difficulty)}</dd></div>
      <div><dt>目标色</dt><dd>${esc(hslLabel(state.target))}</dd></div>
      <div><dt>最佳猜测</dt><dd>${esc(hslLabel(best))}</dd></div>
    </dl>
    <ul class="card__list">${rows}</ul>
  `;
}

function renderActions() {
  const exhausted = state.finalized || state.attempts.length >= CONFIG.MAX_GUESSES;
  el.btnSubmit.disabled = exhausted;
  const nextIndex = Math.min(state.attempts.length + 1, CONFIG.MAX_GUESSES);
  el.submitCount.textContent = exhausted
    ? `${CONFIG.MAX_GUESSES} / ${CONFIG.MAX_GUESSES}`
    : `${nextIndex} / ${CONFIG.MAX_GUESSES}`;
  el.btnReset.disabled = state.finalized;
  el.btnCopyResult.disabled = !state.attempts.length;
}

/**
 * 历史行里的色块组：方形目标点 + 三个圆形猜测点（本地面板与只读分享视图共用）
 * 每个点下方直接写该次得分；悬停 / 点击出 HSL 与 HSV；读屏走 aria-label。
 * bestIdx 永远按三次得分现算，不写死下标；labels 可覆盖“第 N 次”叫法（退化载荷只有一个点）。
 */
function historyDots(target, guesses, labels) {
  const totals = guesses.map((g) => g.total);
  const bestIdx = totals.length ? totals.indexOf(Math.max(...totals)) : -1;
  const cells = [];

  if (target) {
    const label = '目标色';
    cells.push(
      '<span class="dot-cell dot-cell--target">' +
        `<span class="dot-sm dot-sm--target" style="background-color:${esc(hslCss(target))}"` +
        ` data-tip="${tipAttr(label, target)}" role="img" aria-label="${tipAria(label, target)}"></span>` +
        '<span class="dot-cell__cap">目标</span>' +
        '</span>'
    );
  }
  guesses.forEach((g, i) => {
    const label = (labels && labels[i]) || `第 ${i + 1} 次`;
    cells.push(
      '<span class="dot-cell">' +
        `<span class="dot-sm${i === bestIdx ? ' is-best' : ''}" style="background-color:${esc(hslCss(g))}"` +
        ` data-tip="${tipAttr(label, g)}" role="img" aria-label="${tipAria(label, g)}"></span>` +
        `<span class="dot-cell__cap">${esc(Number.isFinite(g.total) ? g.total.toFixed(1) : '—')}</span>` +
        '</span>'
    );
  });
  return `<div class="history__dots">${cells.join('')}</div>`;
}

function renderHistory() {
  const entries = HistoryStore.list(state.scope, state.difficulty);
  const stats = computeStats(entries, state.recentCount);
  const meta = HistoryStore.meta();
  const scopeName = state.scope === 'global' ? '全部难度' : `难度 ${state.difficulty}`;

  el.stats.innerHTML = `
    <div class="stats__item"><span class="stats__k">平均准确率</span><span class="stats__v">${esc(
      stats.count ? `${stats.avg.toFixed(1)}%` : '—'
    )}</span></div>
    <div class="stats__item"><span class="stats__k">最高分</span><span class="stats__v">${esc(
      stats.count ? stats.max.toFixed(1) : '—'
    )}</span></div>
    <div class="stats__item"><span class="stats__k">最低分</span><span class="stats__v">${esc(
      stats.count ? stats.min.toFixed(1) : '—'
    )}</span></div>
    <div class="stats__item"><span class="stats__k">稳定度 σ</span><span class="stats__v">${esc(
      stats.count ? stats.std.toFixed(1) : '—'
    )}</span></div>
    <div class="stats__item"><span class="stats__k">样本数</span><span class="stats__v">${esc(
      `${stats.count} 题`
    )}</span></div>
  `;

  el.metaLine.textContent =
    `${scopeName} · 最近 ${stats.count} 题` +
    `｜累计 ${meta.totalRounds} 题` +
    `｜历史最高 ${meta.bestScore ? meta.bestScore.toFixed(1) + ' 分' : '—'}` +
    (meta.bestScoreDifficulty ? `（难度 ${meta.bestScoreDifficulty}）` : '') +
    `｜≥${CONFIG.STREAK.threshold} 分连击 ${meta.currentStreak}（最长 ${meta.bestStreak}）`;

  el.historyList.innerHTML = entries
    .slice(0, state.recentCount)
    .map(
      (e, idx) => `
        <li class="history__item">
          <div class="history__top">
            <span>#${e.question || entries.length - idx} · 难度 ${e.difficulty} · ${esc(
        formatTime(e.time)
      )}</span>
            <span class="history__rating">${esc(ratingFor(e.final))}</span>
            <span class="history__score">${esc(e.final.toFixed(1))} 分</span>
          </div>
          ${historyDots(e.target, e.guesses)}
        </li>`
    )
    .join('');

  el.historyEmpty.hidden = entries.length > 0;
  el.historyList.hidden = entries.length === 0;
}

function renderShareLink() {
  el.shareLink.value = Share.puzzleUrl(state.target, state.difficulty);
}

function renderGame() {
  renderLevelRow();
  renderSwatches();
  renderSliders();
  renderGuessList();
  renderFeedback();
  renderResultCard();
  renderActions();
  renderHistory();
  renderShareLink();
}

/* ----------------------------------------------------------------------
 * 9. 回合流转
 * -------------------------------------------------------------------- */
function newRound() {
  state.target = generateTarget(state.difficulty);
  state.guess = { ...CONFIG.ROUND_DEFAULT };
  state.attempts = [];
  state.finalized = false;
  state.final = 0;
  state.bestIndex = -1;
  state.fromLink = false;
  renderGame();
}

function submitGuess() {
  if (state.readOnly || state.finalized || state.attempts.length >= CONFIG.MAX_GUESSES) return;
  const score = scoreOf(state.target, state.guess);
  state.attempts.push({ ...state.guess, score });
  if (state.attempts.length === CONFIG.MAX_GUESSES) finalizeRound();
  renderGame();
  if (!state.finalized) {
    const dot = el.guessList.children[state.attempts.length - 1];
    if (dot) dot.classList.add('is-new');
  }
}

function finalizeRound() {
  const { final, bestIndex } = resolveFinal(state.attempts);
  state.finalized = true;
  state.final = final;
  state.bestIndex = bestIndex;

  const meta = HistoryStore.meta();
  const entry = {
    id: `d${state.difficulty}-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
    time: Date.now(),
    question: meta.totalRounds + 1,
    difficulty: state.difficulty,
    target: { ...state.target },
    final,
    // 存储三份猜测（含各自得分），供历史面板画小圆点与分享复用
    guesses: state.attempts.map((a) => ({ h: a.h, s: a.s, l: a.l, total: a.score.total })),
  };
  const saved = HistoryStore.add(entry);
  if (!saved) {
    toast('浏览器存储不可用，本题成绩只保留在当前页面', true);
  }

  if (state.autoAdvance) {
    const d = CONFIG.DIFFICULTY;
    const before = state.difficulty;
    if (final >= CONFIG.AUTO.upThreshold) {
      state.difficulty = clamp(state.difficulty + 1, d.min, d.max);
    } else if (final < CONFIG.AUTO.downThreshold) {
      state.difficulty = clamp(state.difficulty - 1, d.min, d.max);
    }
    if (before !== state.difficulty) {
      window.setTimeout(
        () => toast(`按表现自动调整为难度 ${state.difficulty}（历史记录仍各自保留）`),
        60
      );
    }
  }
}

function nextQuestion() {
  if (!state.finalized && state.attempts.length) {
    const ok = window.confirm('当前题目还没用完三次机会，换题会丢弃这几次尝试（历史记录不受影响）。继续吗？');
    if (!ok) return;
  }
  newRound();
}

function resetAdjustment() {
  if (state.finalized) return;
  state.guess = { ...CONFIG.ROUND_DEFAULT };
  renderSwatches();
  renderSliders();
  renderShareLink();
  toast('已把滑块恢复到初始值');
}

/* ---------------------------------- 分享动作 -------------------------------- */
async function copyText(text, successMessage) {
  // 不管走哪条路径，先把链接规进只读输入框：用户看得见复制内容，也能手动重选
  el.shareLink.value = text;
  // 优先 Clipboard API（GitHub Pages 的 https 环境属于安全上下文）
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage);
      return;
    } catch (err) {
      /* 继续走降级方案 */
    }
  }
  // 降级：选中输入框内容，老浏览器 execCommand，再不行让用户直接 Ctrl/Cmd+C
  el.shareLink.focus();
  el.shareLink.select();
  try {
    const ok = document.execCommand('copy');
    toast(ok ? successMessage : '链接已选中，按 Ctrl/Cmd + C 手动复制');
  } catch (err) {
    toast('链接已选中，按 Ctrl/Cmd + C 手动复制');
  }
}

function sharePuzzleLink() {
  copyText(el.shareLink.value, '题目链接已复制，对方打开就是同一道题');
}

function shareCurrentResult() {
  if (!state.attempts.length) {
    toast('至少提交一次猜测后才能分享成绩', true);
    return;
  }
  const round = {
    difficulty: state.difficulty,
    target: state.target,
    attempts: state.attempts,
    final: state.finalized ? state.final : Math.max(...state.attempts.map((a) => a.score.total)),
  };
  copyText(Share.resultUrl(round), '本题成绩链接已复制（只读展示）');
}

function shareRecentHistory() {
  const entries = HistoryStore.list(state.scope, state.difficulty);
  if (!entries.length) {
    toast(`${state.scope === 'global' ? '全部难度' : `难度 ${state.difficulty}`}还没有记录`, true);
    return;
  }
  const stats = computeStats(entries, state.recentCount);
  copyText(
    Share.historyUrl(entries, stats, state.scope),
    `最近 ${stats.count} 题成绩链接已复制（只读展示，均分 ${stats.avg.toFixed(1)}）`
  );
}

function clearHistory() {
  const scopeName = state.scope === 'global' ? '全部难度' : `难度 ${state.difficulty}`;
  const entries = HistoryStore.list(state.scope, state.difficulty);
  if (!entries.length) {
    toast(`${scopeName}下没有可清空的历史记录`, true);
    return;
  }
  // 二次确认，避免误删
  const first = window.confirm(`将清空【${scopeName}】的 ${entries.length} 条最近记录。确认继续？`);
  if (!first) return;
  const second = window.confirm('这是不可恢复的操作，且只影响本地浏览器。真的要清空吗？');
  if (!second) return;
  HistoryStore.clear(state.scope, state.difficulty);
  renderHistory();
  toast(`已清空【${scopeName}】的历史记录`);
}

/* ----------------------------------------------------------------------
 * 10. 只读分享视图
 * -------------------------------------------------------------------- */
/** 圆点图例：方形 = 目标色，圆形 = 各次猜测，双环 + ★ = 最佳一次 */
const LEGEND_HTML =
  '<p class="dot-legend">' +
  '<span class="dot-sm dot-sm--target"></span>目标色' +
  '<span class="dot-sm is-best"></span>最佳一次（双环 + ★）' +
  '<span>圆点下数字 = 该次得分，悬停 / 点击看 HSL 与 HSV</span>' +
  '</p>';

function renderShareView(kind, payload) {
  el.mainLayout.hidden = true;
  el.shareView.hidden = false;
  state.readOnly = true;
  document.title = kind === 'history' ? '最近成绩摘要 · 颜色比色挑战' : '本题成绩 · 颜色比色挑战';

  if (!payload) {
    el.shareTitle.textContent = '链接内容无法解析';
    el.shareBody.innerHTML =
      '<p class="history-empty">分享参数缺失或已损坏，请让对方重新生成分享链接。</p>';
    return;
  }

  if (kind === 'history') {
    el.shareTitle.textContent = '最近成绩摘要（只读）';
    const rounds = (Array.isArray(payload.rounds) ? payload.rounds : []).slice(0, CONFIG.SHARE.maxRounds);
    // 摘要数字直接取载荷；缺失时按 rounds 兜底重算
    const finals = rounds.map((r) => num(r.f, 0, 100, 0));
    const avg = num(payload.avg, 0, 100, finals.length ? round1(finals.reduce((a, b) => a + b, 0) / finals.length) : 0);
    const max = num(payload.max, 0, 100, finals.length ? Math.max(...finals) : 0);
    const min = num(payload.min, 0, 100, finals.length ? Math.min(...finals) : 0);
    const scopeName =
      payload.scope === 'all'
        ? '全部难度'
        : Number.isFinite(Number(payload.scope)) && Number(payload.scope) > 0
        ? `难度 ${Number(payload.scope)}`
        : '本地记录';
    const items = rounds
      .map((r) => {
        const guesses = Array.isArray(r.g)
          ? r.g.map((g) => ({
              h: num(g && g[0], 0, 360, 0),
              s: num(g && g[1], 0, 100, 0),
              l: num(g && g[2], 0, 100, 0),
              total: num(g && g[3], 0, 100, 0),
            }))
          : [];
        const target = Array.isArray(r.c)
          ? [
              {
                h: num(r.c[0], 0, 360, 0),
                s: num(r.c[1], 0, 100, 0),
                l: num(r.c[2], 0, 100, 0),
              },
            ]
          : [];
        const score = num(r.f, 0, 100, 0);
        // 链接过长退化时载荷只剩 best 一个色（b），它本身就是最佳那次；
        // 带完整三次（g）时交给 historyDots 按各次得分现算最佳下标
        let shown = guesses;
        let labels = null;
        if (!shown.length && Array.isArray(r.b)) {
          shown = [
            {
              h: num(r.b[0], 0, 360, 0),
              s: num(r.b[1], 0, 100, 0),
              l: num(r.b[2], 0, 100, 0),
              total: num(r.b[3], 0, 100, score),
            },
          ];
          labels = ['最佳一次'];
        }
        const qno = num(r.q, 1, 999999, 0);
        return `
          <li class="history__item">
            <div class="history__top">
              <span>${qno ? `#${qno} · ` : ''}难度 ${esc(num(r.d, CONFIG.DIFFICULTY.min, CONFIG.DIFFICULTY.max, 1))} · 准确率</span>
              <span class="history__rating">${esc(ratingFor(score))}</span>
              <span class="history__score">${esc(score.toFixed(1))} 分</span>
            </div>
            ${historyDots(target.length ? target[0] : null, shown, labels)}
          </li>`;
      })
      .join('');
    el.shareBody.innerHTML = `
      <dl class="stats">
        <div class="stats__item"><span class="stats__k">题目数</span><span class="stats__v">${esc(
          num(payload.n, 0, 999, rounds.length)
        )} 题</span></div>
        <div class="stats__item"><span class="stats__k">平均准确率</span><span class="stats__v">${esc(
          rounds.length ? `${avg.toFixed(1)}%` : '—'
        )}</span></div>
        <div class="stats__item"><span class="stats__k">最高分</span><span class="stats__v">${esc(
          rounds.length ? max.toFixed(1) : '—'
        )}</span></div>
        <div class="stats__item"><span class="stats__k">最低分</span><span class="stats__v">${esc(
          rounds.length ? min.toFixed(1) : '—'
        )}</span></div>
        <div class="stats__item"><span class="stats__k">稳定度 σ</span><span class="stats__v">${esc(
          rounds.length ? num(payload.std, 0, 100, 0).toFixed(1) : '—'
        )}</span></div>
      </dl>
      <p class="meta-line">来源：${esc(scopeName)}</p>
      ${LEGEND_HTML}
      ${items ? `<ol class="history">${items}</ol>` : '<p class="history-empty">链接只包含摘要数字，没有逐题记录。</p>'}
    `;
    return;
  }

  // 单题成绩分享（只读对比）
  el.shareTitle.textContent = '本题成绩（只读）';
  const target = sanitizeColor({
    h: payload.c && payload.c[0],
    s: payload.c && payload.c[1],
    l: payload.c && payload.c[2],
  });
  const guesses = (Array.isArray(payload.g) ? payload.g : [])
    .slice(0, CONFIG.MAX_GUESSES)
    .map((g) => {
      const c = sanitizeColor({ h: g && g[0], s: g && g[1], l: g && g[2] });
      return c ? { ...c, total: num(g && g[3], 0, 100, 0) } : null;
    })
    .filter(Boolean);
  if (!target || !guesses.length) {
    el.shareBody.innerHTML = '<p class="history-empty">成绩数据不完整，无法展示对比。</p>';
    return;
  }
  const totals = guesses.map((g) => g.total);
  const bestIdx = totals.indexOf(Math.max(...totals));
  const final = num(payload.f, 0, 100, Math.max(...totals));
  el.shareBody.innerHTML = `
    <div class="stage">
      <div class="stage__pair">
        <div class="swatch-box">
          <div class="swatch" style="background:${esc(hslCss(target))}" data-tip="${tipAttr('目标色', target)}" role="img" aria-label="${tipAria('目标色', target)}"></div>
          <div class="swatch-box__meta"><p class="swatch-box__name">目标色</p><p class="swatch-box__value">${esc(
            hslLabel(target)
          )}</p></div>
        </div>
        <div class="swatch-box">
          <div class="swatch" style="background:${esc(hslCss(guesses[bestIdx]))}" data-tip="${tipAttr('最佳猜测', guesses[bestIdx])}" role="img" aria-label="${tipAria('最佳猜测', guesses[bestIdx])}"></div>
          <div class="swatch-box__meta"><p class="swatch-box__name">最佳猜测</p><p class="swatch-box__value">${esc(
            hslLabel(guesses[bestIdx])
          )}</p></div>
        </div>
      </div>
      <ol class="guesses">
        ${guesses
          .map(
            (g, i) => `
          <li class="guess${i === bestIdx ? ' is-best' : ''}">
            <span class="guess__dot" style="background:${esc(hslCss(g))}" data-tip="${tipAttr(`第 ${i + 1} 次`, g)}" role="img" aria-label="${tipAria(`第 ${i + 1} 次`, g)}"></span>
            <span class="guess__label">第 ${i + 1} 次</span>
            <p class="guess__detail">${esc(hslPlain(g))}<br><strong>${esc(g.total.toFixed(1))}</strong>${i === bestIdx ? ' ★' : ''}</p>
          </li>`
          )
          .join('')}
      </ol>
    </div>
    <dl class="stats">
      <div class="stats__item"><span class="stats__k">难度</span><span class="stats__v">${esc(
        num(payload.d, CONFIG.DIFFICULTY.min, CONFIG.DIFFICULTY.max, 1)
      )}</span></div>
      <div class="stats__item"><span class="stats__k">最终得分</span><span class="stats__v">${esc(
        final.toFixed(1)
      )}</span></div>
      <div class="stats__item"><span class="stats__k">评价</span><span class="stats__v">${esc(
        ratingFor(final)
      )}</span></div>
    </dl>
  `;
}

/* ----------------------------------------------------------------------
 * 11. 事件绑定
 * -------------------------------------------------------------------- */
function bindEvents() {
  el.difficultySelect.addEventListener('change', (event) => {
    const next = Math.round(num(event.target.value, CONFIG.DIFFICULTY.min, CONFIG.DIFFICULTY.max, state.difficulty));
    if (!state.finalized && state.attempts.length) {
      // 历史记录按难度分桶保存，切走再切回依然在
      const ok = window.confirm('切换难度会放弃当前未完成的题目（各难度历史记录都保留）。继续吗？');
      if (!ok) {
        event.target.value = String(state.difficulty);
        return;
      }
    }
    state.difficulty = next;
    newRound();
    toast(`已切到难度 ${next}，该难度的最近记录已载入`);
  });

  el.autoDifficulty.addEventListener('change', (event) => {
    state.autoAdvance = event.target.checked;
    toast(state.autoAdvance ? '开启自动递增：高分升级，低分降级' : '关闭自动递增，难度由你手动选择');
  });

  el.revealTarget.addEventListener('change', (event) => {
    state.revealTarget = event.target.checked;
    renderSwatches();
  });

  const bindRange = (input, key, max) => {
    input.addEventListener('input', (event) => {
      state.guess[key] = Math.round(num(event.target.value, 0, max, state.guess[key]));
      renderSwatches();
      renderSliders();
      renderShareLink();
    });
  };
  bindRange(el.rangeHue, 'h', 360);
  bindRange(el.rangeSat, 's', 100);
  bindRange(el.rangeLight, 'l', 100);

  el.btnSubmit.addEventListener('click', submitGuess);
  el.btnNext.addEventListener('click', nextQuestion);
  el.btnReset.addEventListener('click', resetAdjustment);

  el.btnCopyLink.addEventListener('click', sharePuzzleLink);
  el.btnCopyResult.addEventListener('click', shareCurrentResult);
  el.btnShareHistory.addEventListener('click', shareRecentHistory);

  el.btnViewHistory.addEventListener('click', () => {
    el.historyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.historyPanel.classList.remove('is-flash');
    // 强制重排以便重复点击时动画能重新播放
    void el.historyPanel.offsetWidth;
    el.historyPanel.classList.add('is-flash');
    const stats = computeStats(HistoryStore.list(state.scope, state.difficulty), state.recentCount);
    toast(stats.count ? `最近 ${stats.count} 题平均 ${stats.avg.toFixed(1)} 分` : '还没有历史记录');
  });

  el.btnClearHistory.addEventListener('click', clearHistory);

  el.segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.scope = btn.dataset.scope === 'global' ? 'global' : 'difficulty';
      el.segButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      renderHistory();
    });
  });

  el.recentCount.addEventListener('change', (event) => {
    state.recentCount = Math.round(num(event.target.value, 1, 20, CONFIG.HISTORY.recentDefault));
    renderHistory();
  });

  el.shareLink.addEventListener('focus', () => el.shareLink.select());

  el.btnExitShare.addEventListener('click', () => {
    // 回到不含查询参数的同一路径（保留 GitHub Pages 子路径）
    window.location.href = window.location.pathname + window.location.hash;
  });
}

/* ----------------------------------------------------------------------
 * 12. 启动入口
 * -------------------------------------------------------------------- */
function buildOptions() {
  const d = CONFIG.DIFFICULTY;
  el.difficultySelect.innerHTML = '';
  for (let level = d.min; level <= d.max; level += 1) {
    const opt = document.createElement('option');
    opt.value = String(level);
    opt.textContent = `${level} 级（均值 S ≈ ${Math.round(meanSaturationFor(level))}%）`;
    el.difficultySelect.appendChild(opt);
  }
  el.recentCount.innerHTML = '';
  CONFIG.HISTORY.recentOptions.forEach((n) => {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `最近 ${n}`;
    el.recentCount.appendChild(opt);
  });
  el.recentCount.value = String(state.recentCount);
}

function bootPuzzle(puzzle) {
  if (puzzle) {
    state.difficulty = puzzle.difficulty;
    state.target = puzzle.color;
    state.fromLink = true;
    el.contextBanner.hidden = false;
    el.contextBanner.textContent =
      `你打开的是别人分享的题目：难度 ${puzzle.difficulty}，目标色 ${hslLabel(
        puzzle.color
      )}。三次猜测照常计分，成绩会存入你自己浏览器里难度 ${puzzle.difficulty} 的记录。`;
  } else {
    el.contextBanner.hidden = true;
  }
  renderGame();
}

function init() {
  cacheDom();
  buildOptions();
  bindEvents();
  Tip.bind();

  const route = Share.readRoute();
  if (route.share) {
    el.contextBanner.hidden = false;
    el.contextBanner.textContent = '只读分享视图：以下成绩来自分享者所在浏览器的 localStorage，不会改动你的本地记录。';
    renderShareView(route.share, route.payload);
    return;
  }

  state.difficulty = CONFIG.DIFFICULTY.default;
  bootPuzzle(route.puzzle || null);

  if (!HistoryStore.isAvailable()) {
    toast('浏览器存储不可用，本次成绩只保留在页面内', true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
