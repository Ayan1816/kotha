import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { translate } from "../components/aegis/copy";

const LITERAL_ATTR = /\b(?:title|aria-label)\s*=\s*["'][^"']*[A-Za-z][^"']*["']/;

test("components do not hardcode Bengali outside the i18n dictionaries", () => {
  const root = path.join(process.cwd(), "src/components");
  const bangla: string[] = [];
  const literals: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".jsx")) continue;
      const text = fs.readFileSync(full, "utf8");
      const relative = path.relative(root, full);
      if (/[\u0980-\u09FF]/.test(text)) bangla.push(relative);
      if (LITERAL_ATTR.test(text)) literals.push(relative);
    }
  };
  walk(root);
  assert.deepEqual(bangla, []);
  assert.deepEqual(literals, []);
});

test("empty states and tooltips come from i18n keys", () => {
  assert.equal(translate("en", "empty"), "No proofs yet.");
  assert.equal(translate("bn", "teeVerifiedTip"), "সিগনেচার অ্যাটেস্টেশন ঠিকানার সাথে মিলেছে এবং রেসপন্স হ্যাশ মিলেছে।");
  assert.equal(translate("en", "translating"), "Translating...");
  assert.equal(translate("bn", "translating"), "অনুবাদ হচ্ছে...");
  assert.equal(translate("en", "blockedByPolicy"), "Blocked by policy");
  assert.equal(translate("en", "connectOwner"), "Connect the owner wallet");
  assert.equal(translate("en", "grantConnect"), "Connect your wallet to manage session grants");
  assert.match(translate("en", "micDeniedHelp"), /browser settings/i);
  const root = path.join(process.cwd(), "src/components/aegis");
  const proofs = fs.readFileSync(path.join(root, "audit-panel.tsx"), "utf8");
  const copilot = fs.readFileSync(path.join(root, "copilot-panel.tsx"), "utf8");
  assert.match(proofs, /translate\(lang, "empty"\)/);
  assert.match(copilot, /translate\(lang, serverVerified \? "teeVerifiedTip" : "teeUnverifiedTip"\)/);
  assert.match(copilot, /translate\(lang, "micDeniedHelp"\)/);
  assert.match(copilot, /translate\(lang, "translating"\)/);
});
