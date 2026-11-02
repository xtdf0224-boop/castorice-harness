/* check-ui-chat 的打包配置：与 check-ui.rolldown.mjs 同一套（CSS 桩 + import.meta.env.BASE_URL 兜底），只换入口与产物名.
   不能与 check-ui 共用一个产物文件：check:modules 里两个检查串行，但各自的 .cache 文件独立，调试时可以单跑. */
const STUB = '\0alight-css-stub';
export default {
  input: 'scripts/check-ui-chat.ts',
  platform: 'node',
  output: { format: 'esm', file: 'node_modules/.cache/check-ui-chat.mjs' },
  define: { 'import.meta.env.BASE_URL': '"./"' },
  plugins: [{
    name: 'stub-css',
    resolveId(id) { return id.endsWith('.css') ? STUB : null; },
    load(id) { return id === STUB ? { code: 'export default {};', moduleType: 'js' } : null; },
  }],
};
