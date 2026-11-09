# Enhanc Media admin — for agents and people working here

Read `README.md`. This repository holds no knowledge of the website's pages: its forms come from
the website's `content/_schema/`. Website changes therefore need no change here, except a new
kind of field (`lib/schema.mjs`, byte-identical to the website's; `npm run check:schema`).

Never widen what the Worker may write (`writable()` in `worker/index.ts`): content files on the
draft branch, and uploads. Never relax the Access check or the X-Admin/Origin check.
