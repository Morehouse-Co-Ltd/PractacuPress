// 首屏主题引导：在 React 挂载之前把明暗偏好写到 <html>，避免深色读者每次
// 刷新都先看到一帧白底、再被主题层改成深色。
//
// 这段逻辑原先是 index.html 里的内联 <script>，但 CSP 的 script-src 'self'
// 不允许内联脚本，浏览器会直接拒绝执行。放到同源外部文件后既符合 CSP，也
// 不需要把哈希写进三份 CSP（启动器、Docker Nginx、生产 Nginx）。
(function () {
  try {
    var match = document.cookie.match(/(?:^|;\s*)pp_theme=(dark|light)(?:;|$)/);
    if (!match) return;
    document.documentElement.dataset.mode = match[1];
    document.documentElement.style.colorScheme = match[1];
  } catch (error) {
    /* Cookie 不可用时交给 React 主题层 */
  }
})();
