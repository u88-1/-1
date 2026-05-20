// ══════════════════════════════════════════════════════
//  אוצריא — בודק מקורות  |  app.js  v7
// ══════════════════════════════════════════════════════

function loadSettings(){try{return JSON.parse(localStorage.getItem('otzaria_settings')||'{}');}catch{return{};}}
function saveSettings(o){localStorage.setItem('otzaria_settings',JSON.stringify(o));}
let settings=loadSettings();

function loadHistory(){try{return JSON.parse(localStorage.getItem('otzaria_history')||'[]');}catch{return[];}}
function addHistory(e){
    if(settings.saveHistory===false)return;
    const h=loadHistory();h.unshift({...e,ts:Date.now()});
    if(h.length>50)h.length=50;
    localStorage.setItem('otzaria_history',JSON.stringify(h));
}

['inputFile','dbPath'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const saved=localStorage.getItem('otzaria_'+id);
    if(saved)el.value=saved;
    el.addEventListener('input',()=>localStorage.setItem('otzaria_'+id,el.value));
});

function showPage(name){
    ['compare','history','about','settings'].forEach(p=>{
        const el=document.getElementById('page-'+p);
        if(el)el.style.display=p===name?'':'none';
    });
    document.querySelectorAll('.nav-link').forEach(a=>a.classList.toggle('active',a.dataset.page===name));
    if(name==='history')renderHistory();
    if(name==='settings')loadSettingsUI();
}
document.querySelectorAll('.nav-link').forEach(a=>
    a.addEventListener('click',e=>{e.preventDefault();showPage(a.dataset.page);}));

const timerBox=document.getElementById('timerBox');
const timerEl=document.getElementById('timer');
let timerInterval=null,startTime=0;
function startTimer(){
    startTime=performance.now();timerEl.textContent='0.0s';timerBox.style.display='flex';
    timerInterval=setInterval(()=>timerEl.textContent=((performance.now()-startTime)/1000).toFixed(1)+'s',100);
}
function stopTimer(){
    clearInterval(timerInterval);
    const e=((performance.now()-startTime)/1000).toFixed(2)+'s';
    timerEl.textContent=e;return e;
}

// ── Globals ───────────────────────────────────────────
let sortedCache=[],renderedCount=100;
let lastResults=null,filterQuery='',filterStatus='all',debounceTimer=null;
let currentDbPath='',activeJobId=null,isRunning=false;
let streamStats={total:0,processed:0,found:0,notFound:0};

const inputFileEl=document.getElementById('inputFile');
const dbPathEl=document.getElementById('dbPath');
const runButton=document.getElementById('runButton');
const statusEl=document.getElementById('status');
const summaryEl=document.getElementById('summary');
const resultArea=document.getElementById('resultArea');

function getBracketValue(){
    return document.querySelector('input[name="brackets"]:checked')?.value||'curly';
}

// ── Run ───────────────────────────────────────────────
runButton.addEventListener('click',()=>{
    if(isRunning){stopComparison();return;}
    startComparison();
});

