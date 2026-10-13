/**
 * ± 微调按钮：轻点走一格，按住约 0.4 秒后连发，间隔逐帧收窄。
 * 手指拖滑块只能按像素粗调（窄屏上一条轨道摊 360 度），差一两度时拖不准；
 * 但改二十格要点二十下又太累，所以按钮自己处理"按住"。
 *
 * 计数的唯一入口是 click：鼠标、触摸、键盘（Enter / Space）和辅助技术最后都会派发
 * 一次 click，只走这一条路就不会出现「pointerdown 加一格、click 又加一格」的双计。
 * pointerdown 只负责判断"按住了"：到点开始连发，并把紧随其后的那次 click 作废。
 * 妙处是慢速按下再抬起（过了 0.4 秒才抬）也不会多走一格——连发先计了一格，
 * click 被作废，净结果仍是一格。
 */
import { CONFIG } from './config.js';

const { step, holdDelay, fastDelay, rampFrames } = CONFIG.STEPPER;
// 每帧收窄多少：把 holdDelay 到 fastDelay 的差摊到 rampFrames 帧
const ramp = Math.max(1, Math.round((holdDelay - fastDelay) / rampFrames));

/**
 * @param {HTMLElement[]} buttons 带 data-axis（哪条轴）与 data-dir（±1）的按钮
 * @param {(key: string, delta: number) => void} onStep 实际改值的出口
 */
export function bindSteppers(buttons, onStep) {
  buttons.forEach((btn) => {
    const key = btn.dataset.axis;
    const dir = Number(btn.dataset.dir) >= 0 ? 1 : -1;
    let timer = null;
    let delay = holdDelay;
    let repeated = false; // 这次按下是否已由连发计过分，决定随后那次 click 要不要作废

    const stop = () => {
      window.clearTimeout(timer);
      timer = null;
    };
    const tick = () => {
      repeated = true;
      onStep(key, dir * step);
      delay = Math.max(fastDelay, delay - ramp);
      timer = window.setTimeout(tick, delay);
    };

    btn.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return; // 只认主键，右键 / 中键不算按下
      repeated = false;
      stop();
      delay = holdDelay;
      timer = window.setTimeout(tick, delay);
      // 抓住指针：按住时手指略微移动也照样收得到抬起，否则连发会停在无人释放的计时器上
      if (btn.setPointerCapture) btn.setPointerCapture(event.pointerId);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    // 长按时浏览器想弹菜单 / 选中文字，这里直接掐掉
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
    // 键盘激活前一定先有 keydown：用它清掉上一次长按留下的标记，
    // 免得这次 Enter / Space 被当成"已经计过"而吞掉
    btn.addEventListener('keydown', () => {
      repeated = false;
    });

    btn.addEventListener('click', () => {
      if (repeated) {
        repeated = false;
        return; // 连发已经计过，作废这次 click
      }
      onStep(key, dir * step);
    });
  });
}
