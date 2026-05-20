const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { exec, spawn } = require('child_process');
const { runComparison, fetchTalmudPage } = require('./compare_sources');

const publicDir  = path.join(__dirname, 'public');
const port       = 3000;
const APP_URL    = `http://localhost:${port}`;

const mimeTypes  = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function serveFile(res, filePath) {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, {'Content-Type': 'text/plain;charset=utf-8'}); res.end('Not found'); return; }
        res.writeHead(200, {'Content-Type': mime}); res.end(data);
    });
}
function json(res, code, obj) {
    res.writeHead(code, {'Content-Type': 'application/json;charset=utf-8'});
    res.end(JSON.stringify(obj));
}
function parseBody(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') {
            serveFile(res, path.join(publicDir, 'index.html')); return;
        }
        const filePath = path.join(publicDir, url.pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            serveFile(res, filePath); return;
        }
        res.writeHead(404); res.end('Not found'); return;
    }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    if (url.pathname === '/compare') {
        try {
            const data = await parseBody(req);
            if (!data.inputFile) throw new Error('חסר נתיב קובץ');
            const result = await runComparison(data.inputFile, data.dbPath || null, data.options || {});
            json(res, 200, result);
        } catch(err) { json(res, 500, {error: err.message || 'שגיאה לא ידועה'}); }
        return;
    }

    if (url.pathname === '/expand-page') {
        try {
            const data = await parseBody(req);
            if (!data.lineId) throw new Error('חסר lineId');
            const lines = await fetchTalmudPage(data.dbPath || null, data.lineId);
            json(res, 200, {lines});
        } catch(err) { json(res, 500, {error: err.message}); }
        return;
    }

    // סגירה מהחלון
    if (url.pathname === '/quit') {
        res.writeHead(200); res.end('bye');
        setTimeout(() => process.exit(0), 300);
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── חלון שליטה קטן ───────────────────────────────────────────────────────────
function openControlWindow() {
    const html = `
<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<title>אוצריא</title>
<style>
  body {
    margin:0; padding:0;
    font-family: 'Segoe UI', Arial, sans-serif;
    background: #1a1208;
    color: #e8d5a0;
    width: 320px;
    height: 180px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    border: 2px solid #c9a84c;
    box-sizing: border-box;
  }
  .logo { font-size: 2.2rem; }
  .title { font-size: 1.3rem; font-weight: bold; color: #c9a84c; letter-spacing: 2px; }
  .status { font-size: 0.8rem; color: #8a7a50; }
  .btn-row { display: flex; gap: 10px; }
  button {
    padding: 7px 22px;
    border-radius: 20px;
    border: 1px solid #c9a84c;
    background: rgba(201,168,76,0.15);
    color: #c9a84c;
    font-size: 0.9rem;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover { background: rgba(201,168,76,0.3); }
  .btn-close {
    border-color: #e05050;
    color: #e05050;
    background: rgba(224,80,80,0.1);
  }
  .btn-close:hover { background: rgba(224,80,80,0.25); }
</style>
</head>
<body>
  <div class="logo">📖</div>
  <div class="title">אוצריא</div>
  <div class="status">השרת פועל על פורט 3000</div>
  <div class="btn-row">
    <button onclick="window.open('http://localhost:3000')">פתח</button>
    <button class="btn-close" onclick="var x=new XMLHttpRequest();x.open('GET','http://localhost:3000/quit');x.send();setTimeout(function(){window.close();},400);">סגור</button>
  </div>
</body>
</html>`;

    // שמור קובץ זמני ופתח עם mshta
    const tmpFile = path.join(require('os').tmpdir(), 'otzaria_ctrl.hta');
    const hta = html
        .replace('<html dir="rtl">', '<html dir="rtl">\n<hta:application\n  applicationName="אוצריא"\n  border="thin"\n  borderStyle="normal"\n  caption="yes"\n  maximizeButton="no"\n  minimizeButton="yes"\n  showInTaskbar="yes"\n  singleInstance="yes"\n  sysmenu="yes"\n  windowState="normal"\n  scroll="no"\n  innerBorder="no"\n/>');
    fs.writeFileSync(tmpFile, hta, 'utf8');
    
    const proc = spawn('mshta.exe', [tmpFile], { detached: false, stdio: 'ignore' });
    proc.on('close', () => {
        // אם החלון נסגר — סגור גם את השרת
        process.exit(0);
    });
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(port, () => {
    console.log(`השרת פועל ב: ${APP_URL}`);
    setTimeout(() => {
        exec(`start ${APP_URL}`);
        openControlWindow();
    }, 500);
});
