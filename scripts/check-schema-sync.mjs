// The admin validates with a copy of the website's lib/schema.mjs. The two must be identical;
// a different copy would accept content the website's build rejects, or the reverse.
//   node scripts/check-schema-sync.mjs [path-to-website]   (default ../website)
import fs from "node:fs";
import path from "node:path";

const site = path.resolve(process.argv[2] ?? "../website", "lib/schema.mjs");
if (!fs.existsSync(site)) {
  console.error(`Cannot find ${site}. Pass the website working copy: node scripts/check-schema-sync.mjs <path>`);
  process.exit(1);
}
const a = fs.readFileSync(site, "utf8");
const b = fs.readFileSync(new URL("../lib/schema.mjs", import.meta.url), "utf8");
if (a !== b) {
  console.error("lib/schema.mjs differs from the website's copy. Copy the website's file here, check what changed, and release both.");
  process.exit(1);
}
console.log("lib/schema.mjs matches the website.");
