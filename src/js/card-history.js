/**
 * 历史卡：均分大数字为主角 + 概览行 + 逐题条铺满 + 二维码。
 * 与本题卡的分工：本题卡讲这一题的对比，历史卡讲一批题的分布，
 * 所以行渲染器 / 排版引擎 / 页脚都取自 card.js 工具箱，这里只留历史卡自己的版式表。
 *
 * 行数跟着面板的「最近 N」档位走（5/8/10），版面顶多 HISTORY_CARD_ROWS 行。
 */
import { W, H, M,
  SURFACE, SOFT, FAINT,
  RATING_LINE, DIGIT_INK, AVAIL_H, CONTENT_BOTTOM_H,
  px, scoreColor, drawText, wrap, inkAscent,
  drawTopBand, drawTitle, distribute, rowScale, rowBarLayout, drawHistoryRow, drawFooter,
} from './card.js?v=16';
import { CONFIG } from './config.js?v=16';

/** 历史卡最多画几条：面板的「最近 N」档位是 5/8/10，这里按上限铺满（game.js 取数共用） */
export const HISTORY_CARD_ROWS = 10;

// 不参与拉伸的固定量：标题 34 + 到分隔线 22 + 分隔线 2 + 「平均准确率」20 + 6 + 数字到文案行 14
const FIXED_TOP = 34 + 22 + 2 + 20 + 6 + 14;
const STATS_LINE = 20; // 概览行行高（字号 20）
const STRETCH = {
  gapHead: { min: 22, max: 40, w: 1 }, // 分隔线 → 「平均准确率」
  scoreInk: { min: 76, max: 100, w: 1.4 },
  gapLine: { min: 20, max: 38, w: 1 }, // 文案 → 概览行
  gapRows: { min: 18, max: 34, w: 1 }, // 概览行 → 第一行
  rowH: { min: 44, max: 56, w: 2 }, // 计 rows 倍
};

/**
 * 行少的时候把空间给「行本身」而不是给空隙：同一张表摊到 gap 上会撑出 130px
 * 的段距，卡读起来就是塌了一块。rowH 上限由「扣掉固定段与其它段上限后的预算 ÷ 行数」
 * 反算（再夹到 56–132），所以 5 题以上能正好铺到页脚，1–4 题则先长到 132 封顶、
 * 剩下的零头交给 renderHistoryCard 里的居中偏移。
 */
function layoutTable(rows, fixed) {
  const table = {};
  Object.keys(STRETCH).forEach((k) => { table[k] = { ...STRETCH[k] }; });
  table.scoreInk.max = rows >= 5 ? 100 : 150;
  const others = Object.keys(table).reduce((s, k) => (k === 'rowH' ? s : s + table[k].max), 0);
  const perRow = Math.floor((AVAIL_H - fixed - others) / Math.max(rows, 1));
  table.rowH.max = Math.min(132, Math.max(56, perRow));
  return table;
}

function layoutCard(wantRows, nLines) {
  const fixed = FIXED_TOP + nLines * RATING_LINE + STATS_LINE;
  const rows = Math.max(0, Math.min(wantRows, HISTORY_CARD_ROWS));
  return distribute(layoutTable(rows, fixed), HISTORY_CARD_ROWS, wantRows, fixed, AVAIL_H);
}

/**
 * @param {object} data { scopeText, stats:{count,avg,max,min,std}, rating:{label,line},
 *                        history:[{question,difficulty,target,guesses,final}], url }
 * @returns {HTMLCanvasElement}
 */
export function renderHistoryCard(data) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stats = data.stats;

  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);
  // 顶带走均分的分数色（历史卡没有单一目标色可取）
  drawTopBand(ctx, scoreColor(stats.avg));

  let y = drawTitle(ctx, data.scopeText);

  // —— 均分（主角）+ 档位 + 文案 ——
  const lines = wrap(ctx, data.rating.line, W - M * 2, px(24)).slice(0, 2);
  const L = layoutCard(data.history.length, lines.length);
  y += L.gapHead;
  drawText(ctx, '平均准确率', M, y, { size: 20, weight: 700, color: FAINT, baseline: 'top' });
  y += 20 + 6;
  const avgText = stats.avg.toFixed(1);
  const avgSize = L.scoreInk / DIGIT_INK;
  const ink = inkAscent(ctx, avgText, avgSize, px(avgSize, 800));
  const avgBaseline = y + ink.ascent;
  drawText(ctx, avgText, M, avgBaseline, { size: avgSize, weight: 800, color: scoreColor(stats.avg) });
  drawText(ctx, '/ 100', M + ink.width + 12, avgBaseline, { size: 26, weight: 600, color: FAINT });
  drawText(ctx, data.rating.label, W - M, avgBaseline, { size: 28, weight: 700, align: 'right' });
  y += L.scoreInk + 14;
  lines.forEach((line) => {
    drawText(ctx, line, M, y, { size: 24, color: SOFT, baseline: 'top' });
    y += RATING_LINE;
  });
  y += L.gapLine;

  // —— 概览行 + 逐题条：整块在剩余空间里垂直居中 ——
  // 零头既不该堆在底部（那就是塌了一块），也不该继续摊进 gap（gap 过 40 就散架），
  // 对半开是剩下唯一还读得通的处理：上下各留一半，读起来是版心而不是空页脚。
  const s = rowScale(L.rowH);
  const blockH = STATS_LINE + L.gapRows + L.rows * L.rowH;
  const slack = CONTENT_BOTTOM_H - y - blockH;
  if (slack > 0) y += slack / 2;

  // 均分已经是主角，概览行只补极值与离散度（一题时两者没意义，不写）
  const parts = [`共 ${stats.count} 题`];
  if (stats.count > 1) parts.push(`最高 ${stats.max.toFixed(1)}`, `最低 ${stats.min.toFixed(1)}`, `稳定度 ±${stats.std.toFixed(1)}`);
  drawText(ctx, parts.join(' · '), M, y, { size: 20, weight: 700, color: FAINT, baseline: 'top' });
  y += STATS_LINE + L.gapRows;

  const { barX, barW } = rowBarLayout(ctx, data.history.slice(0, L.rows), s, null);
  for (let i = 0; i < L.rows; i += 1) {
    drawHistoryRow(ctx, data.history[i], M, y + i * L.rowH + L.rowH / 2, barX, barW, s);
  }

  drawFooter(ctx, {
    url: data.url,
    title: '扫码看这份成绩单',
    note: '只读，不写入你的本地记录',
    box: CONFIG.CARD.qrSizeHistory, // 历史卡二维码放大：页脚顶边上抬，上面已按 AVAIL_H 重算正文预算
  });

  return canvas;
}

/** 历史卡文件名带均分 */
export function historyCardFileName(avg) {
  return `${CONFIG.CARD.historyFileName}-${avg.toFixed(1)}.png`;
}
