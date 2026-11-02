// 渲染用的 vite dev 配置（无 HMR、不监视文件）。由 render.mjs 通过环境变量 BV_ROOT 指定源码镜像。
// 缓存放镜像自己的目录里，不写仓库的 node_modules/.vite。
export default {
  root: process.env.BV_ROOT,
  base: './',
  cacheDir: process.env.BV_ROOT + '/.vite-cache',
  server: { port: Number(process.env.BV_PORT || 5332), strictPort: true, hmr: false, watch: null, host: '127.0.0.1' },
  logLevel: 'warn',
};