function startComparison(){
    const filePath=inputFileEl.value.trim().replace(/^["']+|["']+$/g,'').trim();
    if(!filePath){setStatus('אנא הזן נתיב קובץ מלא.','error');return;}

    isRunning=true;
    setStatus('מריץ השוואה...','working');
    summaryEl.style.display='none';
    resultArea.innerHTML='';
    document.getElementById('resultsToolbar')?.remove();
    sortedCache=[];renderedCount=100;lastResults=null;
    startTimer();

    runButton.innerHTML=`<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><rect x="4" y="4" width="12" height="12" rx="2"/></svg> עצור`;
    runButton.classList.add('stop-mode');

    currentDbPath=dbPathEl.value.trim()||settings.defaultDb||'';
    const body={
        inputFile:filePath,
        options:{
            hebNums:settings.hebNums!==false,abbrev:settings.abbrev!==false,
            fuzzy:settings.fuzzy!==false,sefaria:settings.sefaria!==false,
            brackets:getBracketValue(),
        }
    };
    if(currentDbPath)body.dbPath=currentDbPath;

    resultArea.innerHTML='<div class="compare-list" id="streamList"></div>';
    streamStats={total:0,processed:0,found:0,notFound:0};

    fetch('/compare-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(res=>{
            activeJobId=res.headers.get('X-Job-Id');
            const reader=res.body.getReader();
            const decoder=new TextDecoder();
            let buffer='';
            function read(){
                reader.read().then(({done,value})=>{
                    if(done){onStreamEnd();return;}
                    buffer+=decoder.decode(value,{stream:true});
                    const lines=buffer.split('\n');
                    buffer=lines.pop();
                    let event='message',dataStr='';
                    for(const line of lines){
                        if(line.startsWith('event:'))event=line.slice(6).trim();
                        else if(line.startsWith('data:'))dataStr=line.slice(5).trim();
                        else if(line===''&&dataStr){
                            try{handleStreamEvent(event,JSON.parse(dataStr));}catch{}
                            event='message';dataStr='';
                        }
                    }
                    read();
                }).catch(()=>onStreamEnd());
            }
            read();
        })
        .catch(err=>{
            stopTimer();setStatus('שגיאה: '+err.message,'error');resetRunButton();
        });
}

function handleStreamEvent(event,payload){
    if(event==='start'){
        streamStats={total:0,processed:0,found:0,notFound:0};
    }
    else if(event==='result'){
        const{result,progress}=payload;
        streamStats={total:progress.total,processed:progress.processed,found:progress.foundCount,notFound:progress.notFoundCount};
        sortedCache.push(result);
        setStatus(`מעבד... ${progress.processed}/${progress.total} — נמצאו: ${progress.foundCount} | לא נמצאו: ${progress.notFoundCount}`,'working');
        updateProgressBar(progress.processed,progress.total);
        appendResult(result);
    }
    else if(event==='done'){
        onStreamComplete(payload);
    }
    else if(event==='error'){
        setStatus('שגיאה: '+(payload.error||''),'error');
        resetRunButton();
    }
}

function updateProgressBar(done,total){
    let bar=document.getElementById('progressBar');
    if(!bar){
        bar=document.createElement('div');bar.id='progressBar';
        bar.innerHTML='<div id="progressFill" style="width:0%"></div>';
        statusEl.after(bar);
    }
    document.getElementById('progressFill').style.width=(total>0?Math.round(done/total*100):0)+'%';
}

function appendResult(item){
    const list=document.getElementById('streamList');if(!list)return;
    const idx=sortedCache.length-1;
    const div=document.createElement('div');
    div.innerHTML=buildCompareCard(item,idx);
    list.appendChild(div.firstElementChild);
    div.firstElementChild?.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function onStreamEnd(){
    if(!isRunning)return;
    onStreamComplete({
        aborted:true,results:sortedCache,
        totalRefs:streamStats.total||sortedCache.length,
        foundCount:streamStats.found||sortedCache.filter(r=>r.rows?.length>0).length,
        notFoundCount:streamStats.notFound||sortedCache.filter(r=>!r.rows?.length).length,
    });
}

function onStreamComplete(summary){
    const elapsed=stopTimer();
    isRunning=false;activeJobId=null;
    resetRunButton();
    document.getElementById('progressBar')?.remove();
    if(summary.error){setStatus('שגיאה: '+summary.error,'error');return;}
    lastResults=summary;
    const aborted=summary.aborted;
    setStatus(aborted?`הופסק — עובד ${sortedCache.length} הפניות (${elapsed})`:`ההשוואה הסתיימה ✓  (${elapsed})`,aborted?'':'ok');
    renderSummary({...summary,results:sortedCache});
    renderToolbar({...summary,results:sortedCache});
    const rank=x=>(x.rows?.length)?(x.matchType==='exact'?2:1):0;
    sortedCache=[...sortedCache].sort((a,b)=>rank(a)-rank(b));
    renderResults();
    if(!aborted)addHistory({filePath:inputFileEl.value.trim(),dbPath:currentDbPath,
        totalRefs:summary.totalRefs,foundCount:summary.foundCount,
        notFoundCount:summary.notFoundCount,elapsed});
}

async function stopComparison(){
    if(activeJobId){
        try{await fetch('/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:activeJobId})});}catch{}
    }
    isRunning=false;activeJobId=null;
    stopTimer();resetRunButton();
    document.getElementById('progressBar')?.remove();
    setStatus('הופסק על ידי המשתמש','');
}

function resetRunButton(){
    runButton.innerHTML=`<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="M15 15l3 3" stroke-linecap="round"/></svg> השווה מקורות`;
    runButton.classList.remove('stop-mode');
    runButton.disabled=false;
}

// ── Helpers ───────────────────────────────────────────
function setStatus(msg,type){statusEl.textContent=msg;statusEl.className='status-bar'+(type?' '+type:'');}
function esc(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function highlightPhrase(content,phrase){
    if(!phrase||phrase.length<3)return esc(content);
    const words=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').split(/\s+/).filter(w=>w.length>2);
    if(!words.length)return esc(content);
    return esc(content).replace(new RegExp('('+words.join('|')+')','g'),'<mark class="phrase-hl">$1</mark>');
}
function highlight(text,query){
    if(!query||query.length<2)return esc(text);
    return esc(text).replace(new RegExp('('+query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark class="hl">$1</mark>');
}
function markRefInSentence(sentence,ref){
    const escaped=ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    // match any bracket type
    return esc(sentence).replace(new RegExp('[{\\[(]'+escaped+'[}\\])]','g'),'<span class="ref-in-sentence">$&</span>');
}
function badgeHtml(mt){
    const labels={exact:'✓ מדויק',prefix:'✓ קידומת',fuzzy:'✓ חלקי',sefaria:'✓ Sefaria 🌐',none:'✗ לא נמצא'};
    const cls={exact:'badge-found',prefix:'badge-partial',fuzzy:'badge-partial',sefaria:'badge-sefaria',none:'badge-missing'};
    const t=mt||'none';
    return`<span class="badge ${cls[t]||'badge-missing'}">${labels[t]||t}</span>`;
}

function buildCompareCard(item,idx){
    const badge=badgeHtml(item.matchType);
    const sentenceHtml=item.sentence?markRefInSentence(item.sentence,item.ref):`<span style="color:var(--text-3)">(אין הקשר)</span>`;
    if(!item.rows?.length){
        return`<div class="ccard ccard-missing">
            <div class="ccard-ref-row"><span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>${badge}</div>
            <div class="ccard-cols">
                <div class="ccard-source"><div class="ccard-section-label">📄 מהמקור</div><div class="ccard-sentence">${sentenceHtml}</div></div>
                <div class="ccard-divider"></div>
                <div class="ccard-db ccard-db-missing"><div class="ccard-section-label">🗄 מהמאגר</div><div class="ccard-not-found">לא נמצא</div></div>
            </div>
        </div>`;
    }
    const dbBlocks=item.rows.map((row,ri)=>{
        const contentHtml=highlightPhrase(row.content||'',item.quoteBefore);
        const sefariaLink=row.sefariaUrl?`<a class="sefaria-link" href="${esc(row.sefariaUrl)}" target="_blank">🔗 פתח ב-Sefaria</a>`:'';
        const expandBtn=item.isBavli&&row.lineId?`<button class="expand-page-btn" onclick="expandTalmudPage(${row.lineId},'${esc(row.heRef)}',this)">📖 הרחב לדף מלא</button>`:'';
        const typeLabel={exact:'מדויק',prefix:'קידומת',fuzzy:'חלקי',sefaria:'Sefaria'}[row.matchType||item.matchType]||'';
        return`<div class="db-match${ri>0?' db-match-sep':''}">
            <div class="db-match-meta">
                <span class="book-name">${highlight(row.bookTitle,filterQuery)}</span>
                <span class="db-heref">📌 ${highlight(row.heRef,filterQuery)}</span>
                <span class="match-label match-${row.matchType||item.matchType}">${typeLabel}</span>
                ${sefariaLink}
            </div>
            <div class="db-content" dir="rtl">${contentHtml}</div>
            ${expandBtn}
            <div class="page-expand-area" id="page-${idx}-${ri}" style="display:none"></div>
        </div>`;
    }).join('');
    return`<div class="ccard">
        <div class="ccard-ref-row">
            <span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>${badge}
            ${item.rows.length>1?`<span class="multi-count">${item.rows.length} תוצאות</span>`:''}
        </div>
        <div class="ccard-cols">
            <div class="ccard-source"><div class="ccard-section-label">📄 מהמקור</div><div class="ccard-sentence">${sentenceHtml}</div></div>
            <div class="ccard-divider"></div>
            <div class="ccard-db"><div class="ccard-section-label">🗄 מהמאגר</div>${dbBlocks}</div>
        </div>
    </div>`;
}

// ── Summary ───────────────────────────────────────────
function renderSummary(r){
    const exactCount=(r.results||[]).filter(x=>x.matchType==='exact').length;
    const sefariaCount=r.sefariaFoundCount||0;
    const partialCount=Math.max(0,r.foundCount-sefariaCount-exactCount);
    const pct=r.totalRefs>0?Math.round(r.foundCount/r.totalRefs*100):0;
    summaryEl.style.display='block';
    summaryEl.innerHTML=`<div class="summary-grid">
        <div class="stat-card"><div class="stat-num">${r.totalRefs}</div><div class="stat-label">הפניות</div></div>
        <div class="stat-card s-found"><div class="stat-num">${exactCount}</div><div class="stat-label">מדויק ✓</div></div>
        <div class="stat-card s-partial"><div class="stat-num">${partialCount}</div><div class="stat-label">חלקי</div></div>
        ${sefariaCount>0?`<div class="stat-card s-sefaria"><div class="stat-num">${sefariaCount}</div><div class="stat-label">Sefaria 🌐</div></div>`:''}
        <div class="stat-card s-missing"><div class="stat-num">${r.notFoundCount}</div><div class="stat-label">לא נמצאו ✗</div></div>
        <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-label">כיסוי</div></div>
    </div>`;
}

// ── Toolbar ───────────────────────────────────────────
function renderToolbar(r){
    const toolbar=document.createElement('div');
    toolbar.id='resultsToolbar';toolbar.className='results-toolbar';
    toolbar.innerHTML=`
        <div class="toolbar-right">
            <input id="filterInput" class="filter-input" type="text" placeholder="חפש הפניה, ספר..." />
            <div class="filter-tabs">
                <button class="filter-tab active" data-status="all">הכל <span class="tab-count">${r.results.length}</span></button>
                <button class="filter-tab" data-status="found">נמצאו <span class="tab-count s-found">${r.foundCount}</span></button>
                <button class="filter-tab" data-status="missing">לא נמצאו <span class="tab-count s-missing">${r.notFoundCount}</span></button>
            </div>
        </div>
        <div class="toolbar-left">
            <div class="export-wrap">
                <button class="export-btn" id="exportBtn">↓ ייצוא</button>
                <div class="export-menu" id="exportMenu" style="display:none">
                    <button onclick="exportData('csv')">CSV</button>
                    <button onclick="exportData('txt')">טקסט</button>
                </div>
            </div>
        </div>`;
    document.getElementById('resultsToolbar')?.remove();
    resultArea.before(toolbar);
    document.getElementById('filterInput').addEventListener('input',e=>{
        clearTimeout(debounceTimer);
        debounceTimer=setTimeout(()=>{filterQuery=e.target.value.trim();renderedCount=100;renderResults();},250);
    });
    toolbar.querySelectorAll('.filter-tab').forEach(btn=>btn.addEventListener('click',()=>{
        toolbar.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');filterStatus=btn.dataset.status;renderedCount=100;renderResults();
    }));
    document.getElementById('exportBtn').addEventListener('click',e=>{
        e.stopPropagation();
        const m=document.getElementById('exportMenu');
        m.style.display=m.style.display==='none'?'':'none';
    });
    document.addEventListener('click',()=>{const m=document.getElementById('exportMenu');if(m)m.style.display='none';});
}

// ── Filter & Render ───────────────────────────────────
function getFilteredResults(){
    if(!sortedCache)return[];
    if(filterStatus==='all'&&filterQuery.length<1)return sortedCache;
    const q=filterQuery.toLowerCase();
    return sortedCache.filter(item=>{
        const found=item.rows?.length>0;
        if(filterStatus==='found'&&!found)return false;
        if(filterStatus==='missing'&&found)return false;
        if(!q)return true;
        return item.ref.toLowerCase().includes(q)||
               item.sentence?.toLowerCase().includes(q)||
               item.rows?.some(r=>(r.bookTitle||'').toLowerCase().includes(q)||(r.heRef||'').toLowerCase().includes(q));
    });
}
function renderResults(){
    if(!sortedCache?.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔍</div><div>לא נמצאו הפניות.</div></div>`;return;}
    const filtered=getFilteredResults();
    if(!filtered.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔎</div><div>אין תוצאות.</div></div>`;return;}
    const chunk=filtered.slice(0,renderedCount);
    const hasMore=filtered.length>renderedCount;
    const cards=chunk.map((item,idx)=>buildCompareCard(item,idx)).join('');
    const moreBtn=hasMore?`<div class="load-more-wrap"><button class="expand-btn" onclick="loadMore()">▼ הצג עוד (${filtered.length-chunk.length} נוספות)</button></div>`:'';
    resultArea.innerHTML=`<div class="compare-list">${cards}${moreBtn}</div>`;
}
function loadMore(){renderedCount+=100;renderResults();}

// ── Talmud page expand ────────────────────────────────
async function expandTalmudPage(lineId,heRef,btn){
    const area=btn.nextElementSibling;if(!area)return;
    if(area.style.display!=='none'){area.style.display='none';btn.textContent='📖 הרחב לדף מלא';return;}
    btn.disabled=true;btn.textContent='טוען...';
    try{
        const res=await fetch('/expand-page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lineId,dbPath:currentDbPath})});
        const data=await res.json();
        if(!res.ok||!data.lines?.length)throw new Error(data.error||'לא נמצא');
        const linesHtml=data.lines.map(l=>`<div class="page-line${l.isFocus?' page-line-focus':''}">
            <span class="page-line-ref">${esc(l.heRef||'')}</span>
            <span class="page-line-content">${l.isFocus?`<strong>${esc(l.content)}</strong>`:esc(l.content)}</span>
        </div>`).join('');
        area.innerHTML=`<div class="page-expand">
            <div class="page-expand-header"><span>📖 ${esc(heRef)}</span>
                <button class="page-expand-close" onclick="this.closest('.page-expand-area').style.display='none';this.closest('.db-match').querySelector('.expand-page-btn').textContent='📖 הרחב לדף מלא';">✕</button>
            </div>
            <div class="page-lines" dir="rtl">${linesHtml}</div>
        </div>`;
        area.style.display='';
        area.scrollIntoView({behavior:'smooth',block:'nearest'});
        btn.textContent='▲ סגור דף';
    }catch(err){
        area.innerHTML=`<div style="color:var(--red);padding:8px">שגיאה: ${esc(err.message)}</div>`;
        area.style.display='';btn.textContent='📖 הרחב לדף מלא';
    }finally{btn.disabled=false;}
}

// ── Browse file ───────────────────────────────────────
async function browseFile(type){
    try{
        const res=await fetch('/browse-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});
        const data=await res.json();if(!data.path)return;
        if(type==='txt'){document.getElementById('inputFile').value=data.path;localStorage.setItem('otzaria_inputFile',data.path);}
        else if(type==='db'){document.getElementById('dbPath').value=data.path;localStorage.setItem('otzaria_dbPath',data.path);}
        else if(type==='db-settings'){document.getElementById('settingsDbPath').value=data.path;}
    }catch(e){console.error('browse error:',e);}
}

// ── Export ────────────────────────────────────────────
function exportData(format){
    if(!sortedCache?.length)return;
    const filtered=getFilteredResults();
    let content,filename,mime;
    if(format==='csv'){
        const rows=[['הפניה','הקשר','סטטוס','ספר','הפניה ב-DB','תוכן']];
        filtered.forEach(item=>{
            if(!item.rows?.length)rows.push([item.ref,item.sentence||'','לא נמצא','','','']);
            else item.rows.forEach(r=>rows.push([item.ref,item.sentence||'',item.matchType,r.bookTitle,r.heRef,(r.content||'').substring(0,200)]));
        });
        content='\uFEFF'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
        filename='compare_sources.csv';mime='text/csv;charset=utf-8';
    }else{
        const lines=['דוח בודק מקורות אוצריא','='.repeat(50),''];
        filtered.forEach(item=>{
            lines.push('─'.repeat(50),'הפניה: '+item.ref);
            if(item.sentence)lines.push('הקשר: '+item.sentence);
            if(!item.rows?.length)lines.push('תוצאה: לא נמצא');
            else item.rows.forEach((r,i)=>{lines.push(`תוצאה ${i+1}: ${r.bookTitle} | ${r.heRef}`);lines.push('תוכן: '+(r.content||'').substring(0,300));});
            lines.push('');
        });
        content=lines.join('\n');filename='compare_sources.txt';mime='text/plain;charset=utf-8';
    }
    const blob=new Blob([content],{type:mime});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=filename;a.click();
    URL.revokeObjectURL(url);
    document.getElementById('exportMenu').style.display='none';
}

// ── History ───────────────────────────────────────────
function renderHistory(){
    const hist=loadHistory();
    const container=document.getElementById('historyList');if(!container)return;
    if(!hist.length){container.innerHTML=`<div class="history-empty"><div class="empty-icon">🕐</div><div>אין הרצות קודמות.</div></div>`;return;}
    container.innerHTML=`<div class="history-list">${hist.map((h,i)=>{
        const date=new Date(h.ts);
        const ds=date.toLocaleDateString('he-IL')+' '+date.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});
        const pct=h.totalRefs>0?Math.round(h.foundCount/h.totalRefs*100):0;
        return`<div class="history-card">
            <div>
                <div class="history-file">📄 ${esc(h.filePath)}</div>
                <div class="history-stats">
                    <span class="h-stat found">נמצאו: ${h.foundCount}</span>
                    <span class="h-stat missing">לא נמצאו: ${h.notFoundCount}</span>
                    <span class="h-stat found">${pct}% כיסוי</span>
                </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
                <div class="history-time">${esc(ds)}</div>
                <div class="history-time">${esc(h.elapsed||'')}</div>
                <button class="history-load-btn" onclick="loadFromHistory(${i})">טען שוב</button>
            </div>
        </div>`;
    }).join('')}</div>`;
}
function loadFromHistory(idx){
    const h=loadHistory()[idx];if(!h)return;
    const ie=document.getElementById('inputFile');const de=document.getElementById('dbPath');
    if(ie){ie.value=h.filePath;localStorage.setItem('otzaria_inputFile',h.filePath);}
    if(de&&h.dbPath){de.value=h.dbPath;localStorage.setItem('otzaria_dbPath',h.dbPath);}
    showPage('compare');
}
document.getElementById('clearHistoryBtn')?.addEventListener('click',()=>{
    if(confirm('למחוק את כל ההיסטוריה?')){localStorage.removeItem('otzaria_history');renderHistory();}
});

// ── Settings ──────────────────────────────────────────
function loadSettingsUI(){
    const s=loadSettings();
    const dbEl=document.getElementById('settingsDbPath');if(dbEl)dbEl.value=s.defaultDb||'';
    const opts={'opt-hebnums':'hebNums','opt-abbrev':'abbrev','opt-fuzzy':'fuzzy','opt-sefaria':'sefaria','opt-history':'saveHistory'};
    Object.entries(opts).forEach(([id,key])=>{const el=document.getElementById(id);if(el)el.checked=s[key]!==false;});
}
document.getElementById('saveSettingsBtn')?.addEventListener('click',()=>{
    const dbEl=document.getElementById('settingsDbPath');
    const opts={'opt-hebnums':'hebNums','opt-abbrev':'abbrev','opt-fuzzy':'fuzzy','opt-sefaria':'sefaria','opt-history':'saveHistory'};
    const ns={defaultDb:dbEl?.value.trim()||''};
    Object.entries(opts).forEach(([id,key])=>{const el=document.getElementById(id);ns[key]=el?el.checked:true;});
    saveSettings(ns);settings=ns;
    const saved=document.getElementById('settingsSaved');
    if(saved){saved.style.display='flex';setTimeout(()=>saved.style.display='none',2500);}
});

loadSettingsUI();
