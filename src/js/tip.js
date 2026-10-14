/**
 * 即时数值浮层：悬停 / 键盘聚焦 / 触屏点击都能看到 HSL 与 HSV。
 * 数值以前只挂在 title 上：触屏与键盘拿不到，原生提示还要等约一秒。
 * 浮层挂在 body 上用 position:fixed 定位，不会被 .history 的 overflow 滚动容器裁掉；
 * 用 document 委托监听，历史列表反复 innerHTML 重渲染也不需重新绑定。
 */
import { clamp } from './utils.js?v=17';

const box = document.createElement('div');
box.className = 'tip';
box.hidden = true;
let current = null;

const owner = (e) => (e.target && e.target.closest ? e.target.closest('[data-tip]') : null);

export function show(target) {
  const text = target.getAttribute('data-tip');
  if (!text) {
    hide();
    return;
  }
  if (box.textContent !== text) box.textContent = text;
  box.hidden = false;
  current = target;
  // 先量尺寸再定位（hidden=false 之后才能量到）
  const r = target.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  let left = r.left + r.width / 2 - b.width / 2;
  left = clamp(left, 8, Math.max(8, window.innerWidth - b.width - 8));
  let top = r.top - b.height - 8;
  if (top < 8) top = r.bottom + 8; // 上方放不下就翻到下方
  box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export function hide() {
  current = null;
  box.hidden = true;
}

export function bind() {
  document.body.appendChild(box);
  document.addEventListener('mouseover', (e) => {
    const t = owner(e);
    if (t) show(t);
    else if (current) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = owner(e);
    if (t) show(t);
    else if (current) hide();
  });
  document.addEventListener('focusout', () => {
    if (current) hide();
  });
  // 触屏没有 hover，点一下色块同样出数值
  document.addEventListener('click', (e) => {
    const t = owner(e);
    if (t) show(t);
  });
  document.addEventListener('mouseleave', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (current) hide();
    },
    true
  );
  window.addEventListener('resize', hide);
}
