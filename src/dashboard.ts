import { join, resolve } from "node:path";
import { WATCH_ATTEMPTS, createEngine, failure, settled, type Publisher } from "./engine";
import { loadConfig } from "./config";
import type { ExecutorSource } from "./executor";
import { listProfiles } from "./profiles";
import { validateRunId } from "./store";
import type { LaunchOptions, RunRecord } from "./types";

const webRoot = resolve(import.meta.dir, "../web");
const assets: Record<string, string> = {
  "/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/ultrafuzz-logo.svg": "ultrafuzz-logo.svg",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
/** The pause before the second automatic attempt of a failed collection or publication, in milliseconds. Each later pause is twice as long, as in `watch`. */
const RETRY = 2 * 60_000;

/** A run in the list of the page. `refresh_error` says why its last status check failed. It is in the response only, never in the record. */
type Listed = RunRecord & { refresh_error?: string };

/**
 * Returns a function that stops the server. `executors` and `publisher` replace the real ones in tests.
 * `patience` is the longest time in milliseconds that the run list waits for a refresh before it answers with the stored records.
 */
export async function serveDashboard(home: string, port = 3000, executors?: ExecutorSource, publisher?: Publisher, patience = 2000): Promise<() => void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Dashboard port must be between 1 and 65535.");
  const engine = await createEngine(home, executors, publisher);
  // Avoid overlapping collectors when multiple browser tabs poll at once.
  let refresh: Promise<Listed[]> | undefined;
  // The runs whose last status check failed. One line on standard error for each row of failures, as in `watch`.
  const unchecked = new Set<string>();
  // The list is refreshed every few seconds. A collection or a publication that failed is not tried again at each
  // refresh: the attempts move apart (2, 4, 8 and 16 minutes) and end after five failures in a row, as in `watch`.
  // The counts live in this process. `collect`, `status` and the page of one run still try at once.
  const failing = new Map<string, { step: string; failures: number; retryAt: number }>();
  const step = (record: RunRecord) => `${record.collection.state}/${record.publication.state}`;
  const refreshed = async (record: RunRecord): Promise<RunRecord> => {
    if (settled(record)) { failing.delete(record.id); return record; }
    const held = failing.get(record.id);
    // Another command changed the run: the count starts again.
    if (held && (record.state !== "finished" || step(record) !== held.step)) failing.delete(record.id);
    else if (held && (held.failures >= WATCH_ATTEMPTS || Date.now() < held.retryAt)) return record;
    const next = await engine.status(record.id);
    if (next.state !== "finished" || settled(next)) failing.delete(record.id);
    else {
      // The run ended and something is left: the collection or the publication failed in this call.
      const failures = (failing.get(record.id)?.step === step(next) ? failing.get(record.id)!.failures : 0) + 1;
      failing.set(record.id, { step: step(next), failures, retryAt: Date.now() + RETRY * 2 ** (failures - 1) });
    }
    return next;
  };
  const runs = () => refresh ??= (async () => {
    const records = await engine.list();
    const updates: Listed[] = [];
    for (let index = 0; index < records.length; index += 4) {
      const batch = records.slice(index, index + 4);
      const observed = await Promise.allSettled(batch.map(refreshed));
      updates.push(...observed.map((result, offset): Listed => {
        const stale = batch[offset]!;
        if (result.status === "fulfilled") { unchecked.delete(stale.id); return result.value; }
        // The stored record is shown. A busy lock is normal while another command collects the run, so it is no failure.
        if ((result.reason as NodeJS.ErrnoException)?.code === "ELOCKED") return stale;
        const text = failure(stale.id, result.reason);
        if (!unchecked.has(stale.id)) { unchecked.add(stale.id); process.stderr.write(`${text} The dashboard shows the stored record and tries again at each refresh.\n`); }
        return { ...stale, refresh_error: text };
      }));
    }
    return updates;
  })().finally(() => { refresh = undefined; });

  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 120,
    async fetch(request, server) {
      const url = new URL(request.url);
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(request.headers.get("host") ?? "")) return json({ error: "Loopback host required." }, 403);
      if (request.method !== "GET") {
        const origin = request.headers.get("origin");
        if (request.method !== "POST" || request.headers.get("x-ultrafuzz-client") !== "dashboard"
          || (origin && origin !== url.origin) || !request.headers.get("content-type")?.startsWith("application/json")) {
          return json({ error: "Same-origin dashboard request required." }, 403);
        }
      }
      // Image builds, collection and publication can outlast an HTTP idle timeout.
      if (url.pathname.startsWith("/api/")) server.timeout(request, 0);
      try {
        if (url.pathname === "/api/bootstrap" && request.method === "GET") {
          const config = await loadConfig(home);
          return json({ defaults: config.defaults, repositories: config.repositories, profiles: await listProfiles() });
        }
        if (url.pathname === "/api/runs" && request.method === "GET") {
          // A refresh collects and publishes, and that can take minutes. The page must not wait for it: after a short
          // time the answer is the stored records, and the one shared refresh continues.
          const fresh = runs();
          fresh.catch(() => undefined); // The collector timer reports a failed refresh.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stored = new Promise<Listed[]>((resolve, reject) => { timer = setTimeout(() => engine.list().then(resolve, reject), patience); });
          return json({ runs: await Promise.race([fresh, stored]).finally(() => clearTimeout(timer)) });
        }
        if (url.pathname === "/api/runs" && request.method === "POST") {
          const body = await request.json() as LaunchOptions;
          // The form reloads config on page load, so launches must use that config too.
          const current = await createEngine(home, executors, publisher);
          return json({ run: await current.launch(body) }, 201);
        }
        const route = /^\/api\/runs\/([a-zA-Z0-9_-]+)(\/cancel|\/report)?$/.exec(url.pathname);
        if (route && request.method === "GET" && !route[2]) return json({ run: await engine.status(route[1]!) });
        if (route && request.method === "POST" && route[2] === "/cancel") return json({ run: await engine.cancel(route[1]!) });
        if (route && request.method === "GET" && route[2] === "/report") {
          // The path is rebuilt from the validated run ID, never taken from a stored record.
          validateRunId(route[1]!);
          const report = Bun.file(join(resolve(home), "runs", route[1]!, "artifacts/raw/report.md"));
          if (await report.exists()) return new Response(report, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
          return json({ error: "This run has no collected report." }, 404);
        }
        if (request.method === "GET" && assets[url.pathname]) {
          const file = Bun.file(resolve(webRoot, assets[url.pathname]!));
          if (await file.exists()) return new Response(file, { headers });
        }
        return json({ error: "Not found." }, 404);
      } catch (error) {
        // A run that the registry does not have is "not found", not a bad request.
        const unknown = url.pathname.startsWith("/api/runs/") && (error as NodeJS.ErrnoException)?.code === "ENOENT";
        return json({ error: error instanceof Error ? error.message : String(error) }, unknown ? 404 : 400);
      }
    },
  });
  const collector = setInterval(() => {
    void runs().catch(() => process.stderr.write("Ultrafuzz dashboard could not refresh the run registry.\n"));
  }, 5000);
  process.stderr.write(`Ultrafuzz dashboard: http://127.0.0.1:${server.port}\n`);
  const stop = () => { clearInterval(collector); process.off("SIGINT", stop); process.off("SIGTERM", stop); void server.stop(true); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return stop;
}
