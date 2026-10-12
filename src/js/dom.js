/**
 * DOM 引用与轻提示。el 是缓存过的 id -> element 映射，必须在任何渲染前跑一次 cacheDom()。
 * id 列表与 index.html 一一对应：HTML 里改了 id 而这里没跟上，el.xxx 就是 undefined，
 * 报错点会落在很远的渲染函数里，所以新增控件请两处同时改。
 */
export const el = {};

export function cacheDom() {
  [
    'levelBadge',
    'levelBadgeValue',
    'btnLevelDown',
    'btnLevelUp',
    'contextBanner',
    'mainLayout',
    'shareView',
    'shareTitle',
    'shareBody',
    'btnExitShare',
    'difficultySelect',
    'autoDifficulty',
    'revealTarget',
    'levelHint',
    'targetSwatch',
    'guessSwatch',
    'targetReadout',
    'guessReadout',
    'guessList',
    'stageNote',
    'rangeHue',
    'rangeSat',
    'rangeLight',
    'outHue',
    'outSat',
    'outLight',
    'btnSubmit',
    'submitCount',
    'btnReset',
    'btnNext',
    'feedbackCard',
    'resultCard',
    'shareLink',
    'btnCopyLink',
    'btnCopyResult',
    'historyPanel',
    'recentCount',
    'stats',
    'metaLine',
    'historyList',
    'historyEmpty',
    'btnViewHistory',
    'btnShareHistory',
    'btnHistoryCard',
    'btnClearHistory',
    'btnMakeCard',
    'toast',
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
  el.segButtons = Array.from(document.querySelectorAll('.seg__btn'));
}

let toastTimer = null;
export function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', Boolean(isError));
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}
