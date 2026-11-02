/* check-ui 的打包配置：与 check-models-ui.rolldown.mjs 同一套 CSS 桩（页面组件里有 `import '…css'`，rolldown 不再打包 CSS，
   所以把 .css 当成空模块），另外 define 一份 import.meta.env.BASE_URL 兜底——lib/expr.ts 自己带 typeof import.meta 守卫，
   但老组件（decor/HerAvatar.tsx 一类）直接读 import.meta.env，Node 里会抛 TypeError，兜底之后静态渲染不会因为它们崩. */
const STUB = '\0alight-css-stub';
export default {
  input: 'scripts/check-ui.ts',
  platform: 'node',
  output: { format: 'esm', file: 'node_modules/.cache/check-ui.mjs' },
  define: { 'import.meta.env.BASE_URL': '"./"' },
  plugins: [{
    name: 'stub-css',
    resolveId(id) { return id.endsWith('.css') ? STUB : null; },
    load(id) { return id === STUB ? { code: 'export default {};', moduleType: 'js' } : null; },
  }],
};
