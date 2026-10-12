/**
 * 只读分享视图（?share=history / ?share=result）。
 * 载荷全部来自 URL，是不可信输入：一律过 num() / sanitizeColor() 再落 DOM，
 * 文本插进模板前统一 esc()。
 */
import { CONFIG } from './config.js';
import { esc, num, round1 } from './utils.js';
import { sanitizeColor, hslCss, hslLabel, hslPlain, tipAttr, tipAria } from './color.js';
import { ratingFor } from './rules.js';
import { historyDots } from './ui.js';
import { state } from './state.js';
import { el } from './dom.js';

/** 圆点图例：方形 = 目标色，圆形 = 各次猜测，双环 + ★ = 最佳一次 */
const LEGEND_HTML =
  '<p class="dot-legend">' +
  '<span class="dot-sm dot-sm--target"></span>目标色' +
  '<span class="dot-sm is-best"></span>最佳一次（双环 + ★）' +
  '<span>圆点下数字 = 该次得分，悬停 / 点击看 HSL 与 HSV</span>' +
  '</p>';

export function renderShareView(kind, payload) {
  el.mainLayout.hidden = true;
  el.shareView.hidden = false;
  // 页眉步进器在 #mainLayout 外面，不收起的话：只读视图里点它什么也不会发生，
  // 而且它停在 HTML 默认值“难度 1”，与分享过来的难度对不上
  el.levelBadge.hidden = true;
  state.readOnly = true;
  document.title = kind === 'history' ? '最近成绩摘要 · 颜色比色挑战' : '本题成绩 · 颜色比色挑战';

  if (!payload) {
    el.shareTitle.textContent = '链接内容无法解析';
    el.shareBody.innerHTML =
      '<p class="history-empty">分享参数缺失或已损坏，请让对方重新生成分享链接。</p>';
    return;
  }

  if (kind === 'history') {
    renderSharedHistory(payload);
    return;
  }
  renderSharedResult(payload);
}

function renderSharedHistory(payload) {
  el.shareTitle.textContent = '最近成绩摘要（只读）';
  const rounds = (Array.isArray(payload.rounds) ? payload.rounds : []).slice(0, CONFIG.SHARE.maxRounds);
  // 摘要数字直接取载荷；缺失时按 rounds 兜底重算
  const finals = rounds.map((r) => num(r.f, 0, 100, 0));
  const n = num(payload.n, 0, 999, rounds.length);
  // 历史卡二维码只带摘要数字、不带 rounds，所以「有没有数据」得同时看两边：
  // 只看 rounds.length 会把载荷里明摆着的均分 / 极值 / σ 全画成 '—'，扫码等于白扫。
  // （summary 载荷总是六个数一起写，只可能出现“全有”或“全无”，不会半截）
  const hasData = rounds.length > 0 || n > 0;
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
      <div class="stats__item"><span class="stats__k">题目数</span><span class="stats__v">${esc(n)} 题</span></div>
      <div class="stats__item"><span class="stats__k">平均准确率</span><span class="stats__v">${esc(
        hasData ? `${avg.toFixed(1)}%` : '—'
      )}</span></div>
      <div class="stats__item"><span class="stats__k">最高分</span><span class="stats__v">${esc(
        hasData ? max.toFixed(1) : '—'
      )}</span></div>
      <div class="stats__item"><span class="stats__k">最低分</span><span class="stats__v">${esc(
        hasData ? min.toFixed(1) : '—'
      )}</span></div>
      <div class="stats__item"><span class="stats__k">稳定度 σ</span><span class="stats__v">${esc(
        hasData ? num(payload.std, 0, 100, 0).toFixed(1) : '—'
      )}</span></div>
    </dl>
    <p class="meta-line">来源：${esc(scopeName)}</p>
    ${LEGEND_HTML}
    ${items ? `<ol class="history">${items}</ol>` : '<p class="history-empty">链接只包含摘要数字，没有逐题记录。</p>'}
  `;
}

function renderSharedResult(payload) {
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
