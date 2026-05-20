const { app, BrowserWindow, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net  = require('net');
const fs   = require('fs');
const { runComparisonStreaming, fetchTalmudPage } = require('./compare_sources');

const publicDir = path.join(__dirname, 'public');
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

let mainWindow=null, tray=null, appPort=3000;

// מעקב אחרי תהליך פעיל לצורך עצירה
const activeJobs = new Map();

function findFreePort(start) {
    return new Promise(resolve=>{
        const s=net.createServer();
        s.once('error',()=>resolve(findFreePort(start+1)));
        s.once('listening',()=>{const p=s.address().port;s.close(()=>resolve(p));});
        s.listen(start);
    });
}

function serveFile(res,filePath){
    const ext=path.extname(filePath).toLowerCase();
    const mime=mimeTypes[ext]||'application/octet-stream';
    fs.readFile(filePath,(err,data)=>{
        if(err){res.writeHead(404);res.end('Not found');return;}
        res.writeHead(200,{'Content-Type':mime});res.end(data);
    });
}
function json(res,code,obj){
    res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'});
    res.end(JSON.stringify(obj));
}
function parseBody(req){
    return new Promise(resolve=>{
        let body='';
        req.on('data',c=>body+=c);
        req.on('end',()=>{try{resolve(JSON.parse(body||'{}'));}catch{resolve({});}});
    });
}

const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,`http://localhost:${appPort}`);

    if(req.method==='GET'){
        if(url.pathname==='/'||url.pathname==='/index.html'){
            serveFile(res,path.join(publicDir,'index.html'));return;
        }
        const filePath=path.join(publicDir,url.pathname);
        if(fs.existsSync(filePath)&&fs.statSync(filePath).isFile()){
            serveFile(res,filePath);return;
        }
        res.writeHead(404);res.end('Not found');return;
    }
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}

    // ── סייר קבצים ──────────────────────────────────────────────────────────
    if(url.pathname==='/browse-file'){
        try{
            const data=await parseBody(req);
            const type=data.type||'txt';
            let filters,title;
            if(type==='txt'){
                filters=[{name:'קבצי טקסט',extensions:['txt','docx','doc']},{name:'כל הקבצים',extensions:['*']}];
                title='בחר קובץ טקסט לבדיקה';
            } else {
                filters=[{name:'מסד נתונים',extensions:['db','sqlite','sqlite3']},{name:'כל הקבצים',extensions:['*']}];
                title='בחר מסד נתונים';
            }
            const result=await dialog.showOpenDialog(mainWindow,{title,filters,properties:['openFile']});
            if(result.canceled||!result.filePaths.length){json(res,200,{path:null});return;}
            json(res,200,{path:result.filePaths[0]});
        }catch(err){json(res,500,{error:err.message});}
        return;
    }

    // ── השוואה עם streaming ──────────────────────────────────────────────────
    if(url.pathname==='/compare-stream'){
        try{
            const data=await parseBody(req);
            if(!data.inputFile) throw new Error('חסר נתיב קובץ');

            const jobId=Date.now().toString();
            const abortController=new AbortController();
            activeJobs.set(jobId,abortController);

            // Server-Sent Events
            res.writeHead(200,{
                'Content-Type':'text/event-stream',
                'Cache-Control':'no-cache',
                'Connection':'keep-alive',
                'X-Job-Id':jobId,
            });

            function send(event,payload){
                if(res.writableEnded) return;
                res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
            }

            send('start',{jobId,total:0});

            runComparisonStreaming(
                data.inputFile, data.dbPath||null, data.options||{},
                (result,progress)=>send('result',{result,progress}),
                summary=>{
                    send('done',summary);
                    activeJobs.delete(jobId);
                    if(!res.writableEnded) res.end();
                },
                abortController.signal
            );

            req.on('close',()=>{
                abortController.abort();
                activeJobs.delete(jobId);
            });
        }catch(err){
            if(!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({error:err.message})}\n\n`);
        }
        return;
    }

    // ── עצור תהליך ──────────────────────────────────────────────────────────
    if(url.pathname==='/abort'){
        try{
            const data=await parseBody(req);
            const ctrl=activeJobs.get(data.jobId);
            if(ctrl){ctrl.abort();activeJobs.delete(data.jobId);}
            json(res,200,{ok:true});
        }catch(err){json(res,500,{error:err.message});}
        return;
    }

    // ── הרחבת דף ────────────────────────────────────────────────────────────
    if(url.pathname==='/expand-page'){
        try{
            const data=await parseBody(req);
            if(!data.lineId) throw new Error('חסר lineId');
            const lines=await fetchTalmudPage(data.dbPath||null,data.lineId);
            json(res,200,{lines});
        }catch(err){json(res,500,{error:err.message});}
        return;
    }

    res.writeHead(404);res.end('Not found');
});

function createWindow(){
    const iconPath=path.join(__dirname,'icon.ico');
    mainWindow=new BrowserWindow({
        width:1280,height:820,minWidth:800,minHeight:600,
        title:'אוצריא — בודק מקורות',
        icon:fs.existsSync(iconPath)?iconPath:undefined,
        webPreferences:{nodeIntegration:false,contextIsolation:true},
        backgroundColor:'#1a1208',show:false,
    });
    mainWindow.loadURL(`http://localhost:${appPort}`);
    mainWindow.once('ready-to-show',()=>mainWindow.show());
    mainWindow.on('close',e=>{if(!app.isQuiting){e.preventDefault();mainWindow.hide();}});
    Menu.setApplicationMenu(null);
}

function createTray(){
    const iconPath=path.join(__dirname,'icon.ico');
    const icon=fs.existsSync(iconPath)
        ?nativeImage.createFromPath(iconPath).resize({width:16,height:16})
        :nativeImage.createEmpty();
    tray=new Tray(icon);
    tray.setToolTip('אוצריא — בודק מקורות');
    tray.setContextMenu(Menu.buildFromTemplate([
        {label:'📖 פתח אוצריא',click:()=>{mainWindow.show();mainWindow.focus();}},
        {type:'separator'},
        {label:'✕ סגור',click:()=>{app.isQuiting=true;app.quit();}},
    ]));
    tray.on('click',()=>{mainWindow.show();mainWindow.focus();});
}

app.whenReady().then(async()=>{
    appPort=await findFreePort(3000);
    server.listen(appPort,()=>{createWindow();createTray();});
});
app.on('window-all-closed',e=>e.preventDefault());
app.on('activate',()=>{if(mainWindow){mainWindow.show();mainWindow.focus();}});
