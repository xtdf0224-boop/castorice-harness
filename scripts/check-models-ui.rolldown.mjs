/* check-models-ui 的打包配置：和别的 check:* 一样用 rolldown 打成一个 node 能跑的文件，
   区别只有一处——页面组件里有 `import '…css'`（样式随组件走），rolldown 不再打包 CSS，所以这里把 .css 当成空模块。 */
const STUB = '\0alight-css-stub';
export default {
  input: 'scripts/check-models-ui.ts',
  platform: 'node',
  output: { format: 'esm', file: 'node_modules/.cache/check-models-ui.mjs' },
  plugins: [{
    name: 'stub-css',
    resolveId(id) { return id.endsWith('.css') ? STUB : null; },
    load(id) { return id === STUB ? { code: 'export default {};', moduleType: 'js' } : null; },
  }],
};
