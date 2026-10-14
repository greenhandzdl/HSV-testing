/**
 * 会话状态单例。模块作用域天然只有一份，谁 import 谁读写的都是同一个对象，
 * 所以不需要 setter / 事件——但也意味着任何模块都能改它，改动请集中在 game.js。
 */
import { CONFIG } from './config.js?v=17';
import { generateTarget } from './rules.js?v=17';

export const state = {
  difficulty: CONFIG.DIFFICULTY.default,
  target: generateTarget(CONFIG.DIFFICULTY.default),
  guess: { ...CONFIG.ROUND_DEFAULT },
  attempts: [], // [{h,s,l,score:{h,s,l,total,dH}}]
  finalized: false,
  final: 0,
  bestIndex: -1,
  // 本题是累计第几题：开局定住，结算写历史与分享卡片都读这一个值，
  // 否则写完历史再算 meta.totalRounds + 1 会把自己编号成下一题
  question: 0,
  autoAdvance: false,
  revealTarget: false,
  scope: 'difficulty', // 最近几题读取口径
  recentCount: CONFIG.HISTORY.recentDefault,
  fromLink: false, // 由分享题目链接进入
  readOnly: false,
};
