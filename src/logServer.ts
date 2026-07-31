import http from "http";
import fs from "fs";
import path from "path";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config } from "./config";

const PORT = parseInt(process.env.LOG_SERVER_PORT || "3002", 10);
const COMBINED_LOG = path.join(config.paths.logDir, "combined.log");
const TAIL_LINES = 300;

function readLastLines(filePath: string, n: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shorts Automation — Live Logs</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:13px}
    #header{position:sticky;top:0;background:#161b22;border-bottom:1px solid #30363d;padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:10}
    #header h1{font-size:14px;font-weight:600;color:#58a6ff}
    #dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s infinite}
    #dot.off{background:#f85149;animation:none}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    #controls{margin-left:auto;display:flex;gap:8px;align-items:center}
    #filter{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:6px;font-size:12px;width:160px}
    button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px}
    button:hover{background:#30363d}
    #count{color:#6e7681;font-size:12px}
    #log{padding:4px 0}
    .e{padding:2px 16px;line-height:1.6;display:flex;gap:10px}
    .e:hover{background:#161b22}
    .ts{color:#6e7681;flex-shrink:0;white-space:nowrap}
    .lv{flex-shrink:0;width:36px;font-weight:bold}
    .lb{color:#79c0ff;flex-shrink:0;min-width:110px}
    .mg{flex:1;word-break:break-word;white-space:pre-wrap}
    .info .lv{color:#3fb950}.warn .lv{color:#d29922}.warn .mg{color:#e3b341}
    .error .lv{color:#f85149}.error .mg{color:#ff7b72}
    #bottom{height:1px}
  </style>
</head>
<body>
<div id="header">
  <div id="dot"></div>
  <h1>Shorts Automation — Live Logs</h1>
  <div id="controls">
    <input id="filter" placeholder="Filter..." oninput="applyFilter()">
    <span id="count"></span>
    <button onclick="clearLog()">Clear</button>
    <button id="scrollBtn" onclick="toggleScroll()">Auto-scroll: ON</button>
  </div>
</div>
<div id="log"></div>
<div id="bottom"></div>
<script>
  let autoScroll = true, total = 0, filter = '';
  const log = document.getElementById('log');
  const dot = document.getElementById('dot');
  const countEl = document.getElementById('count');

  function toggleScroll() {
    autoScroll = !autoScroll;
    document.getElementById('scrollBtn').textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  }
  function clearLog() { log.innerHTML = ''; total = 0; updateCount(); }
  function updateCount() { countEl.textContent = total + ' entries'; }
  function applyFilter() {
    filter = document.getElementById('filter').value.toLowerCase();
    for (const el of log.children) {
      el.style.display = filter && !el.dataset.text.includes(filter) ? 'none' : '';
    }
  }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function append(raw) {
    let o; try { o = JSON.parse(raw); } catch { return; }
    const level = (o.level || 'info').toLowerCase();
    const ts = (o.timestamp || '').replace('T',' ').replace(/\\.\\d+Z$/,'');
    const label = o.label || '';
    const msg = o.message || '';
    const div = document.createElement('div');
    div.className = 'e ' + level;
    div.dataset.text = (ts + ' ' + level + ' ' + label + ' ' + msg).toLowerCase();
    div.innerHTML =
      '<span class="ts">' + esc(ts) + '</span>' +
      '<span class="lv">' + level.slice(0,4).toUpperCase() + '</span>' +
      '<span class="lb">[' + esc(label) + ']</span>' +
      '<span class="mg">' + esc(msg) + '</span>';
    if (filter && !div.dataset.text.includes(filter)) div.style.display = 'none';
    log.appendChild(div);
    total++;
    updateCount();
    if (autoScroll) document.getElementById('bottom').scrollIntoView({ behavior: 'smooth' });
  }

  function connect() {
    const es = new EventSource('/logs');
    es.onopen = () => dot.classList.remove('off');
    es.onmessage = e => append(e.data);
    es.onerror = () => { dot.classList.add('off'); es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;

export function startLogServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/logs") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      // Send recent history on connect
      for (const line of readLastLines(COMBINED_LOG, TAIL_LINES)) {
        res.write(`data: ${line}\n\n`);
      }

      addLogClient(res);
      req.on("close", () => removeLogClient(res));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[LogServer] Live log viewer → http://0.0.0.0:${PORT}`);
  });
}
