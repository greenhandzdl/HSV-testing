/**
 * 卡片工具箱：两张分享卡共用的画布原语、排版引擎、逐题条、页脚与出口。
 *   card-round.js   本题卡（目标色 vs 我的最佳 + 三次猜测）
 *   card-history.js 历史卡（均分为主角 + 逐题条铺满）
 * 本模块不画完整的卡，也不认识 state：数据一律由调用方（game.js）打包送进来，
 * 所以「卡片和页面显示不一致」这类问题只可能是传漏字段，而不是两处各自算一遍。
 *
 * 版式预算制：正文一律不得越过 CONTENT_BOTTOM，否则历史条数一变就会把内容顶到页脚上
 * 重叠——这是画布布局最容易犯的错，历史注释里记着两次。
 *
 * 与站内一致的守则：
 *   - 目标色未揭晓（revealTarget 关着且没结算）时，本题卡不给目标色的色值与色块；
 *   - 逐题条画目标色：历史行都是已结算完成的题，本来就没有剧透谁一说，且面板里的
 *     历史行（ui.js historyDots）也带着目标色方块，卡片不跟它口径不一致。
 */
import { CONFIG } from './config.js?v=16';
import { hslCss } from './color.js?v=16';
import { encode as encodeQr, get as qrGet } from './qr.js?v=16';

const { width: W, height: H, margin: M, qrSize: QR, qrSizeHistory: QRH } = CONFIG.CARD;
export const CW = W - M * 2;
// 页脚（二维码）顶边由卡片高度反推。本题卡用 QR（340），历史卡用放大后的 QRH。
export const FOOT_TOP = H - M - QR;
export const CONTENT_BOTTOM = FOOT_TOP - 24;
export { W, H, M, QR, QRH };
// 内容区可用高度：所有 stretch 表的预算上限都从这里来
export const AVAIL = CONTENT_BOTTOM - M;
// 历史卡专用：页脚二维码放大后顶边上抬，正文可用高相应收缩（card-history.js 按此重算行数）
export const CONTENT_BOTTOM_H = H - M - QRH - 24;
export const AVAIL_H = CONTENT_BOTTOM_H - M;

export const INK = '#171a20';
export const SOFT = '#454b54';
export const FAINT = '#606873';
export const LINE = '#dce1ec';
export const SURFACE = '#ffffff';
export const ACCENT = '#3b6ef5';
const OK = '#1b7a52';
const DANGER = '#c2413a';
// 与站内同一套冷调中性衬底：色块坐在上头，跟比色台那个 .stage 呼应，
// 也保证读者在手机相册里看到的包围环境跟网页一致
export const STAGE = '#f4f5f7';
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Noto Sans SC", sans-serif';

// 评价文案行高（字号 24）：两张卡都用同一句式的文案，行高不该分叉
export const RATING_LINE = 30;
// 数字墨迹高 ≈ 0.7 em：版式按墨迹高度算，字号反推回去
export const DIGIT_INK = 0.7;

export const px = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

/** 分数四档取色：跟站内的分数徽章同一把尺，卡上卡下不能两个颜色 */
export function scoreColor(score) {
  if (score >= CONFIG.STREAK.threshold) return OK;
  if (score >= 70) return ACCENT;
  if (score >= 50) return SOFT;
  return DANGER;
}

