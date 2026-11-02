/* A stand-in for window.alightDesktop for the page-state checks (check-services): src/lib/desktop.ts reads the bridge ONCE when it is loaded,
   so this module has to be the first import of the check. Every member is looked up at call time in `impl`, which the check fills in
   (usually by wiring the real main-process registry to it — page logic and desktop logic then run against each other without IPC). */
export const impl: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.alightDesktop = new Proxy({}, {
  get: (_t, key) => {
    if (key === 'version') return 1;
    if (key === 'onEvent') return () => () => {};
    return typeof key === 'string' ? impl[key] : undefined;
  },
});
