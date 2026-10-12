/**
 * 历史记录存储（localStorage 封装）
 * 结构：{ version, byDifficulty: { "3": [entry...] } }
 * —— 难度桶是唯一事实来源："全部难度"列表与各项汇总（最高分 / 累计题数 /
 *    高分连击）均由桶实时派生，所以清空某个难度后不会出现两处数据自相矛盾。
 * entry：{ id, time, question, difficulty, target, guesses:[{h,s,l,total}], final }
 * 列表一律"最新在前"；切换难度只影响读取哪个桶，绝不清空其它难度的数据。
 *
 * 未导出的 cached / available / normalize* 即模块私有，不需要再套 IIFE。
 */
import { CONFIG } from './config.js';
import { num, round1 } from './utils.js';
import { sanitizeColor } from './color.js';

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

export function read() {
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

export function add(entry) {
  const data = read();
  const key = String(entry.difficulty);
  if (!data.byDifficulty[key]) data.byDifficulty[key] = [];
  data.byDifficulty[key] = [entry, ...data.byDifficulty[key]].slice(0, CONFIG.HISTORY.maxPerBucket);
  return write();
}

/** 跨难度合并（最新在前），"全部难度"视图与派生统计都走这里 */
export function all() {
  const data = read();
  const merged = [];
  Object.keys(data.byDifficulty).forEach((key) => merged.push(...data.byDifficulty[key]));
  return merged.sort((a, b) => b.time - a.time);
}

/** scope: 'difficulty' | 'global' */
export function list(scope, difficulty) {
  if (scope === 'global') return all();
  return read().byDifficulty[String(difficulty)] || [];
}

/** 清空：scope='global' 清所有难度桶，否则只清该难度桶（派生数据自动跟着变） */
export function clear(scope, difficulty) {
  const data = read();
  if (scope === 'global') data.byDifficulty = {};
  else delete data.byDifficulty[String(difficulty)];
  return write();
}

/** 汇总指标全部从现存记录派生，不额外落盘，因此删掉哪桶、指标就立刻反映哪桶 */
export function meta() {
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

export function isAvailable() {
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

/** 最近 N 题的统计口径：平均分（即准确率）/ 最高 / 最低 / 稳定度（标准差） */
export function computeStats(entries, limit) {
  const list2 = entries.slice(0, limit);
  if (!list2.length) {
    return { count: 0, avg: 0, max: 0, min: 0, std: 0, best: null };
  }
  const scores = list2.map((e) => e.final);
  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = sum / scores.length;
  const variance = scores.reduce((a, b) => a + (b - avg) ** 2, 0) / scores.length;
  const max = Math.max(...scores);
  const best = list2.find((e) => e.final === max) || null;
  return {
    count: scores.length,
    avg: round1(avg),
    max: round1(max),
    min: round1(Math.min(...scores)),
    std: round1(Math.sqrt(variance)),
    best,
  };
}
