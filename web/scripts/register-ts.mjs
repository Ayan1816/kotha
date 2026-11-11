import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function withTsExtension(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.(?:[cm]?js|json|tsx?)$/.test(specifier)
  ) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const candidate = resolve(dirname(parent), `${specifier}.ts`);
    if (existsSync(candidate)) return nextResolve(`${specifier}.ts`, context);
    const tsx = resolve(dirname(parent), `${specifier}.tsx`);
    if (existsSync(tsx)) return nextResolve(`${specifier}.tsx`, context);
  }
  return nextResolve(specifier, context);
}

// Lets `node --test` load TypeScript, including the Next.js `@/` alias, without a bundler.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const bare = resolve(srcRoot, specifier.slice(2));
      const file = [`${bare}.ts`, `${bare}.tsx`, bare].find((candidate) => existsSync(candidate));
      if (file) return withTsExtension(pathToFileURL(file).href, context, nextResolve);
    }
    return withTsExtension(specifier, context, nextResolve);
  },
  // Node's type stripper does not transform JSX. Tests that render a component need this.
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const source = readFileSync(filename, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: filename,
    }).outputText;
    return { format: "module", source: transpiled, shortCircuit: true };
  },
});
