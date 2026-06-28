// Treat .json imports as `unknown` so the type-checker doesn't parse the 2.7 MB
// lens database to infer a literal type. The bundler (rolldown) inlines the real
// JSON at build time; the loader casts it to LensfunLens[].
declare module "*.json" {
  const value: unknown;
  export default value;
}
