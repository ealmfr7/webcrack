import esbuild from 'esbuild';

const args = process.argv.slice(2);
const watch = args.length > 0 && /^(?:--watch|-w)$/i.test(args[0]);

/**
 * Fixes https://github.com/babel/babel/issues/15269
 * (copied from packages/webcrack/esbuild.config.js)
 * @type {esbuild.Plugin}
 */
const babelImportPlugin = {
  name: 'babel-import',
  setup: (build) => {
    build.onResolve({ filter: /^@babel\/(traverse|generator)$/ }, (args) => {
      return {
        path: args.path,
        namespace: 'babel-import',
      };
    });

    build.onLoad({ filter: /.*/, namespace: 'babel-import' }, (args) => {
      return {
        resolveDir: 'node_modules',
        contents: `import module from '${args.path}/lib/index.js';
          export default module.default ?? module;
          export * from '${args.path}/lib/index.js';`,
      };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: 'dist',
  sourcemap: true,
  packages: 'external',
  // Resolve webcrack through its dist at runtime instead of inlining its
  // source via the tsconfig `paths` alias (which drags in webcrack-only
  // deps like `debug` that this package does not declare).
  external: ['webcrack', 'webcrack/*'],
  plugins: [babelImportPlugin],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
