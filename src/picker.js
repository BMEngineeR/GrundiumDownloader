import http from "node:http";
import { spawn } from "node:child_process";
import { info } from "./log.js";

/**
 * Interactive picker: serves one HTML page on localhost, opens it in the default browser,
 * and resolves with what the user chose: { uuids: string[], download: boolean } or null
 * when cancelled. No dependencies, nothing leaves the machine.
 */
export function pickScans(rows, { title = "GrundiumGrab", openBrowser = true, port = 0, onReady } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; setTimeout(() => server.close(), 300); resolve(val); };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE.replaceAll("__TITLE__", title));
      }
      if (req.method === "GET" && url.pathname === "/api/rows") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(rows.map((r) => ({
          uuid: r.uuid, name: r.name, status: r.status, date: r.date, time: r.time, user: r.user,
          size_bytes: r.size_bytes || 0, selected: !!r.selected, timestamp: r.timestamp || 0,
        }))));
      }
      if (req.method === "POST" && (url.pathname === "/api/submit" || url.pathname === "/api/cancel")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
          if (url.pathname === "/api/cancel") return finish(null);
          try { const j = JSON.parse(body || "{}"); finish({ uuids: Array.isArray(j.uuids) ? j.uuids : [], download: !!j.download }); }
          catch (e) { finish({ uuids: [], download: false }); }
        });
        return;
      }
      res.writeHead(url.pathname === "/favicon.ico" ? 204 : 404); res.end();
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = `http://127.0.0.1:${server.address().port}/`;
      info("picker open in your browser; choose scans and press Start", { url: addr });
      onReady?.(addr);
      if (openBrowser) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", addr] : [addr];
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      }
    });
    // Do not keep the process alive forever if the tab is closed without answering.
    const idle = setTimeout(() => finish(null), 30 * 60 * 1000);
    idle.unref();
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ picker</title>
<style>
  :root { --bg:#fafafa; --fg:#222; --muted:#777; --line:#e3e3e3; --head:#f0f0f0; --acc:#2980b9; --acc-fg:#fff; --sel:#eaf3fb; --chip:#e8e8e8;
          --s-not:#8a6d3b; --s-dl:#2e7d32; --s-done:#555; --s-exp:#1565c0; --s-fail:#c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1b1b1d; --fg:#e4e4e4; --muted:#9a9a9a; --line:#333; --head:#242428; --acc:#3d8fc9; --sel:#1d2f3d; --chip:#2e2e33;
          --s-not:#d2a75c; --s-dl:#7bc67e; --s-done:#aaa; --s-exp:#7fb2e6; --s-fail:#ef7b7b; } }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:14px 20px; display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; z-index:2 }
  header h1 { font-size:1.15em; margin:0 12px 0 0 } input[type=search] { flex:1 1 220px; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font-size:14px }
  .chips { display:flex; gap:6px; flex-wrap:wrap } .chip { padding:4px 10px; border-radius:14px; background:var(--chip); cursor:pointer; font-size:13px; user-select:none } .chip.on { background:var(--acc); color:var(--acc-fg) }
  main { padding: 0 20px 120px } table { width:100%; border-collapse:collapse; font-size:14px } th, td { padding:6px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap }
  th { position:sticky; top:66px; background:var(--head); cursor:pointer; user-select:none } td.name { white-space:normal; max-width:520px } tr.sel { background:var(--sel) } tr:hover { background:var(--sel) }
  td.num, th.num { text-align:right } .st { font-size:12px; font-weight:600 } .st.not_exported { color:var(--s-not) } .st.downloadable { color:var(--s-dl) } .st.downloaded { color:var(--s-done) } .st.exporting { color:var(--s-exp) } .st.failed, .st.not_exportable { color:var(--s-fail) } .st.gone { color:var(--muted) }
  footer { position:fixed; bottom:0; left:0; right:0; background:var(--bg); border-top:1px solid var(--line); padding:12px 20px; display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center }
  button { padding:9px 16px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); font-size:14px; cursor:pointer } button.primary { background:var(--acc); color:var(--acc-fg); border-color:var(--acc) } button:disabled { opacity:.5; cursor:default }
  .muted { color:var(--muted) } label.opt { display:flex; gap:6px; align-items:center } .done { padding:60px 20px; text-align:center; font-size:1.2em }
  @media (max-width:700px){ th:nth-child(6),td:nth-child(6){display:none} main{padding:0 8px 140px} }
