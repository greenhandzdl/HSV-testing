/**
 * 本题卡：这一题的得分 + 目标色 vs 我的最佳 + 三次猜测 + 二维码。
 * 原语（色板、排版引擎、页脚、出口）都在 card.js 工具箱里，
 * 这个文件只管「这一张卡从上到下有哪些段、各段占多少像素」。
 *
 * 与历史卡的分工（刻意不重叠）：本题卡只讲「这一题」，一批题的均分/极值/逐题分布
 * 全交给历史卡，所以这里不再挂「最近几题」——否则两张卡文案雷同、本题卡反而比历史卡还「历史」。
 *
 * 守则：目标色未揭晓（revealTarget 关着且没结算）时不给目标色的色值与色块。
 */
import { CONFIG } from './config.js?v=17';
import { hslCss, hslPlain, hsvOf, isLightColor } from './color.js?v=17';
import {
  W, H, M, CW,
  SOFT, FAINT, LINE, SURFACE, ACCENT, STAGE, INK,
  RATING_LINE, DIGIT_INK,
  px, scoreColor, roundRect, drawText, wrap, inkAscent,
  drawTopBand, drawTitle, distribute, drawFooter,
} from './card.js?v=17';

// 不参与拉伸的固定量：标题 34 + 标题到分隔线 22 + 分隔线 2 + 分数到评价行 14
const FIXED_TOP = 34 + 22 + 2 + 14;
// 「三次猜测」标题 20 + 8 + 「第 N 次」19 + 6 + 得分 22（本题卡到此为止，下面直接是页脚）
const FIXED_BOTTOM = 20 + 8 + 19 + 6 + 22;
// 去掉历史块后正文空出一大截，把色块 / 圆点 / 段距的 max 抬高，让 distribute 正好铺到 CONTENT_BOTTOM，
// 不留底部死区（card.js 头注释里记着「塌一块」的教训）。
const STRETCH = {
  gapHead: { min: 23, max: 44, w: 1 }, // 分隔线 → 分数
  scoreInk: { min: 76, max: 104, w: 1.4 },
  gapScore: { min: 23, max: 56, w: 1 }, // 评价文案 → 两个色块
  boxH: { min: 158, max: 268, w: 1.8 },
  gapBoxes: { min: 16, max: 40, w: 0.8 }, // 色块 → 「三次猜测」
  dotR: { min: 40, max: 78, w: 1.2, span: 2 }, // 占 2r，必须折回单值
  gapDots: { min: 10, max: 26, w: 0.6 }, // 圆点 → 下方两行字
};

function layoutCard(nLines) {
  const fixed = FIXED_TOP + nLines * RATING_LINE + FIXED_BOTTOM;
  return distribute(STRETCH, 0, 0, fixed);
}

/**
 * @param {object} data { question, difficulty, final, rating, target, best, bestIndex,
 *                        attempts, revealed, url }
 * @returns {HTMLCanvasElement}
 */
