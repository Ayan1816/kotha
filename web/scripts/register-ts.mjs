import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
});
