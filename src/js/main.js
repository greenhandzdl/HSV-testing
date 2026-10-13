/**
 * 入口：事件绑定 + 启动。这里是唯一认识"所有模块"的地方，
 * 其余模块彼此不认识（只依赖 config / utils / color 这一类底层）。
 */
import { CONFIG } from './config.js?v=16';
import { num } from './utils.js?v=16';
import { hslLabel } from './color.js?v=16';
import { meanSaturationFor } from './rules.js?v=16';
import * as HistoryStore from './history.js?v=16';
import * as Share from './share.js?v=16';
import { state } from './state.js?v=16';
import { el, cacheDom, toast } from './dom.js?v=16';
import { bind as bindTip } from './tip.js?v=16';
import { bindSteppers } from './stepper.js?v=16';
import {
  renderGame,
  renderSwatches,
  renderHistory,
} from './ui.js?v=16';
import {
  setDifficulty,
  adjustGuess,
  submitGuess,
  nextQuestion,
  resetAdjustment,
  sharePuzzleLink,
  shareCurrentResult,
  shareRecentHistory,
  shareCard,
  shareHistoryCard,
  clearHistory,
} from './game.js?v=16';
import { renderShareView } from './share-view.js?v=16';

/* ----------------------------------------------------------------------
 * 事件绑定
 * -------------------------------------------------------------------- */
function bindEvents() {
  // 难度有两个入口：比色台里的下拉（可一次跳多级，保留 confirm）
  // 和页眉的 ± 步进器（±1 微调，不弹窗）；两者都只调 setDifficulty，不在这里写 state。
  el.difficultySelect.addEventListener('change', (event) => {
    // 取消或目标与当前相同时 setDifficulty 不动 DOM，得手动把下拉拉回真实难度，
    // 否则它会停在没生效的那一档，看上去像切换被吃掉了
    if (!setDifficulty(event.target.value, { ask: true })) {
      el.difficultySelect.value = String(state.difficulty);
    }
  });

  el.btnLevelDown.addEventListener('click', () => setDifficulty(state.difficulty - 1, { ask: false }));
  el.btnLevelUp.addEventListener('click', () => setDifficulty(state.difficulty + 1, { ask: false }));

  el.autoDifficulty.addEventListener('change', (event) => {
    state.autoAdvance = event.target.checked;
    toast(state.autoAdvance ? '开启自动递增：高分升级，低分降级' : '关闭自动递增，难度由你手动选择');
  });

  el.revealTarget.addEventListener('change', (event) => {
    state.revealTarget = event.target.checked;
    renderSwatches();
  });

  // 滑块只能按像素粗调，± 按钮负责细微修正；两条入口都走 adjustGuess，
  // 改值与刷新只有一份口径
  const bindRange = (input, key) => {
    input.addEventListener('input', (event) => adjustGuess(key, Number(event.target.value)));
  };
  bindRange(el.rangeHue, 'h');
  bindRange(el.rangeSat, 's');
  bindRange(el.rangeLight, 'l');

  bindSteppers(el.stepButtons, (key, delta) => adjustGuess(key, state.guess[key] + delta));

  el.btnSubmit.addEventListener('click', submitGuess);
  el.btnNext.addEventListener('click', nextQuestion);
  el.btnReset.addEventListener('click', resetAdjustment);

  el.btnCopyLink.addEventListener('click', sharePuzzleLink);
  el.btnCopyResult.addEventListener('click', shareCurrentResult);
  el.btnShareHistory.addEventListener('click', shareRecentHistory);
  // 卡片按钮要下载 / 系统分享，iOS Safari 对“点击后异步太久的 share()”会丢掉用户手势，
  // 所以 shareCard 内部先同步走完数据组装，最后一刻才 await share
  if (el.btnMakeCard) el.btnMakeCard.addEventListener('click', () => shareCard());
  if (el.btnHistoryCard) el.btnHistoryCard.addEventListener('click', () => shareHistoryCard());

  el.btnViewHistory.addEventListener('click', () => {
    el.historyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.historyPanel.classList.remove('is-flash');
    // 强制重排以便重复点击时动画能重新播放
    void el.historyPanel.offsetWidth;
    el.historyPanel.classList.add('is-flash');
    const stats = HistoryStore.computeStats(HistoryStore.list(state.scope, state.difficulty), state.recentCount);
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
 * 启动入口
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
  bindTip();

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

// 模块脚本本身就是 defer 语义，这里的分支只是保险：
// 万一有人把入口改回普通 <script> 放在 head，也不会拿不到 DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
