/**
 * 游戏区与历史面板的渲染。每个 render* 只读 state、只写 DOM，不回写 state——
 * 状态变更一律集中在 game.js，渲染层保持无副作用（除了往 DOM 上贴属性）。
 */
import { CONFIG } from './config.js?v=16';
import { esc, clamp, formatTime } from './utils.js?v=16';
import {
  hslCss,
  hslLabel,
  hslPlain,
  tipText,
  tipPlain,
  tipAttr,
  tipAria,
} from './color.js?v=16';
import { meanSaturationFor, ratingFor } from './rules.js?v=16';
import * as HistoryStore from './history.js?v=16';
import { puzzleUrl } from './share.js?v=16';
import { state } from './state.js?v=16';
import { el } from './dom.js?v=16';

export function renderLevelRow() {
  const d = CONFIG.DIFFICULTY;
  // 只写数字那个节点：#levelBadge 现在是步进器容器，给它赋 textContent 会把 − / + 两个按钮一擦掉
  el.levelBadgeValue.textContent = String(state.difficulty);
  // 到顶到底直接禁用，而不是“按下去没反应”；原因交给 aria-label，
  // 不靠 title（原生提示要等约 1 秒，项目里悬停说明已经统一走 src/js/tip.js）
  el.btnLevelDown.disabled = state.difficulty <= d.min;
  el.btnLevelUp.disabled = state.difficulty >= d.max;
  el.btnLevelDown.setAttribute(
    'aria-label',
    state.difficulty <= d.min ? `已是最低难度（${d.min}）` : `难度减一，当前 ${state.difficulty}，切到 ${state.difficulty - 1}`
  );
  el.btnLevelUp.setAttribute(
    'aria-label',
    state.difficulty >= d.max ? `已是最高难度（${d.max}）` : `难度加一，当前 ${state.difficulty}，切到 ${state.difficulty + 1}`
  );
  el.difficultySelect.value = String(state.difficulty);
  const meanS = Math.round(meanSaturationFor(state.difficulty));
  el.levelHint.textContent = `本难度饱和度均值 ≈ ${meanS}%（难度越高越灰，越难辨认）`;
}

export function renderSwatches() {
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

export function renderSliders() {
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

  // ± 到边界只弱化、不给原生 disabled：长按连发按到头上时按钮若被 disabled，
  // 正在按着的那条 pointer 序列会被吞掉（抬起都收不到），计时器就卡在边界上停不下来；
  // 口径与下面的 softDisable 一致（aria-disabled 保持可聚焦、不吃事件）
  el.stepButtons.forEach((btn) => {
    const max = CONFIG.AXES[btn.dataset.axis];
    const value = state.guess[btn.dataset.axis];
    const atEdge = Number(btn.dataset.dir) >= 0 ? value >= max : value <= 0;
    btn.setAttribute('aria-disabled', String(atEdge));
  });
}

/** 三个圆形猜测记录位：未用=虚线空心圆；已用=纯色；提交完就能 hover 回看数值 */
export function renderGuessList() {
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

export function renderFeedback() {
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
    <p class="card__note">还剩 ${left} 次机会，可继续调整后再提交。</p>
  `;
}

export function renderResultCard() {
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
    </dl>
    <p class="card__line"><span class="card__line-k">目标色</span><span class="card__line-v">${esc(hslLabel(state.target))}</span></p>
    <p class="card__line"><span class="card__line-k">最佳猜测</span><span class="card__line-v">${esc(hslLabel(best))}</span></p>
    <ul class="card__list">${rows}</ul>
  `;
}

export function renderActions() {
  const exhausted = state.finalized || state.attempts.length >= CONFIG.MAX_GUESSES;
  el.btnSubmit.disabled = exhausted;
  const nextIndex = Math.min(state.attempts.length + 1, CONFIG.MAX_GUESSES);
  el.submitCount.textContent = exhausted
    ? `${CONFIG.MAX_GUESSES} / ${CONFIG.MAX_GUESSES}`
    : `${nextIndex} / ${CONFIG.MAX_GUESSES}`;
  el.btnReset.disabled = state.finalized;
  // 两个分享按钮不用原生 disabled：原生 disabled 会把 click 整个吞掉，
  // game.js 里的 toast 就成了走不到的死代码——触屏上点一个灰按钮，
  // 它连为什么不行都不说。aria-disabled 仍保持可聚焦、可被读屏读到，
  // 点击照样落进处理器，由已有的 toast 解释原因。
  // 说明必须带上「本题」二字：本题的三次尝试只活在内存里（见 state.js），刷新或换题
  // 都会清零，而历史面板此刻往往正摆着一道 99 分。光说「至少提交一次猜测」，读起来
  // 就像记录被弄丢了——用户的第一反应会是去查 localStorage，而不是去按旁边那个能用的按钮。
  softDisable(el.btnCopyResult, !state.attempts.length, RESULT_OFF_TIP);
  if (el.btnMakeCard) softDisable(el.btnMakeCard, !state.attempts.length, CARD_OFF_TIP);
}

// 悬停说明走 data-tip + tip.js（不用原生 title，理由见 renderLevelRow 的注释）。
// 换行是真换行：.tip 的 white-space: pre-line 只认字符里的 \n，不认 HTML 实体。
const RESULT_OFF_TIP = '本题还没提交过猜测\n刷新或换下一题会清零三次机会\n已存的成绩请用右侧「分享最近成绩」';
const CARD_OFF_TIP = '卡片画的是本题成绩\n本题还没提交过猜测\n刷新或换下一题会清零三次机会';

/**
 * 弱化但不拦点击的禁用态：样式走 CSS 的 .btn[aria-disabled="true"]。
 * why 只在禁用那一刻挂上；能点的时候必须摘掉，否则一个正常按钮会一直顶着
 * 「本题还没提交过猜测」这句已经过时（而且开始误导）的说明。
 */
function softDisable(btn, off, why) {
  btn.setAttribute('aria-disabled', off ? 'true' : 'false');
  if (off && why) btn.setAttribute('data-tip', why);
  else btn.removeAttribute('data-tip');
}

/**
 * 历史行里的色块组：方形目标点 + 三个圆形猜测点（本地面板与只读分享视图共用）
 * 每个点下方直接写该次得分；悬停 / 点击出 HSL 与 HSV；读屏走 aria-label。
 * bestIdx 永远按三次得分现算，不写死下标；labels 可覆盖“第 N 次”叫法（退化载荷只有一个点）。
 */
export function historyDots(target, guesses, labels) {
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

export function renderHistory() {
  const entries = HistoryStore.list(state.scope, state.difficulty);
  const stats = HistoryStore.computeStats(entries, state.recentCount);
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
  // 零记录时卡片按钮也给个软禁用提示：面板已经写着「还没有记录」，
  // 按钮再亮着就等于邀请一次失败的点击（口径同比色台的「分享卡片」）
  if (el.btnHistoryCard) softDisable(el.btnHistoryCard, !stats.count, '这里还没有已结算的成绩可画');
}

export function renderShareLink() {
  el.shareLink.value = puzzleUrl(state.target, state.difficulty);
}

export function renderGame() {
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