export function renderCard(data) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);
  // 顶边一条目标色的色带：卡片一眼认出是哪道题
  drawTopBand(ctx, data.revealed && data.target ? hslCss(data.target) : LINE);

  let y = drawTitle(ctx, `难度 ${data.difficulty} · 第 ${data.question} 题`);

  // —— 得分 + 评价文案 ——
  // 评价文案撑到分数下方整行铺开：以前挤在分数右边、按基线手调偏移，
  // 104px 的字顶因此直接压过上面的分隔线；整行铺开后既不再压线、也不用算折行宽度。
  const ratingLines = wrap(ctx, data.rating.line, CW, px(24)).slice(0, 2);
  const L = layoutCard(ratingLines.length);
  y += L.gapHead;
  const scoreText = data.final.toFixed(1);
  const scoreSize = L.scoreInk / DIGIT_INK;
  const ink = inkAscent(ctx, scoreText, scoreSize, px(scoreSize, 800));
  const scoreBaseline = y + ink.ascent; // 数字没有下伸部：墨迹底就压在基线上
  drawText(ctx, scoreText, M, scoreBaseline, { size: scoreSize, weight: 800, color: scoreColor(data.final) });
  drawText(ctx, '/ 100', M + ink.width + 12, scoreBaseline, { size: 26, weight: 600, color: FAINT });
  drawText(ctx, data.rating.label, W - M, scoreBaseline, { size: 28, weight: 700, align: 'right' });
  y += L.scoreInk + 14;
  ratingLines.forEach((line) => {
    drawText(ctx, line, M, y, { size: 24, color: SOFT, baseline: 'top' });
    y += RATING_LINE;
  });
  y += L.gapScore;

  // —— 目标色 vs 我的最佳 ——
  const boxW = (CW - 32) / 2;
  const boxH = L.boxH;
  const cells = [
    { title: '目标色', color: data.revealed ? data.target : null },
    { title: '我的最佳', color: data.best },
  ];
  cells.forEach((cell, i) => {
    const x = M + i * (boxW + 32);
    ctx.save();
    roundRect(ctx, x, y, boxW, boxH, 18);
    ctx.clip();
    // 没揭晓时的占位块用 --stage 同一支中性灰：跟站内比色台同一个色，不另开一支 #f2f3f5
    ctx.fillStyle = cell.color ? hslCss(cell.color) : STAGE;
    ctx.fillRect(x, y, boxW, boxH);
    ctx.restore();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, boxW, boxH, 18);
    ctx.stroke();

    drawText(ctx, cell.title, x + 22, y + 20, {
      size: 22,
      weight: 700,
      // 没揭晓时底是浅灰占位块，白字会直接看不见
      color: !cell.color ? FAINT : isLightColor(cell.color) ? INK : '#ffffff', // eslint-disable-line no-nested-ternary
      baseline: 'top',
    });
    // 主副行按色块底边倒着排：块高随版式长开时文字跟着往下走，不会悬在中间
    if (cell.color) {
      drawText(ctx, hslPlain(cell.color), x + 22, y + boxH - 58, {
        size: 24,
        weight: 600,
        color: isLightColor(cell.color) ? INK : '#ffffff',
        baseline: 'top',
      });
      const hsv = hsvOf(cell.color);
      drawText(ctx, `HSV ${hsv.h}°, ${hsv.s}%, ${hsv.v}%`, x + 22, y + boxH - 30, {
        size: 19,
        // 副行不能直接用 SOFT：在目标色这种中等明度的底上对比不够，但又不必和主行争权重
        color: isLightColor(cell.color) ? 'rgba(28,31,36,.78)' : 'rgba(255,255,255,.92)',
        baseline: 'top',
      });
    } else {
      drawText(ctx, 'H *** · S *** · L ***', x + 22, y + boxH - 58, { size: 24, weight: 600, color: FAINT, baseline: 'top' });
      drawText(ctx, '本题还没结算，数值先保密', x + 22, y + boxH - 30, { size: 19, color: FAINT, baseline: 'top' });
    }
  });
  y += boxH + L.gapBoxes;

  // —— 三次猜测 ——
  drawText(ctx, '三次猜测', M, y, { size: 20, weight: 700, color: FAINT, baseline: 'top' });
  y += 20 + 8;
  const dotR = L.dotR;
  const guessTextTop = y + dotR * 2 + L.gapDots;
  for (let i = 0; i < CONFIG.MAX_GUESSES; i += 1) {
    const attempt = data.attempts[i];
    const cx = M + dotR + i * (dotR * 2 + 28);
    const cy = y + dotR;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    if (attempt) {
      ctx.fillStyle = hslCss(attempt);
      ctx.fill();
      // 接近纯白的猜测色在白卡上会直接消失，补一圈淡描边保证边界可读
      ctx.strokeStyle = 'rgba(28,31,36,.14)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (i === data.bestIndex) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
    } else {
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawText(ctx, `第 ${i + 1} 次`, cx, guessTextTop, { size: 19, color: FAINT, align: 'center', baseline: 'top' });
    drawText(ctx, attempt ? `${attempt.score.total.toFixed(1)} 分` : '—', cx, guessTextTop + 25, {
      size: 22,
      weight: 700,
      color: attempt ? scoreColor(attempt.score.total) : LINE,
      align: 'center',
      baseline: 'top',
    });
  }
  // 本题卡到此为止：三次猜测之后直接是页脚，一批题的均分/极值/逐题分布全交给历史卡，
  // 这里不再挂「最近几题」，否则两张卡文案雷同、本题卡反而比历史卡还「历史」。
  // 未揭晓时二维码只能指到首页（载荷里不带目标色），文案不能许一个做不到的承诺
  drawFooter(ctx, {
    url: data.url,
    title: data.revealed ? '扫码看这题的成绩' : '扫码来玩比色挑战',
    note: data.revealed ? '也能照着同一道题再玩一次' : '本题数值结算后才会写进链接',
  });

  return canvas;
}

/** 文件名带上分数，方便在一堆截图里认出是哪一次 */
export function cardFileName(final) {
  return `${CONFIG.CARD.fileName}-${final.toFixed(1)}.png`;
}
