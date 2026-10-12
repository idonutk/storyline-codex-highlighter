import esbuild from "esbuild";
import process from "node:process";

const production = process.argv[2] === "production";
const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production
};

if (production) {
  await esbuild.build(options);
} else {
  const context = await esbuild.context(options);
  await context.watch();
}