/**
 * 圆角矩形：四个角各一段 arcTo，不多不少。
 * 多补一段会把已经倒过的角再倒一次，路径自交——fill 看不出来，
 * 但 save/clip 时会在块里切出一道斜白边（色块上就是这么露出来的）。
 */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawText(ctx, str, x, y, { size = 20, weight = 400, color = INK, align = 'left', baseline = 'alphabetic' } = {}) {
  ctx.font = px(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** 按像素宽度折行（中文没有空格，只能逐字量） */
export function wrap(ctx, str, maxWidth, font) {
  ctx.font = font;
  const lines = [];
  let line = '';
  for (const ch of String(str)) {
    if (ctx.measureText(`${line}${ch}`).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 文字真实墨迹的上伸高度；量不到（老 Safari 没有 actualBoundingBox）时退回字号估算 */
export function inkAscent(ctx, str, size, font) {
  ctx.font = font;
  const m = ctx.measureText(str);
  const a = m.actualBoundingBoxAscent;
  return { width: m.width, ascent: a > 0 ? a : size * 0.72 };
}

/** 卡片顶边那条 12px 色带：一眼认出是哪张卡，又不影响色块本身的判断 */
export function drawTopBand(ctx, color) {
  ctx.fillStyle = color || LINE;
  ctx.fillRect(0, 0, W, 12);
}

/** 标题行：左边产品名，右边这张卡的口径（难度/题号 或 难度范围/样本数） */
export function drawTitle(ctx, right) {
  drawText(ctx, '颜色比色挑战', M, M, { size: 34, weight: 700, baseline: 'top' });
  drawText(ctx, right, W - M, M + 34 - 22, { size: 22, weight: 600, color: FAINT, align: 'right', baseline: 'top' });
  const y = M + 34 + 22;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(M, y + 1);
  ctx.lineTo(W - M, y + 1);
  ctx.stroke();
  return y + 2; // 分隔线画在 y+1、线宽 2，正文从 y+2 起算才不会压线
}

/* ---------------------------------- 排版引擎 ---------------------------------- */
/**
 * 把「剩余容量」按权重摊给能长的几段，摊到 max 为止，所以正文正好落在 CONTENT_BOTTOM 上。
 * min 装不下就先减行，而不是把行高压扁——压扁的行里圆点和进度条会糊在一起，
 * 少画一条只是信息少一点。
 *
 * room / cap / add 都是「占了多少像素」的口径；dotR 占 2r、rowH 计 rows 倍，
 * 所以把 add 折回单值必须除以 span。上一版直接 size[k] += add，
 * rows=1 时 dotR 从 40 冲到 63（max 是 54），正文比预算多走 30px 顶穿 CONTENT_BOTTOM。
 *
 * @param {object} table  { key: {min, max, w} }
 * @param {number} rowsMax 行数上限
 * @param {number} wantRows 想画的行数（超过上限会被截断）
 * @param {number} fixed 不参与拉伸的固定高度之和
 * @param {number} avail 内容区可用高（默认本题卡的 AVAIL；历史卡放大页脚后传 AVAIL_H）
 */
export function distribute(table, rowsMax, wantRows, fixed, avail = AVAIL) {
  const span = (k, rows) => (k === 'rowH' ? rows : table[k].span || 1);
  const sum = (key, rows) => Object.keys(table).reduce((s, k) => s + table[k][key] * span(k, rows), 0);
  let rows = Math.max(0, Math.min(wantRows, rowsMax));
  while (rows > 0 && fixed + sum('min', rows) > avail) rows -= 1;

  const size = {};
  Object.keys(table).forEach((k) => { size[k] = table[k].min; });
  let left = avail - fixed - sum('min', rows);
  while (left > 0.5) {
    let cap = 0;
    Object.keys(table).forEach((k) => {
      cap += Math.max(0, table[k].max - size[k]) * span(k, rows) * table[k].w;
    });
    if (cap <= 0) break;
    let used = 0;
    Object.keys(table).forEach((k) => {
      const room = Math.max(0, table[k].max - size[k]) * span(k, rows);
      if (room <= 0) return;
      const add = Math.min(room, (left * room * table[k].w) / cap);
      size[k] += add / span(k, rows);
      used += add;
    });
    left -= used;
    if (used <= 0) break;
  }
  size.rows = rows;
  return size;
}

/* ---------------------------------- 逐题条 ---------------------------------- */
// 行解剖：[■目标色][●●●]  第 N 题 · 难度 D   ██████░░░░  78.4
// 方形 = 目标色，圆形 = 各次猜测，蓝环 = 最佳那次，与站内历史行同一套。
// 不逐点标分数：行高只有 44–94 时三行字下不去，而行尾已经有本题最终分。
// 下面全是 rowH=56 基准下的尺寸，行少时整行按 rowScale 放大。
const ROW_SQ = 26; // 目标色方块边长：圆角只留 5，再大就和旁边的圆点分不开
const ROW_DOT_R = 11; // 猜测点半径
const ROW_SCORE_W = 96; // 行尾分数右对齐留位（含与进度条的间距）
// 方块 26 + 12 + 三个点 66 + 两个点间距 12 + 16 = 132，即标签列起点偏移
const ROW_LABEL_DX = ROW_SQ + 12 + ROW_DOT_R * 6 + 12 + 16;
const ROW_GAP_LABEL_BAR = 18; // 标签列 → 进度条

export const rowLabel = (entry, current) => `第 ${entry.question} 题 · 难度 ${entry.difficulty}${current ? ' · 本题' : ''}`;

/** 行内元素随行高放大，字号封顶 1.5×：再大就只是把同一行字拉粗，读起来不像排版 */
export function rowScale(rowH) {
  return Math.min(1.5, Math.max(1, rowH / 56));
}

/**
 * 进度条的起点与宽度。标签列宽按真实量出来的最长文案留，不写死：
 * 行高放大时字号也在长，而「第 100 题 · 难度 10 · 本题」比基准文案宽出不少，
 * 写死迟早让进度条从文字底下穿过。
 */
export function rowBarLayout(ctx, rows, s, currentQuestion) {
  ctx.font = px(20 * s);
  let labelW = 0;
  rows.forEach((e) => {
    labelW = Math.max(labelW, ctx.measureText(rowLabel(e, e.question === currentQuestion)).width);
  });
  const barX = M + ROW_LABEL_DX * s + Math.ceil(labelW) + ROW_GAP_LABEL_BAR;
  return { barX, barW: W - M - ROW_SCORE_W * s - barX };
}

/** 一行历史：目标色方块 + 三次猜测点 + 题号难度 + 分数条 + 分数 */
export function drawHistoryRow(ctx, entry, x, cy, barX, barW, s, current = false) {
  const sq = ROW_SQ * s;
  const dotR = ROW_DOT_R * s;
  if (entry.target) {
    roundRect(ctx, x, cy - sq / 2, sq, sq, 5 * s);
    ctx.fillStyle = hslCss(entry.target);
    ctx.fill();
    ctx.strokeStyle = 'rgba(28,31,36,.14)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const totals = entry.guesses.map((g) => g.total);
  const bestIdx = totals.indexOf(Math.max(...totals));
  entry.guesses.slice(0, CONFIG.MAX_GUESSES).forEach((g, i) => {
    const cx = x + sq + 12 * s + dotR + i * (dotR * 2 + 6 * s);
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = hslCss(g);
    ctx.fill();
    ctx.strokeStyle = i === bestIdx ? ACCENT : 'rgba(28,31,36,.14)';
    ctx.lineWidth = i === bestIdx ? 4 : 2;
    ctx.stroke();
  });

  drawText(ctx, rowLabel(entry, current), x + ROW_LABEL_DX * s, cy - 10 * s, {
    size: 20 * s,
    weight: current ? 700 : 400,
    color: current ? INK : SOFT,
    baseline: 'top',
  });
  const barH = 14 * s;
  ctx.fillStyle = STAGE;
  roundRect(ctx, barX, cy - barH / 2, barW, barH, barH / 2);
  ctx.fill();
  ctx.fillStyle = scoreColor(entry.final);
  roundRect(ctx, barX, cy - barH / 2, Math.max(barH, (barW * entry.final) / 100), barH, barH / 2);
  ctx.fill();
  drawText(ctx, entry.final.toFixed(1), W - M, cy - 11 * s, {
    size: 22 * s,
    weight: 700,
    color: scoreColor(entry.final),
    align: 'right',
    baseline: 'top',
  });
}

/* ---------------------------------- 二维码与页脚 ---------------------------------- */
/**
 * 静区 + 整数倍放大：340px 里放 57 格时 scale 取 5（实际 285px）并居中。
 * 用小数 scale 会让相邻模块差 1px，解码器对模块大小一致性很敏感，宁可留白也不按比例铺满。
 */
export function drawQr(ctx, url, x, y, box) {
  let qr = null;
  try {
    qr = encodeQr(url, { ecLevel: CONFIG.CARD.qrEcLevel });
  } catch (err) {
    qr = null; // 载荷超容量（share.js 已兜底，理论到不了这里）：只画地址文本
  }
  ctx.fillStyle = SURFACE;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, box, box, 16);
  ctx.fill();
  ctx.stroke();
  if (!qr) {
    drawText(ctx, '二维码生成失败', x + box / 2, y + box / 2, { size: 22, color: FAINT, align: 'center' });
    return;
  }
  const cells = qr.size + 8; // 四周各 4 格静区，标准要求
  const scale = Math.floor((box - 24) / cells);
  const side = scale * cells;
  // 居中偏移也要取整：340-285=55 是奇数，(box-side)/2 = 27.5 会让每个模块都跨过半像素，
  // 于是整张码的每一条模块边界都被反锯齿抹成 1px 灰缝（实测 1080×1350 的卡上有 1.6 万个灰像素，
  // 占点阵区 21%）。模块中心仍是实色，扫码扫得动，但没必要给解码器添活——宁可偏半格也别糊边。
  const ox = Math.round(x + (box - side) / 2);
  const oy = Math.round(y + (box - side) / 2);
  ctx.fillStyle = INK;
  for (let r = 0; r < qr.size; r += 1) {
    for (let c = 0; c < qr.size; c += 1) {
      if (qrGet(qr, r, c)) ctx.fillRect(ox + (c + 4) * scale, oy + (r + 4) * scale, scale, scale);
    }
  }
}

/**
 * 页脚：右下有界二维码，左列说明文字跟它等高居中（以前从页脚顶往下堆，二维码底边留一大截空白）。
 * 两张卡只有那两句话不同，所以抽出来共用；地址最多两行，超出用省略号收尾。
 */
export function drawFooter(ctx, { url, title, note, box = QR }) {
  const footTop = H - M - box;
  drawQr(ctx, url, W - M - box, footTop, box);
  const urlAll = wrap(ctx, url, CW - box - 40, px(19));
  const urlLines = urlAll.slice(0, 2);
  if (urlAll.length > urlLines.length) urlLines[urlLines.length - 1] += '…';
  const colH = 26 + 10 + 21 + 24 + urlLines.length * 19 + (urlLines.length - 1) * 8 + 22 + 18;
  let fy = footTop + (box - colH) / 2;
  drawText(ctx, title, M, fy, { size: 26, weight: 700, baseline: 'top' });
  fy += 36;
  drawText(ctx, note, M, fy, { size: 21, color: SOFT, baseline: 'top' });
  fy += 45;
  urlLines.forEach((line) => {
    drawText(ctx, line, M, fy, { size: 19, color: FAINT, baseline: 'top' });
    fy += 27;
  });
  fy += 14;
  drawText(ctx, new Date().toLocaleDateString(), M, fy, { size: 18, color: FAINT, baseline: 'top' });
}

/* ---------------------------------- 出口 ---------------------------------- */
function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * 卡片出口：能分享文件就交给系统分享面板，并把分享结果当作**终点**——成功 / 取消 / 被打断
 * 都到此为止，绝不再补一次下载。以前的写法把「share 抛出非 AbortError」也当成降级信号，
 * 于是用户拿到「系统分享出去的一张 + 又自动下载的一张」= 两张图片（iOS/Safari 关掉分享面板、
 * NotAllowedError、手势丢失都会走进这个坑）。只有系统**根本不支持文件分享**时才降级为下载，
 * 且下载也只产出一张。
 * 分享时只带图片文件本身，不附带 title / text：一次带上「图片 + 文本」会让系统分享面板把
 * 两项一起塞进粘贴板，拷贝时出现「图片 + 富文本预览」两张；QQ 一类不支持文件的目标又只取文本、
 * 把图片丢掉。卡片画面已含全部信息，无需额外文案——只分享这一张 PNG。
 * name 由调用方给：两张卡的文件名口径不同，不该在这里猜是哪一张。
 * @returns {Promise<'shared'|'cancelled'|'downloaded'|'failed'>}
 */
export async function outputCard(canvas, { name }) {
  const blob = (await toBlob(canvas)) || null;
  if (!blob) return 'failed';

  // File 构造失败（无 File / 无 share 的旧环境）时留空，直接落到下面的下载分支
  let file = null;
  try {
    if (typeof File === 'function') file = new File([blob], name, { type: 'image/png' });
  } catch (err) {
    file = null;
  }

  if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      // 用户主动取消（AbortError）与其它异常都视作「分享这条路径已经结束」，不再往下走下载；
      // 只有非取消的失败才回 'failed' 让上层提示重试，取消则安静返回 'cancelled'
      return err && err.name === 'AbortError' ? 'cancelled' : 'failed';
    }
  }

  // 系统不支持文件分享（桌面旧版 / Firefox 等）：下载是这里唯一的出口，依旧只产出一张
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  return 'downloaded';
}
