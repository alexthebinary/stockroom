// Bundles the API (and the shared domain package) into one file for the
// production image. npm packages stay external and ship in node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
  // ...except our own workspace package, which is TypeScript source.
  alias: { "@pi/domain": "../../packages/domain/src/index.ts" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
