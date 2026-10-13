/**
 * 游戏规则：评分算法 + 出题与难度。
 * 色相用环形距离（0-180），饱和度/明度用线性差值（0-100）；
 * total = 100 * (0.65*scoreH + 0.20*scoreS + 0.15*scoreL)。
 */
import { CONFIG } from './config.js?v=16';
import { clamp, round1, randInt, gaussian } from './utils.js?v=16';
import { sanitizeColor } from './color.js?v=16';

export function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return Math.min(diff, 360 - diff);
}

export function scoreOf(target, guess) {
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
export function resolveFinal(attempts) {
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

/** 命中的评价档位整条（含 label 与卡片文案 line），低于最小阈值时取最后一档 */
export function ratingOf(score) {
  const hit = CONFIG.RATINGS.find((r) => score >= r.min);
  return hit || CONFIG.RATINGS[CONFIG.RATINGS.length - 1];
}

/**
 * 历史卡（均分口径）的档位：label 来自 RATINGS、line 来自 HISTORY_LINES，
 * 两张表的 min 序列必须一致（新增档位只加一处就会在这里错位），
 * 所以取不到 HISTORY_LINES 同下标时退回最后一档，而不是抛错让卡片画不出。
 */
export function historyRatingOf(score) {
  const rating = ratingOf(score);
  const idx = CONFIG.RATINGS.indexOf(rating);
  const line = CONFIG.HISTORY_LINES[idx] || CONFIG.HISTORY_LINES[CONFIG.HISTORY_LINES.length - 1];
  return { label: rating.label, line: line.line };
}

export const ratingFor = (score) => ratingOf(score).label;

/** 难度越高 -> 饱和度高斯均值越左移（整体更"灰"，越难辨认） */
export function meanSaturationFor(difficulty) {
  const d = CONFIG.DIFFICULTY;
  return clamp(
    d.meanSatBase - difficulty * d.meanSatPerLevel,
    d.meanSatFloor,
    d.meanSatCeil
  );
}

export function generateTarget(difficulty) {
  const d = CONFIG.DIFFICULTY;
  return sanitizeColor({
    h: randInt(d.hueMin, d.hueMax - 1),
    s: clamp(Math.round(gaussian(meanSaturationFor(difficulty), d.satStd)), 0, 100),
    l: randInt(d.lightMin, d.lightMax),
  });
}
