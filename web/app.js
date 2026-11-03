"use strict";
const $ = id => document.getElementById(id);
let profiles = [], records = [], launching = false, pollInFlight = false;
const harnessNames = { "claude-code": "Claude Code", opencode: "OpenCode", codex: "Codex" };
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function notice(message, error = false) {
  $("notice").textContent = message; $("notice").className = error ? "error" : ""; $("notice").hidden = !message;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Ultrafuzz-Client": "dashboard" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function fill(select, values, preferred) {
  select.replaceChildren();
  for (const value of values) {
    const option = node("option", value.label); option.value = value.value; option.disabled = !!value.disabled; select.append(option);
  }
  const match = values.find(value => value.value === preferred && !value.disabled) || values.find(value => !value.disabled);
  select.value = match?.value || "";
}
function updateProfile() {
  const profile = profiles.find(item => item.name === $("profile").value);
  $("profile-description").textContent = profile?.description || "No available profile supports this harness.";
  $("properties-field").hidden = !profile?.requires_properties;
  $("properties").required = !!profile?.requires_properties;
  $("launch").disabled = launching || !profile?.available || !$("repository").value;
}
function updateHarness(preferred) {
  const previous = preferred || $("profile").value;
  fill($("profile"), profiles.filter(profile => profile.harnesses.includes($("harness").value)).map(profile => ({ value: profile.name, label: `${profile.name}${profile.available ? "" : " · TBD"}`, disabled: !profile.available })), previous);
  updateProfile();
}
function repositoryName(url) {
  try { return new URL(url).pathname.replace(/^\//, "").replace(/\.git$/, ""); } catch { return url; }
}
function age(date) {
  const seconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function renderRuns() {
  const query = $("search").value.toLowerCase();
  const filter = $("state-filter").value;
  const visible = records.filter(run => `${run.label} ${run.id} ${run.source.repository}`.toLowerCase().includes(query)
    && (filter === "all" || (filter === "finished" ? run.state === "finished" : run.state !== "finished")));
  $("run-count").textContent = `${visible.length} ${visible.length === 1 ? "run" : "runs"}${visible.length !== records.length ? ` of ${records.length}` : ""}`;
  $("empty").hidden = visible.length > 0;
  $("empty").querySelector("h2").textContent = records.length ? "No matching runs" : "No runs yet";
  $("empty").querySelector("p").textContent = records.length ? "Try a different search or state filter." : "Choose a repository and profile to start your first audit.";
  $("runs").replaceChildren();
  for (const run of visible) {
    const row = node("tr"), identity = node("td"), configuration = node("td"), state = node("td"), cost = node("td"), actionCell = node("td");
    identity.append(node("div", run.label, "run-label"), node("div", repositoryName(run.source.repository), "run-secondary"), node("div", run.id, "run-id"));
    configuration.append(node("div", run.profile.name, "config-primary"), node("div", `${harnessNames[run.harness.name] || run.harness.name} · ${run.harness.model}`, "config-secondary"));
    configuration.title = `${run.harness.model}\nCommit ${run.source.commit}`;
    const displayState = run.state === "finished" ? run.status : run.state;
    state.append(node("span", displayState.charAt(0).toUpperCase() + displayState.slice(1), `badge ${displayState}`));
    state.append(node("div", run.state === "finished" ? `${run.end || "finished"} · ${age(run.finished_at || run.created_at)}` : `Started ${age(run.started_at || run.created_at)}`, "end-label"));
    if (run.error) state.title = run.error;
    cost.className = "align-right cost"; cost.textContent = run.usage.cost_usd == null ? "—" : `$${run.usage.cost_usd.toFixed(2)}`;
    cost.title = run.usage.cost_provenance || "Cost unavailable";
    const actions = node("div", undefined, "actions");
    if (run.publication.pr_url) {
      try {
        const url = new URL(run.publication.pr_url);
        if (url.protocol === "https:") { const link = node("a", "Results ↗", "result-link"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link); }
      } catch { /* A malformed URL must not become a clickable action. */ }
    } else if (run.state === "finished") {
      const publication = node("span", run.publication.state === "failed" ? "Publish retry pending" : "Publishing…", "end-label");
      publication.title = run.publication.error || "Results publication is retried during collection."; actions.append(publication);
    }
    if (run.state !== "finished") {
      const button = node("button", "Cancel", "cancel"); button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true; button.textContent = "Cancelling…";
        try { await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: "{}" }); notice(`Cancellation requested for ${run.label}.`); await poll(); }
        catch (error) { notice(error.message, true); button.disabled = false; button.textContent = "Cancel"; }
      }); actions.append(button);
    }
    actionCell.append(actions); row.append(identity, configuration, state, cost, actionCell); $("runs").append(row);
  }
}
async function poll() {
  if (pollInFlight) return;
  pollInFlight = true; $("refresh").disabled = true;
  try {
    const result = await api("/api/runs"); records = result.runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    renderRuns(); $("updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) { notice(`Could not refresh runs: ${error.message}`, true); }
  finally { pollInFlight = false; $("refresh").disabled = false; }
}
$("launch-form").addEventListener("submit", async event => {
  event.preventDefault(); launching = true; updateProfile(); $("launch").textContent = "Launching…";
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (!body.effort) delete body.effort;
    if (!profiles.find(profile => profile.name === body.audit_profile)?.requires_properties) delete body.properties;
    const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify(body) });
    notice(`Run launched: ${run.id}. It continues when this page is closed.`); await poll();
  } catch (error) { notice(error.message, true); }
  finally { launching = false; $("launch").textContent = "Launch run ↗"; updateProfile(); }
});
$("harness").addEventListener("change", () => updateHarness());
$("profile").addEventListener("change", updateProfile);
$("repository").addEventListener("change", updateProfile);
$("search").addEventListener("input", renderRuns);
$("state-filter").addEventListener("change", renderRuns);
$("refresh").addEventListener("click", poll);
(async () => {
  try {
    const data = await api("/api/bootstrap"); profiles = data.profiles;
    fill($("repository"), Object.entries(data.repositories).map(([name, config]) => ({ value: name, label: name, url: config.url })));
    $("harness").value = data.defaults.harness; $("model").value = data.defaults.model; $("effort").value = data.defaults.effort || "";
    updateHarness(data.defaults.audit_profile);
    if (!Object.keys(data.repositories).length) notice("Add a repository to your local config before launching a run.");
    await poll(); setInterval(poll, 5000);
  } catch (error) { notice(`Could not load configuration: ${error.message}`, true); }
})();
