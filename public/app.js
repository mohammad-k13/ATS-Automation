// ATS dashboard - vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const fmtDate = (s) => (s ? new Date(s).toLocaleString() : "-");

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

let status = null;
const timers = new Set();
function clearTimers() { timers.forEach(clearInterval); timers.clear(); }

// ---------- shell ----------
async function loadStatus() {
  status = await api("/api/status");
  const ai = status.ai;
  $("#ai-badge").className = "badge" + (ai.provider === "keyword" ? " warn" : "");
  $("#ai-badge").textContent = ai.provider === "keyword" ? "AI: off (keyword scoring)" : `AI: ${ai.provider} · ${ai.model}`;
  renderSidebar();
}

function tokenLabel(t) {
  if (!t.hasToken) return `<span class="badge bad">no token</span>`;
  if (!t.valid) return `<span class="badge bad">token expired</span>`;
  const mins = Math.round((new Date(t.expiresAt) - Date.now()) / 60000);
  return `<span class="badge ${mins < 30 ? "warn" : "ok"}">token ${mins >= 60 ? Math.floor(mins / 60) + "h " : ""}${mins % 60}m left</span>`;
}

function renderSidebar() {
  const cur = location.hash.split("/")[2];
  $("#platforms").innerHTML = status.platforms
    .map((p) => `<a class="plat ${p.name === cur ? "active" : ""}" href="#/p/${p.name}">
        <div class="name">${esc(p.name)}</div>
        <div class="tok">${tokenLabel(p.token)}</div>
      </a>`)
    .join("") || `<div class="muted small pad">No platforms enabled in sources.yaml</div>`;
}

function openTokenDialog(src) {
  const d = $("#token-dialog");
  $("#token-src").textContent = src;
  $("#token-input").value = "";
  $("#token-error").textContent = "";
  d.showModal();
  $("#token-save").onclick = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/platforms/${src}/token`, { method: "POST", body: { token: $("#token-input").value } });
      d.close();
      await loadStatus();
      route();
    } catch (err) {
      $("#token-error").textContent = err.message;
    }
  };
}

// ---------- views ----------
async function viewHome() {
  if (status.platforms.length === 1) return (location.hash = `#/p/${status.platforms[0].name}`);
  $("#view").innerHTML = `<h1>Choose a platform</h1><p class="muted">Pick a platform on the left.</p>`;
}

function jobCard(src, j) {
  const s = j.stats;
  const sync = j.sync;
  const total = s?.total ?? 0;
  const done = (s?.accepted ?? 0) + (s?.rejected ?? 0);
  const crit = !j.criteria
    ? `<span class="badge bad">no requirements</span>`
    : j.criteria.isDefault ? `<span class="badge warn">generic requirements</span>` : `<span class="badge ok">requirements: ${esc(j.criteria.name)}</span>`;
  return `<div class="card" data-job="${j.id}">
    <div class="row between"><a class="title" dir="auto" href="#/p/${src}/job/${j.id}">${esc(j.title)}</a>${crit}</div>
    <div class="muted small" dir="auto">${esc(j.city ?? "")} · ${esc(j.timeDescription ?? "")} · #${j.id}</div>
    ${total ? `
      <div class="bar" title="accepted / rejected / errors">
        <div class="acc" style="width:${pct(s.accepted, total)}%"></div>
        <div class="rej" style="width:${pct(s.rejected, total)}%"></div>
        <div class="err" style="width:${pct(s.errors, total)}%"></div>
      </div>
      <div class="legend">
        <div class="acc"><b>${pct(s.accepted, done || 1)}%</b>accepted (${s.accepted})</div>
        <div class="rej"><b>${pct(s.rejected, done || 1)}%</b>rejected (${s.rejected})</div>
        <div><b>${s.avgScore ?? "-"}</b>avg score</div>
        <div><b>${total}</b>scored</div>
      </div>
      ${s.errors ? `<div class="small" style="color:var(--warn)">${s.errors} could not be scored</div>` : ""}
      <div class="muted small">Last scored: ${fmtDate(s.lastProcessed)}</div>`
    : `<div class="muted">Not scored yet. Press <b>Score resumes</b>.</div>`}
    <div class="progress" id="prog-${j.id}">${sync?.running ? `Scoring… ${sync.done}/${sync.total || "?"}` : sync?.error ? `<span class="error">${esc(sync.error)}</span>` : ""}</div>
    <div class="row">
      <button class="primary" data-act="sync" ${sync?.running ? "disabled" : ""}>Score resumes</button>
      ${total ? `<button data-act="rescore" ${sync?.running ? "disabled" : ""}>Re-score all</button>` : ""}
      <a href="#/p/${src}/job/${j.id}"><button>Open</button></a>
    </div>
  </div>`;
}

