/**
 * 回合流转与分享动作：这里是唯一允许写 state 的地方（渲染层只读）。
 */
import { CONFIG } from './config.js';
import { clamp } from './utils.js';
import { scoreOf, resolveFinal, generateTarget, ratingOf, historyRatingOf } from './rules.js';
import * as HistoryStore from './history.js';
import * as Share from './share.js';
import { outputCard } from './card.js';
import { renderCard, cardFileName, HISTORY_ROWS } from './card-round.js';
import { renderHistoryCard, historyCardFileName, HISTORY_CARD_ROWS } from './card-history.js';
import { state } from './state.js';
import { el, toast } from './dom.js';
import { renderGame, renderSwatches, renderSliders, renderShareLink, renderHistory } from './ui.js';

export function newRound() {
  state.target = generateTarget(state.difficulty);
  state.guess = { ...CONFIG.ROUND_DEFAULT };
  state.attempts = [];
  state.finalized = false;
  state.final = 0;
  state.bestIndex = -1;
  state.question = HistoryStore.meta().totalRounds + 1;
  state.fromLink = false;
  renderGame();
}

/**
 * 切难度的唯一入口：页眉的 ± 步进器与比色台里的下拉都走这里，
 * state.difficulty 不在其它地方被写，两个入口才不会各自漂移。
 * ask=true（下拉）保留 confirm：下拉一次能跳 9 级，手滑的代价高；
 * 步进器是 ±1 高频微调，连点三下弹三次窗比切错一级更烦，所以它不弹确认，
 * 放弃了几次尝试靠 toast 说清。切完走 newRound → renderGame，两个入口同时回显。
 */
export function setDifficulty(next, { ask = true } = {}) {
  if (state.readOnly) return false; // 只读分享视图里页眉控件已经收起，这里只是兜底
  const d = CONFIG.DIFFICULTY;
  const raw = Number(next);
  const target = Math.round(clamp(Number.isFinite(raw) ? raw : state.difficulty, d.min, d.max));
  if (target === state.difficulty) return false;
  const abandoned = state.finalized ? 0 : state.attempts.length;
  if (ask && abandoned && !window.confirm('切换难度会放弃当前未完成的题目（各难度历史记录都保留）。继续吗？')) {
    return false;
  }
  const wasSharedPuzzle = state.fromLink;
  state.difficulty = target;
  newRound();
  // 换成自己生成的题之后，那句“你打开的是别人分享的题目”就成了假话，直接收起
  if (wasSharedPuzzle) el.contextBanner.hidden = true;
  toast(
    abandoned
      ? `难度 ${target}：本题 ${abandoned} 次未结算的尝试已放弃，各难度的历史记录都还在`
      : `已切到难度 ${target}，该难度的最近记录已载入`
  );
  return true;
}

