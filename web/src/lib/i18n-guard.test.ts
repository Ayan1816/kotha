import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("components do not hardcode Bengali outside the i18n dictionaries", () => {
  const root = path.join(process.cwd(), "src/components");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".jsx")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/[\u0980-\u09FF]/.test(text)) hits.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