</style></head><body>
<header><h1>__TITLE__</h1><input id="q" type="search" placeholder="Search name or user…"><div class="chips" id="chips"></div></header>
<main><table><thead><tr><th style="width:32px"><input type="checkbox" id="all" title="select visible"></th><th data-k="status">Status</th><th data-k="timestamp">Scanned</th><th data-k="size_bytes" class="num">Size</th><th data-k="name">Name</th><th data-k="user">User</th></tr></thead><tbody id="tb"></tbody></table></main>
<footer><span id="count" class="muted">0 selected</span><label class="opt"><input type="checkbox" id="dl"> Also download when the export is done</label><span style="flex:1"></span><button id="cancel">Cancel</button><button id="go" class="primary" disabled>Start export</button></footer>
<script>
const fmt = b => b >= 1e9 ? (b/1e9).toFixed(2)+' GB' : (b/1e6).toFixed(0)+' MB';
const STATUSES = ['not_exported','downloadable','failed','exporting','downloaded','not_exportable','gone'];
let rows = [], sel = new Set(), q = '', on = new Set(['not_exported','downloadable','failed']), sortK = 'timestamp', sortD = -1;
const $ = s => document.querySelector(s);
fetch('/api/rows').then(r => r.json()).then(d => { rows = d; d.forEach(r => r.selected && sel.add(r.uuid)); if (!visible().length) on = new Set(STATUSES); chips(); render(); });
function chips(){ $('#chips').innerHTML = STATUSES.map(s => { const n = rows.filter(r => r.status===s).length; return n ? '<span class="chip '+(on.has(s)?'on':'')+'" data-s="'+s+'">'+s+' '+n+'</span>' : ''; }).join('');
  $('#chips').onclick = e => { const s = e.target.dataset.s; if(!s) return; on.has(s) ? on.delete(s) : on.add(s); chips(); render(); }; }
function visible(){ const t = q.toLowerCase(); return rows.filter(r => on.has(r.status) && (!t || (r.name||'').toLowerCase().includes(t) || (r.user||'').toLowerCase().includes(t)))
  .sort((a,b) => { const x=a[sortK]??'', y=b[sortK]??''; return (x<y?-1:x>y?1:0)*sortD; }); }
function render(){ const v = visible(); $('#tb').innerHTML = v.map(r => '<tr data-u="'+r.uuid+'" class="'+(sel.has(r.uuid)?'sel':'')+'"><td><input type="checkbox" '+(sel.has(r.uuid)?'checked':'')+' '+(r.status==='downloaded'||r.status==='not_exportable'?'disabled':'')+'></td><td><span class="st '+r.status+'">'+r.status+'</span></td><td>'+r.date+' '+r.time+'</td><td class="num">'+fmt(r.size_bytes)+'</td><td class="name">'+esc(r.name)+'</td><td class="muted">'+esc(r.user||'')+'</td></tr>').join('');
  $('#all').checked = v.length>0 && v.every(r => sel.has(r.uuid) || r.status==='downloaded'); count(); }
function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function count(){ const chosen = rows.filter(r => sel.has(r.uuid)); const bytes = chosen.reduce((a,r)=>a+r.size_bytes,0); const ex = chosen.filter(r=>r.status==='not_exported').length, dl = chosen.length-ex;
  $('#count').textContent = chosen.length+' selected · '+fmt(bytes)+' on scanner · '+ex+' to export'+(dl?', '+dl+' already exported':''); $('#go').disabled = !chosen.length; $('#go').textContent = 'Start ('+chosen.length+')'; }
$('#tb').onclick = e => { const tr = e.target.closest('tr'); if(!tr) return; const cb = tr.querySelector('input'); if(cb.disabled) return; if(e.target !== cb) cb.checked = !cb.checked; cb.checked ? sel.add(tr.dataset.u) : sel.delete(tr.dataset.u); tr.classList.toggle('sel', cb.checked); count(); };
$('#all').onchange = e => { visible().forEach(r => { if(r.status==='downloaded'||r.status==='not_exportable') return; e.target.checked ? sel.add(r.uuid) : sel.delete(r.uuid); }); render(); };
$('#q').oninput = e => { q = e.target.value; render(); };
document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; sortD = sortK===k ? -sortD : (k==='timestamp'||k==='size_bytes' ? -1 : 1); sortK = k; render(); });
$('#go').onclick = async () => { $('#go').disabled = true; await fetch('/api/submit', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({uuids:[...sel], download: $('#dl').checked})}); document.body.innerHTML = '<div class="done">Sent to GrundiumGrab. Watch the terminal for progress.<br><span class="muted">You can close this tab.</span></div>'; };
addEventListener('pagehide', () => { navigator.sendBeacon('/api/cancel'); });
$('#cancel').onclick = async () => { await fetch('/api/cancel', {method:'POST'}); document.body.innerHTML = '<div class="done">Cancelled. You can close this tab.</div>'; };
</script></body></html>`;