export function submitGuess() {
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
  // 刷新后直接进的那一题没走 newRound，到结算才补号；补完就钉住，不再跟着存储漂移
  if (!state.question) state.question = meta.totalRounds + 1;
  const entry = {
    id: `d${state.difficulty}-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
    time: Date.now(),
    question: state.question,
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

export function nextQuestion() {
  if (!state.finalized && state.attempts.length) {
    const ok = window.confirm('当前题目还没用完三次机会，换题会丢弃这几次尝试（历史记录不受影响）。继续吗？');
    if (!ok) return;
  }
  newRound();
}

export function resetAdjustment() {
  if (state.finalized) return;
  state.guess = { ...CONFIG.ROUND_DEFAULT };
  renderSwatches();
  renderSliders();
  renderShareLink();
  toast('已把滑块恢复到初始值');
}

/**
 * 本题的分享/卡片共用数据包。未结算时 final 取当前最高分，
 * 这样"玩了两次就想要卡片"也能拿到自洽的数字。
 */
export function currentRound() {
  return {
    question: state.question || HistoryStore.meta().totalRounds + 1,
    difficulty: state.difficulty,
    target: state.target,
    attempts: state.attempts,
    finalized: state.finalized,
    bestIndex: state.bestIndex,
    final: state.finalized
      ? state.final
      : state.attempts.length
      ? Math.max(...state.attempts.map((a) => a.score.total))
      : 0,
  };
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

export function sharePuzzleLink() {
  copyText(el.shareLink.value, '题目链接已复制，对方打开就是同一道题');
}

export function shareCurrentResult() {
  if (!state.attempts.length) {
    // 只说“至少提交一次”不够：刷新或点过「下一题」之后都会走到这里，而历史面板上正摆着
    // 已存的成绩。把能用的出口一并递到嘴边，比让人去猜“是不是记录没了”便宜。
    toast('本题还没提交过猜测 · 已存成绩请用「分享最近成绩」', true);
    return;
  }
  copyText(Share.resultUrl(currentRound()), '本题成绩链接已复制（只读展示）');
}

export function shareRecentHistory() {
  const entries = HistoryStore.list(state.scope, state.difficulty);
  if (!entries.length) {
    toast(`${state.scope === 'global' ? '全部难度' : `难度 ${state.difficulty}`}还没有记录`, true);
    return;
  }
  const stats = HistoryStore.computeStats(entries, state.recentCount);
  copyText(
    Share.historyUrl(entries, stats, state.scope),
    `最近 ${stats.count} 题成绩链接已复制（只读展示，均分 ${stats.avg.toFixed(1)}）`
  );
}

/**
 * 卡片统一出口：两张卡都走这里——渲染失败与分享结果在同一处收口，
 * 提示口径不会各自漂移。render 是同步的画布组装，outputCard 才 await，
 * 尽量把 navigator.share 贴近点击的用户手势（见 main.js 绑定处注释）。
 * @param {() => HTMLCanvasElement} render 现场画这张卡（抛错即视为生成失败）
 * @param {{ name: string }} out 下载分支用的文件名（分享只给图片，不带文案）
 */
async function deliverCard(render, { name }) {
  let canvas;
  try {
    canvas = render();
  } catch (err) {
    toast(`卡片生成失败：${err && err.message ? err.message : '画不出这一张'}`, true);
    return;
  }
  const how = await outputCard(canvas, { name });
  if (how === 'shared') toast('已交给系统分享面板');
  else if (how === 'downloaded') toast('卡片已下载为 PNG，可直接发图');
  else if (how === 'failed') toast('系统分享未完成，请再点一次重试', true);
  // 'cancelled'：用户在系统面板主动收回，不打扰
}

/**
 * 生成分享卡片：本题成绩 + 最近几题 + 二维码。
 * 目标色没揭晓（没勾选揭晓且没结算）时，卡片不画目标色、二维码也不带目标色，
 * 与页面上的防作弊口径保持一致（见 ui.js 的 renderSwatches）。
 */
export function shareCard() {
  if (state.readOnly) {
    // 只读视图里的原因不是“没猜过”，而是这一页本来就不是自己玩的，两者分开说
    toast('只读分享视图里不生成卡片', true);
    return;
  }
  if (!state.attempts.length) {
    toast('卡片画的是本题成绩，本题还没提交过猜测', true);
    return;
  }
  const round = currentRound();
  const totals = round.attempts.map((a) => a.score.total);
  const bestIndex = round.bestIndex >= 0 ? round.bestIndex : totals.indexOf(Math.max(...totals));
  const revealed = state.revealTarget || state.finalized;
  const entries = HistoryStore.list(state.scope, state.difficulty);
  const stats = HistoryStore.computeStats(entries, state.recentCount);
  return deliverCard(
    () =>
      renderCard({
        question: round.question,
        difficulty: round.difficulty,
        final: round.final,
        rating: ratingOf(round.final),
        target: round.target,
        best: round.attempts[bestIndex],
        bestIndex,
        attempts: round.attempts,
        revealed,
        stats,
        history: entries.slice(0, HISTORY_ROWS),
        url: revealed ? Share.cardUrl(round) : Share.siteUrl(),
      }),
    { name: cardFileName(round.final) }
  );
}

/**
 * 生成历史卡片：均分为主角 + 逐题条（目标色 + 三次猜测 + 分数）+ 二维码。
 * 与本题卡的分工：本题卡讲这一题的对比，历史卡讲一批题的分布，
 * 所以取数口径跟着面板的「最近 N」走，而不是另定一个条数。
 */
export function shareHistoryCard() {
  if (state.readOnly) {
    toast('只读分享视图里不生成卡片', true);
    return;
  }
  const scopeName = state.scope === 'global' ? '全部难度' : `难度 ${state.difficulty}`;
  const entries = HistoryStore.list(state.scope, state.difficulty);
  const stats = HistoryStore.computeStats(entries, state.recentCount);
  if (!stats.count) {
    toast(`${scopeName}还没有已结算的题目`, true);
    return;
  }
  // stats.count 已经按「最近 N」截好，版面顶多 HISTORY_CARD_ROWS 行，两个约束取小的那个；
  // 条数必须跟概览行的「共 X 题」完全对齐，否则卡上会出现两个不同的样本数
  const rows = entries.slice(0, Math.min(stats.count, HISTORY_CARD_ROWS));
  return deliverCard(
    () =>
      renderHistoryCard({
        scopeText: `${scopeName} · 最近 ${stats.count} 题`,
        stats,
        rating: historyRatingOf(stats.avg),
        history: rows,
        url: Share.historyCardUrl(entries, stats, state.scope),
      }),
    { name: historyCardFileName(stats.avg) }
  );
}

export function clearHistory() {
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
