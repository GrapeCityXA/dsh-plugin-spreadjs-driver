/**
 * `*.embed.js` files are page-side script SOURCE, not modules: esbuild inlines
 * them as strings (see `loader` in scripts/build.mjs) so the worker can serve
 * them to the browser verbatim. Declaring the shape here is what lets the worker
 * import one without TypeScript trying to typecheck browser-only code.
 */
declare module '*.embed.js' {
  const source: string
  export default source
}
