// The admin shares two files with the website, which must stay identical:
//  - lib/schema.mjs: a different copy would accept content the website's build rejects, or the reverse;
//  - worker/mail.ts: the one email module both Workers use.
//   node scripts/check-schema-sync.mjs [path-to-website]   (default ../website)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "../website");
let bad = false;
for (const f of ["lib/schema.mjs", "worker/mail.ts"]) {
  const site = path.join(root, f);
  if (!fs.existsSync(site)) {
    console.error(`Cannot find ${site}. Pass the website working copy: node scripts/check-schema-sync.mjs <path>`);
    process.exit(1);
  }
  if (fs.readFileSync(site, "utf8") !== fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) {
    console.error(`${f} differs from the website's copy. Copy the website's file here, check what changed, and release both.`);
    bad = true;
  } else console.log(`${f} matches the website.`);
}
process.exit(bad ? 1 : 0);
