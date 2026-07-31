import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, "../src");
const PERMISSIONS_FILE = path.join(SRC_DIR, "permissions.js");

function walkJavaScriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJavaScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const LEGACY_ROLE_COMPARISONS = [
  /(?:\.\s*role|\brole)\s*(?:===|!==|==|!=)\s*["'](?:admin|customer)["']/g,
  /["'](?:admin|customer)["']\s*(?:===|!==|==|!=)\s*(?:[\w$?.[\]'"()]+\.)?role\b/g
];

describe("role checks architecture guard", () => {
  it("no compara roles legacy directamente fuera de permissions.js", () => {
    const offenders = [];

    for (const filename of walkJavaScriptFiles(SRC_DIR)) {
      if (filename === PERMISSIONS_FILE) continue;
      const source = stripComments(fs.readFileSync(filename, "utf8"));

      for (const pattern of LEGACY_ROLE_COMPARISONS) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${path.relative(SRC_DIR, filename)}:${line}: ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
