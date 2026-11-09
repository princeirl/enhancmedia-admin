"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor, Loading, useSorted } from "@/components/Editor";
import { Login } from "@/components/Login";
import { ApiError, api, type Me, type State } from "@/lib/api";
import { Store } from "@/lib/docs";
import { FORMAT, validateSchema } from "@/lib/schema.mjs";
import type { Schema } from "@/lib/types";

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <App />
    </Suspense>
  );
}

function App() {
  const params = useSearchParams();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [schemas, setSchemas] = useState<Schema[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [boot, setBoot] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [menu, setMenu] = useState(false);
  const dirty = useRef(false);
  const setDirty = useCallback((d: boolean) => { dirty.current = d; }, []);

  const store = useMemo(() => (schemas ? new Store(schemas) : null), [schemas]);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
    } catch {
      /* the next poll will try again */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setSignedOut(false);
        setMe(await api.me());
        await api.sync(); // brings website changes (new pages, new fields) into the draft
        const { schemas } = await api.schemas();
        const bad = schemas.flatMap((s) => validateSchema(s));
        if (schemas.some((s) => s.$format !== FORMAT)) {
          setFatal(`The website uses content schema format ${schemas.find((s) => s.$format !== FORMAT)?.$format}; this admin understands format ${FORMAT}. The admin needs an update.`);
          return;
        }
        if (bad.length) console.warn("schema problems", bad);
        setSchemas(schemas);
        await refresh();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setSignedOut(true);
        else setFatal(e instanceof Error ? e.message : "The admin could not start.");
      }
    })();
  }, [refresh, boot]);

  // While a preview is building, check every 10 seconds.
  useEffect(() => {
    const building = state?.build?.state === "pending";
    const t = setInterval(refresh, building ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [state, refresh]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const nav = useCallback(
    (s: string, item?: string | null) => {
      if (dirty.current && !confirm("You have unsaved changes. Leave without saving?")) return;
      dirty.current = false;
      const q = new URLSearchParams({ s });
      if (item) q.set("i", item);
      router.push(`/?${q.toString()}`);
      setMenu(false);
    },
    [router],
  );

  const groups = useSorted(schemas ?? []);

  if (signedOut) return <Login onDone={() => setBoot((b) => b + 1)} />;
  if (fatal) return <Centered><p className="max-w-md text-center text-sm text-danger">{fatal}</p></Centered>;
  if (!me || !schemas || !store) return <Centered><Loading /></Centered>;

  const current = schemas.find((s) => s.id === params.get("s"));
  const item = params.get("i");

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar me={me} state={state} refresh={refresh} onMenu={() => setMenu(!menu)} nav={nav} />
      <div className="flex flex-1">
        <aside className={`${menu ? "block" : "hidden"} fixed inset-x-0 bottom-0 top-14 z-30 overflow-y-auto border-r border-line bg-white px-3 py-5 md:static md:block md:w-64 md:shrink-0`}>
          <button onClick={() => nav("")} className={`mb-4 block w-full rounded-md px-3 py-2 text-left text-sm font-medium ${!current ? "bg-paper" : "hover:bg-paper"}`}>
            Overview
          </button>
          {groups.map(([group, list]) => (
            <div key={group} className="mb-5">
              <p className="px-3 pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted">{group}</p>
              {list.map((s) => (
                <button
                  key={s.id}
                  onClick={() => nav(s.id)}
                  className={`block w-full truncate rounded-md px-3 py-1.5 text-left text-sm ${current?.id === s.id ? "bg-ink text-white" : "text-charcoal hover:bg-paper"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
          {current ? (
            <Editor schema={current} item={item} store={store} nav={nav} onSaved={refresh} previewUrl={me.previewUrl} setDirty={setDirty} />
          ) : (
            <Overview schemas={schemas} state={state} me={me} nav={nav} />
          )}
        </main>
      </div>
    </div>
  );
}

function TopBar({ me, state, refresh, onMenu, nav }: { me: Me; state: State | null; refresh: () => Promise<void>; onMenu: () => void; nav: (s: string) => void }) {
  const [busy, setBusy] = useState<null | "publish" | "discard">(null);
  const changes = state?.changes.length ?? 0;
  const b = state?.build;
  const building = b?.state === "pending";
  const failed = b?.state === "failure";
  const unknown = !b || b.state === "unknown";
  const ready = changes > 0 && !building && !failed;

  const publish = async () => {
    const check = unknown ? "\n\nNo preview build has been reported for these changes. Check the preview before publishing." : "";
    if (!confirm(`Publish ${changes} change${changes === 1 ? "" : "s"} to ${me.siteUrl}? The live site updates in about two minutes.${check}`)) return;
    setBusy("publish");
    try {
      await api.publish();
      alert("Published. The live site will update in about two minutes.");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const discard = async () => {
    if (!confirm("Discard every unpublished change? This cannot be undone.")) return;
    setBusy("discard");
    try {
      await api.discard();
      location.href = "/";
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not discard.");
      setBusy(null);
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-ink px-4 text-white">
      <button className="md:hidden" onClick={onMenu} aria-label="Menu">☰</button>
      <button onClick={() => nav("")} className="whitespace-nowrap text-xs font-semibold tracking-[0.2em] sm:text-sm sm:tracking-[0.3em]">ENHANC MEDIA</button>
      <span className="hidden text-xs text-mist sm:inline">Admin</span>
      <span className="flex-1" />
      {me.previewUrl && <a href={me.previewUrl} target="_blank" rel="noopener noreferrer" className="hidden text-xs text-mist hover:text-white sm:inline">Preview ↗</a>}
      <a href={me.siteUrl} target="_blank" rel="noopener noreferrer" className="hidden text-xs text-mist hover:text-white sm:inline">Live site ↗</a>
      {changes > 0 && (
        <span className="text-xs text-mist">
          {building ? "Preview building…" : failed ? <a className="text-[#f0b4b4] underline" href={b!.url ?? "#"} target="_blank" rel="noopener noreferrer">Preview failed</a> : unknown ? "Preview status not reported" : "Preview ready"}
        </span>
      )}
      <button className="rounded-md px-2 py-1 text-xs text-mist hover:text-white disabled:opacity-40" disabled={!changes || !!busy} onClick={discard}>
        Discard
      </button>
      <button
        className="rounded-md bg-gold px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!ready || !!busy}
        onClick={publish}
        title={!changes ? "Nothing to publish" : building ? "Publish becomes available when the preview has built" : failed ? "The preview failed to build" : ""}
      >
        {busy === "publish" ? "Publishing…" : `Publish${changes ? ` (${changes})` : ""}`}
      </button>
      <span className="hidden max-w-[12rem] truncate text-xs text-mist lg:inline" title={me.email}>{me.email}</span>
      <button className="text-xs text-mist hover:text-white" onClick={async () => { await api.logout().catch(() => null); location.href = "/"; }}>
        Sign out
      </button>
    </header>
  );
}

function Overview({ schemas, state, me, nav }: { schemas: Schema[]; state: State | null; me: Me; nav: (s: string, i?: string) => void }) {
  const byFile = (p: string) => {
    const s = schemas.find((x) => x.file === p) ?? schemas.find((x) => x.folder && p.startsWith(x.folder + "/"));
    return s;
  };
  const changes = state?.changes ?? [];
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Website content</h1>
      <p className="mt-2 text-sm text-muted">
        Every text, image, menu and setting on <a className="underline" href={me.siteUrl} target="_blank" rel="noopener noreferrer">{me.siteUrl.replace(/^https:\/\//, "")}</a> is
        edited here. Saving puts a change on the private preview; <strong>Publish</strong> puts every saved change on the live site at once.
      </p>
      <ol className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
        {[
          ["1 · Edit", "Choose a page or a collection on the left and change it."],
          ["2 · Check", "Saved changes appear on the preview within a minute or two."],
          ["3 · Publish", "When the preview looks right, Publish sends it live."],
        ].map(([t, d]) => (
          <li key={t} className="rounded-lg border border-line bg-white p-4">
            <p className="font-semibold">{t}</p>
            <p className="mt-1 text-muted">{d}</p>
          </li>
        ))}
      </ol>
      <h2 className="mt-10 text-sm font-semibold uppercase tracking-[0.14em] text-muted">Unpublished changes</h2>
      {changes.length === 0 ? (
        <p className="mt-3 text-sm text-muted">None — the live site shows everything that has been saved.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-white">
          {changes.map((c) => {
            const s = byFile(c.path);
            const slug = s?.folder ? c.path.slice(s.folder.length + 1).replace(/\.md$/, "") : undefined;
            return (
              <li key={c.path} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-16 shrink-0 text-xs uppercase text-muted">{c.status}</span>
                {s ? (
                  <button className="flex-1 truncate text-left hover:text-gold-ink" onClick={() => nav(s.id, c.status === "removed" ? undefined : slug)}>
                    {s.label}{slug ? ` — ${slug}` : ""}
                  </button>
                ) : (
                  <span className="flex-1 truncate font-mono text-xs">{c.path}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-6">{children}</div>;
}
