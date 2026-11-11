// boot.js — 첫 화면이 그려지기 전에 테마·글자 크기를 적용한다. (모듈이 아닌 일반 스크립트)
// 설정의 원본은 IndexedDB에 있고, 여기서는 localStorage에 복사해 둔 값만 읽는다.
(function () {
  var root = document.documentElement;
  var theme = 'system';
  var font = 'm';
  try {
    theme = localStorage.getItem('de:theme') || 'system';
    font = localStorage.getItem('de:font') || 'm';
  } catch (e) {
    /* 사생활 보호 모드 등에서 localStorage를 못 쓸 수 있다 */
  }
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.font = font;
})();
