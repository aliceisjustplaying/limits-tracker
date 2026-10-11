export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>limits</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --track: #e5e5ea; --ok: #34a853; --warn: #f2a900; --bad: #d93025; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f2f2f7; --muted: #98989d; --track: #3a3a3c; } }
  body { font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; color: var(--fg); max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; } h1 small { color: var(--muted); font-weight: normal; }
  section { padding: .75rem 0; border-top: 1px solid var(--track); }
  .head { display: flex; justify-content: space-between; gap: 1rem; }
  .name { font-weight: 600; } .meta, .proj { color: var(--muted); font-size: 12px; }
  .row { display: grid; grid-template-columns: 6rem 1fr 3.5rem; gap: .5rem; align-items: center; margin-top: .35rem; }
  .bar { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--ok); }
  .bar i.warn { background: var(--warn); } .bar i.bad { background: var(--bad); }
  .pct { text-align: right; font-variant-numeric: tabular-nums; }
  .err { color: var(--bad); font-size: 12px; }
  .low { color: var(--warn); font-weight: 600; } .out { color: var(--bad); font-weight: 600; }
  .link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
  .pill { display: inline-block; font-size: 11px; color: var(--muted); border: 1px solid var(--track); border-radius: 999px; padding: 0 .5rem; margin-right: .4rem; }
