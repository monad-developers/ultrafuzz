import { resolve } from "node:path";
import { createEngine } from "./engine";
import { loadConfig } from "./config";
import { listProfiles } from "./profiles";
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

export async function serveDashboard(home: string, port = 3000): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Dashboard port must be between 1 and 65535.");
  const engine = await createEngine(home);
  // Avoid overlapping collectors when multiple browser tabs poll at once.
  let refresh: Promise<RunRecord[]> | undefined;
  const runs = () => refresh ??= (async () => {
    const records = await engine.list();
    const updates = await Promise.allSettled(records.map(async record =>
      record.state !== "finished" || record.publication.state !== "published" ? await engine.status(record.id) : record));
    return updates.map((result, index) => result.status === "fulfilled" ? result.value : records[index]!);
  })().finally(() => { refresh = undefined; });

  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 120,
    async fetch(request) {
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
      try {
        if (url.pathname === "/api/bootstrap" && request.method === "GET") {
          const config = await loadConfig(home);
          return json({ defaults: config.defaults, repositories: config.repositories, profiles: await listProfiles() });
        }
        if (url.pathname === "/api/runs" && request.method === "GET") return json({ runs: await runs() });
        if (url.pathname === "/api/runs" && request.method === "POST") {
          const body = await request.json() as LaunchOptions;
          return json({ run: await engine.launch(body) }, 201);
        }
        const route = /^\/api\/runs\/([a-zA-Z0-9_-]+)(\/cancel)?$/.exec(url.pathname);
        if (route && request.method === "GET" && !route[2]) return json({ run: await engine.status(route[1]!) });
        if (route && request.method === "POST" && route[2]) return json({ run: await engine.cancel(route[1]!) });
        if (request.method === "GET" && assets[url.pathname]) {
          const file = Bun.file(resolve(webRoot, assets[url.pathname]!));
          if (await file.exists()) return new Response(file, { headers });
        }
        return json({ error: "Not found." }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  });
  process.stderr.write(`Ultrafuzz dashboard: http://127.0.0.1:${server.port}\n`);
  const stop = () => server.stop(true);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