async function viewPlatform(src) {
  const p = status.platforms.find((x) => x.name === src);
  if (!p) return ($("#view").innerHTML = `<div class="notice bad">Unknown platform ${esc(src)}</div>`);
  $("#view").innerHTML = `<div class="row between">
      <div><h1>${esc(src)} jobs</h1><div class="muted">Active job posts and how their resumes scored.</div></div>
      <button id="tok-btn">Update token</button>
    </div>
    <div id="jobs"><div class="muted pad">Loading jobs from ${esc(src)}…</div></div>`;
  $("#tok-btn").onclick = () => openTokenDialog(src);
  if (!p.token.valid) {
    $("#jobs").innerHTML = `<div class="notice bad">The ${esc(src)} token is ${p.token.hasToken ? "expired" : "missing"}. Click <b>Update token</b>.</div>`;
    return;
  }
  let jobs;
  try {
    jobs = await api(`/api/platforms/${src}/jobs`);
  } catch (e) {
    $("#jobs").innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    return;
  }
  if (!jobs.length) return ($("#jobs").innerHTML = `<div class="muted pad">No active job posts.</div>`);
  $("#jobs").innerHTML = `<div class="cards">${jobs.map((j) => jobCard(src, j)).join("")}</div>`;
  $("#jobs").onclick = async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest(".card").dataset.job;
    const rescore = btn.dataset.act === "rescore";
    if (rescore && !confirm("Delete the existing scores for this job and score every resume again?")) return;
    btn.disabled = true;
    try {
      await api(`/api/platforms/${src}/jobs/${id}/sync`, { method: "POST", body: { rescore } });
      watchSync(src, id, () => viewPlatform(src));
    } catch (err) {
      $(`#prog-${id}`).innerHTML = `<span class="error">${esc(err.message)}</span>`;
      btn.disabled = false;
    }
  };
  jobs.filter((j) => j.sync?.running).forEach((j) => watchSync(src, j.id, () => viewPlatform(src)));
}

function watchSync(src, id, onDone) {
  const t = setInterval(async () => {
    const s = await api(`/api/platforms/${src}/jobs/${id}/sync`).catch(() => null);
    const el = $(`#prog-${id}`);
    if (!s) return;
    if (el) el.textContent = s.running ? `Scoring… ${s.done}/${s.total || "?"}  ${s.log.at(-1) ?? ""}` : "";
    if (!s.running) {
      clearInterval(t);
      timers.delete(t);
      onDone?.();
    }
  }, 1500);
  timers.add(t);
}

const DECISION = { accepted: ["ok", "Accepted"], rejected: ["bad", "Rejected"], error: ["warn", "Error"] };

async function viewJob(src, id) {
  $("#view").innerHTML = `<a href="#/p/${src}">← All jobs</a><div id="job"><div class="muted pad">Loading…</div></div>`;
  const apps = await api(`/api/platforms/${src}/jobs/${id}/applications`);
  const title = apps[0]?.job ?? `Job #${id}`;
  const c = { accepted: 0, rejected: 0, error: 0 };
  apps.forEach((a) => c[a.decision]++);
  let filter = "all";
  const render = () => {
    const list = apps.filter((a) => filter === "all" || a.decision === filter);
    $("#job").innerHTML = `
      <h1 dir="auto" style="margin-top:12px">${esc(title)}</h1>
      <div class="muted">${apps.length} scored · ${pct(c.accepted, apps.length)}% accepted · ${pct(c.rejected, apps.length)}% rejected</div>
      <div class="filters">
        ${["all", "accepted", "rejected", "error"].map((f) => `<button data-f="${f}" class="${f === filter ? "on" : ""}">${f} (${f === "all" ? apps.length : c[f]})</button>`).join("")}
      </div>
      ${list.length ? `<table>
        <thead><tr><th>Score</th><th>Candidate</th><th>Decision</th><th>Summary</th></tr></thead>
        <tbody>${list.map((a) => {
          const [cls, label] = DECISION[a.decision] ?? ["", a.decision];
          return `<tr>
            <td class="score">${a.score ?? "-"}</td>
            <td dir="auto"><b>${esc(a.name)}</b><div class="muted small">${esc(a.extra?.lastJob ?? "")}</div>
              ${a.profileUrl ? `<a class="small" href="${esc(a.profileUrl)}" target="_blank" rel="noopener">Open on ${esc(src)} ↗</a>` : ""}</td>
            <td><span class="badge ${cls}">${label}</span></td>
            <td class="summary" dir="auto">${esc(a.result?.summary ?? a.error ?? "")}</td>
          </tr>`;
        }).join("")}</tbody></table>` : `<div class="muted pad">Nothing here yet. Go back and press <b>Score resumes</b>.</div>`}`;
    $("#job").querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { filter = b.dataset.f; render(); }));
  };
  render();
}

// ---------- router ----------
async function route() {
  clearTimers();
  if (!status) await loadStatus();
  renderSidebar();
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (parts[0] === "p" && parts[2] === "job") return await viewJob(parts[1], parts[3]);
    if (parts[0] === "p" && parts[1]) return await viewPlatform(parts[1]);
    return await viewHome();
  } catch (e) {
    $("#view").innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
setInterval(() => loadStatus().catch(() => {}), 60_000); // refresh token countdown
route();
