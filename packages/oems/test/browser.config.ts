/** Browser bundling verification only; not an application build pipeline. */
export default {
  build: {
    target: 'es2024',
    outDir: '/tmp/clio-oems-browser-build',
    emptyOutDir: true,
    lib: {
      entry: new URL('../src/index.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: 'oems',
    },
  },
};