</style>
</head>
<body>
<h1>limits <small id="stamp"></small></h1>
<main id="root">Loading…</main>
<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const until = (t) => {
  if (t == null) return "";
  const m = Math.round((t - Date.now()) / 60000);
  if (m <= 0) return "now";
  return m < 60 ? m + "m" : m < 2880 ? Math.floor(m / 60) + "h" + (m % 60) + "m" : Math.round(m / 1440) + "d";
};
const money = (n) => (n < -0.005 ? "-$" : "$") + Math.abs(n).toFixed(2);
function windowRow(w) {
  const pct = w.usedPercent == null ? null : Math.max(0, Math.min(100, w.usedPercent));
  const p = w.projection;
  const tone = pct >= 90 || (p && p.hitsLimitAt) ? "bad" : pct >= 70 || (p && p.projectedAtReset >= 90) ? "warn" : "";
  const notes = [];
  if (w.resetsAt) notes.push("resets in " + until(w.resetsAt));
  if (p && p.hitsLimitAt) notes.push("hits 100% in " + until(p.hitsLimitAt));
  else if (p && p.projectedAtReset != null) notes.push("~" + Math.round(p.projectedAtReset) + "% at reset");
  return '<div class="row"><span>' + esc(w.window) + '</span><div class="bar"><i class="' + tone + '" style="width:' + (pct ?? 0) + '%"></i></div><span class="pct">' + (pct == null ? "?" : Math.round(pct) + "%") + "</span></div>" +
    (notes.length ? '<div class="proj" style="margin-left:6.5rem">' + esc(notes.join(" · ")) + "</div>" : "");
}
function burnText(b, unit) {
  if (!b) return "";
  return " · " + unit(b.perDay) + "/day" + (b.daysLeft != null ? " · ~" + b.daysLeft.toFixed(1) + " days left" : "");
}
function account(a) {
  const lines = a.windows.map(windowRow);
  if (a.balanceUsd) {
    const days = a.balanceUsd.burn ? a.balanceUsd.burn.daysLeft : null;
    const tone = a.balanceUsd.balance <= 0 || (days != null && days <= 2) ? "out" : days != null && days <= 7 ? "low" : "";
    lines.push('<div class="meta"><span class="' + tone + '">' + money(a.balanceUsd.balance) + " left</span>" + burnText(a.balanceUsd.burn, money) +
      (a.balanceSettable ? ' · <button class="link" onclick="setBalance(\\'' + esc(a.id) + '\\')">edit</button>' : "") + "</div>");
  } else if (a.balanceSettable) {
    lines.push('<div class="meta"><button class="link" onclick="setBalance(\\'' + esc(a.id) + '\\')">set balance</button></div>');
  }
  if (a.billing) {
    const b = a.billing;
    const plan = b.plan ? esc(b.plan.name) + (b.plan.renewsAt ? (b.plan.canceledAt ? " · ends " : " · renews ") + new Date(b.plan.renewsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "") + " · " : "";
    lines.push('<div class="meta">' + plan + "used " + money(b.usedUsd) + " of " + money(b.grantedUsd) +
      b.sources.map((s) => " · " + esc(s.name) + " " + money(s.remainingUsd) + "/" + money(s.grantedUsd)).join("") + "</div>");
  }
  if (a.spendUsd) {
    const p = a.spendUsd.projection.credits;
    lines.push('<div class="meta">Credits spent ' + money(a.spendUsd.credits) + " this month" + (p ? " · " + money(p.perDay) + "/day · ~" + money(p.projectedAtEnd) + " by month end" : "") + " · " + money(a.spendUsd.total) + " incl. subscriptions</div>");
  }
  if (a.credits) lines.push('<div class="meta">Credits ' + (a.credits.unlimited ? "unlimited" : Math.floor(a.credits.balance).toLocaleString() + burnText(a.credits.burn, (n) => Math.round(n).toLocaleString())) + "</div>");
  const err = a.status === "error" ? '<div class="err">' + esc(a.error) + "</div>"
    : a.status === "inactive" ? '<div class="meta"><span class="pill">inactive</span></div>'
    : a.notice ? '<div class="meta">' + esc(a.notice) + "</div>" : "";
  const connect = a.provider === "opencode" && a.error === "device login needed"
    ? '<div class="meta" id="login-' + esc(a.id) + '"><button onclick="connect(\\'' + esc(a.id.slice(9)) + '\\', this.parentNode)">Connect OpenCode</button></div>' : "";
  const seen = a.observedAt ? "updated " + new Date(a.observedAt).toLocaleTimeString() : a.status;
  return '<section><div class="head"><span class="name">' + esc(a.label) + (a.plan ? ' <span class="pill">' + esc(a.plan.name) + (a.plan.status === "active" ? "" : " " + esc(a.plan.status)) + "</span>" : "") + (a.email ? ' <span class="meta">' + esc(a.email) + "</span>" : "") + '</span><span class="meta">' + esc(a.provider) + " · " + esc(seen) + "</span></div>" + err + connect + lines.join("") + "</section>";
}
async function setBalance(id) {
  const raw = prompt("Credit balance in dollars, as shown on Settings > Billing right now:");
  if (raw == null) return;
  const balanceUsd = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(balanceUsd) || balanceUsd < 0) return alert("Not a dollar amount");
  const res = await fetch("api/accounts/" + encodeURIComponent(id) + "/balance", {
    method: "POST",
    headers: { "X-Limits-Action": "balance", "Content-Type": "application/json" },
    body: JSON.stringify({ balanceUsd }),
  });
  if (!res.ok) return alert((await res.json().catch(() => ({}))).error || "Failed");
  load();
}
async function connect(id, el) {
  const res = await fetch("api/opencode/" + id + "/login", { method: "POST", headers: { "X-Limits-Action": "login" } });
  const start = await res.json();
  if (!res.ok) { el.textContent = start.error; return; }
  el.innerHTML = 'Approve code <b>' + esc(start.userCode) + '</b> at <a target="_blank" rel="noopener" href="' + esc(start.verificationUrl) + '">opencode.ai</a>';
  const timer = setInterval(async () => {
    const state = await (await fetch("api/opencode/" + id + "/login")).json();
    if (state.status === "done") { clearInterval(timer); el.textContent = "Connected; data arrives with the next poll."; }
    if (state.status === "error") { clearInterval(timer); el.textContent = "Login failed: " + state.error; }
  }, 3000);
}
async function load() {
  if (document.querySelector('[id^="login-"] a')) return;
  try {
    const s = await (await fetch("api/summary")).json();
    const errors = s.errors.map((e) => '<div class="err">' + esc(e.providers.join(", ") + ": " + e.message) + "</div>").join("");
    document.getElementById("root").innerHTML = errors + (s.accounts.length ? s.accounts.map(account).join("") : "No accounts configured.");
    document.getElementById("stamp").textContent = new Date(s.generatedAt).toLocaleTimeString();
  } catch (e) {
    document.getElementById("stamp").textContent = "offline";
  }
}
load();
setInterval(load, 60000);
</script>
</body>
</html>
`;
