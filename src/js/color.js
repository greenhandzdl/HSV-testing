/**
 * 颜色模型层：站内一律 HSL 打底；HSV 只是展示用的换算结果，不参与出题与评分。
 * tip* 系列负责浮层文本，四种写法各有分工（见各函数注释），别混用。
 */
import { clamp, esc } from './utils.js';

/** 合法颜色对象：H/S/L 均为整数，越界即截断 */
export function sanitizeColor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = Number(raw.h);
  const s = Number(raw.s);
  const l = Number(raw.l);
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return {
    h: clamp(Math.round(h), 0, 360),
    s: clamp(Math.round(s), 0, 100),
    l: clamp(Math.round(l), 0, 100),
  };
}

export const hslCss = ({ h, s, l }) => `hsl(${h}, ${s}%, ${l}%)`;
export const hslLabel = ({ h, s, l }) => `H ${h}° · S ${s}% · L ${l}%`;
export const hslPlain = ({ h, s, l }) => `${h}, ${s}%, ${l}%`;

/**
 * HSL -> HSV 换算（仅用于展示，站内模型与评分仍是 HSL）
 * V = L + S·min(L, 1−L)；S_hsv = 2·S·min(L, 1−L) / V（V=0 时为 0）
 */
export function hsvOf({ h, s, l }) {
  const S = s / 100;
  const L = l / 100;
  const m = Math.min(L, 1 - L);
  const v = L + S * m;
  return {
    h,
    s: v > 0 ? Math.round(((2 * S * m) / v) * 100) : 0,
    v: Math.round(v * 100),
  };
}

/** HSL -> 8-bit RGB，只用于「这个色块上该写深色字还是浅色字」 */
export function hslToRgb({ h, s, l }) {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const seg =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return seg.map((v) => Math.round((v + m) * 255));
}

/** 感知亮度（Rec. 709），> 0.6 视为浅色，上面要压深色文字 */
export function isLightColor(c) {
  const [r, g, b] = hslToRgb(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
}

/** 浮层文本：两行——HSL 原值 + HSV 换算（+ 该次得分，若有） */
export function tipText(label, c) {
  const hsv = hsvOf(c);
  const score = Number.isFinite(c.total) ? ` · ${c.total.toFixed(1)} 分` : '';
  return `${label} · HSL ${c.h}°, ${c.s}%, ${c.l}%${score}\nHSV ${hsv.h}°, ${hsv.s}%, ${hsv.v}%`;
}

/**
 * 下面三个导出对应三条不同的写入路径，用错一条就会出现「浮层里显示 &#10;」这种事故：
 *   tipAttr  -> 拼进 innerHTML 模板的属性值，需要 esc + 把换行写成 &#10;
 *   tipAria  -> 模板里的 aria-label，读屏不念换行，换成分隔符
 *   tipPlain -> setAttribute 专用；setAttribute 不解码 HTML 实体，必须给裸文本
 */
export const tipAttr = (label, c) => esc(tipText(label, c)).replace(/\n/g, '&#10;');
export const tipAria = (label, c) => esc(tipText(label, c).replace('\n', ' · '));
export const tipPlain = (label, c) => tipText(label, c).replace('\n', ' · ');
