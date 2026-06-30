const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ── Tantivy index check + build ──────────────────────────────────────────
async function checkAndShowIndexStatus() {
    const dbPath = document.getElementById('dbPath').value.trim();
    const statusEl = document.getElementById('indexStatus');
    const btn = document.getElementById('buildIndexBtn');
    if (!statusEl || !btn) return;
    try {
        const exists = await invoke('check_ref_index', { dbPath: dbPath || '' });
        if (exists) {
            statusEl.style.display = 'block';
            statusEl.className = 'index-status index-ok';
            statusEl.textContent = '✅ אינדקס מהיר פעיל';
            btn.textContent = '🔄 בנה מחדש';
        } else {
            statusEl.style.display = 'block';
            statusEl.className = 'index-status index-missing';
            statusEl.textContent = '⚠️ אינדקס לא נבנה — לחץ "בנה אינדקס" לחיפוש מהיר';
        }
    } catch(e) { statusEl.style.display = 'none'; }
}

document.getElementById('buildIndexBtn')?.addEventListener('click', async () => {
    const dbPath = document.getElementById('dbPath').value.trim();
    const btn = document.getElementById('buildIndexBtn');
    const statusEl = document.getElementById('indexStatus');
    btn.disabled = true;
    btn.textContent = '⏳ בונה אינדקס...';
    if (statusEl) { statusEl.style.display = 'block'; statusEl.className = 'index-status index-building'; statusEl.textContent = 'בונה אינדקס — עשוי לקחת 1-3 דקות...'; }
    const unlisten = await window.__TAURI__?.event?.listen('index-progress', e => {
        if (statusEl) statusEl.textContent = e.payload;
        if (e.payload === 'הושלם') {
            btn.disabled = false;
            btn.textContent = '🔄 בנה מחדש';
            if (statusEl) { statusEl.className = 'index-status index-ok'; statusEl.textContent = '✅ אינדקס נבנה בהצלחה!'; }
            if (unlisten) unlisten();
        } else if (String(e.payload).startsWith('שגיאה')) {
            btn.disabled = false;
            btn.textContent = '⚡ בנה אינדקס';
            if (unlisten) unlisten();
        }
    });
    try {
        await invoke('build_ref_index', { dbPath: dbPath || '' });
    } catch(e) {
        btn.disabled = false;
        btn.textContent = '⚡ בנה אינדקס';
        if (statusEl) { statusEl.className = 'index-status index-error'; statusEl.textContent = 'שגיאה: ' + e; }
    }
});

window.addEventListener('DOMContentLoaded', checkAndShowIndexStatus);
document.getElementById('dbPath')?.addEventListener('change', checkAndShowIndexStatus);

function loadSettings(){try{return JSON.parse(localStorage.getItem('bm_settings')||'{}');}catch{return{};}}
function saveSettings(o){localStorage.setItem('bm_settings',JSON.stringify(o));}
let settings=loadSettings();

function loadHistory(){try{return JSON.parse(localStorage.getItem('bm_history')||'[]');}catch{return[];}}
function addHistory(e){
    if(settings.saveHistory===false)return;
    const h=loadHistory();h.unshift({...e,ts:Date.now()});
    if(h.length>50)h.length=50;
    localStorage.setItem('bm_history',JSON.stringify(h));
}

['inputFile','dbPath'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const saved=localStorage.getItem('bm_'+id);
    if(saved)el.value=saved;
    el.addEventListener('input',()=>localStorage.setItem('bm_'+id,el.value));
});

// ── מצב יום/לילה ─────────────────────────────────────
function applyTheme(light){
    document.body.classList.toggle('light-mode', !!light);
    const el=document.getElementById('opt-light-mode');
    if(el)el.checked=!!light;
}
applyTheme(settings.lightMode);

// ── גודל כתב ─────────────────────────────────────────
let resultFontSize = settings.resultFontSize || 100;
function applyFontSize(size){
    resultFontSize=Math.max(70,Math.min(160,size));
    document.documentElement.style.setProperty('--result-font-size', resultFontSize+'%');
    const el=document.getElementById('fontSizeVal');
    if(el)el.textContent=resultFontSize+'%';
}
applyFontSize(resultFontSize);

document.getElementById('fontSizeUp')?.addEventListener('click',()=>{applyFontSize(resultFontSize+10);});
document.getElementById('fontSizeDown')?.addEventListener('click',()=>{applyFontSize(resultFontSize-10);});

// ── pagination mode ───────────────────────────────────
let pageMode = settings.pageMode || 'continuous'; // 'continuous' | '10' | '20' | '50'
let currentPage = 0;

function getPageSize(){ return pageMode === 'continuous' ? Infinity : parseInt(pageMode); }

// ── toggle לאימות טקסט מהיר ──────────────────────────
document.getElementById('pasteVerifyToggle')?.addEventListener('click',()=>{
    const body=document.getElementById('pasteVerifyBody');
    if(!body)return;
    const open=body.style.display!=='none';
    body.style.display=open?'none':'';
    const hint=document.querySelector('.paste-toggle-hint');
    if(hint)hint.textContent=open?'לחץ להרחבה ▼':'לחץ לסגירה ▲';
});

// ── הצגת דפים ─────────────────────────────────────────
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

// ── טיימר ─────────────────────────────────────────────
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
// חיפוש בתוצאות עצמן
let contentSearchQuery='';

const inputFileEl=document.getElementById('inputFile');
const dbPathEl=document.getElementById('dbPath');
const runButton=document.getElementById('runButton');
const statusEl=document.getElementById('status');
const summaryEl=document.getElementById('summary');
const resultArea=document.getElementById('resultArea');

function getBracketValue(){
    return document.querySelector('input[name="brackets"]:checked')?.value||'curly';
}

// ── אירועים מ-Rust ────────────────────────────────────
listen('compare-result',ev=>{
    const p=ev.payload;if(!p||p.jobId!==activeJobId)return;
    handleResultEvent(p);
});
listen('compare-done',ev=>{
    const p=ev.payload;if(!p||p.jobId!==activeJobId)return;
    onStreamComplete(p.summary||{});
});

// ── Run ───────────────────────────────────────────────
runButton.addEventListener('click',()=>{
    if(isRunning){stopComparison();return;}
    startComparison();
});

// ── הרצה מטקסט מודבק ─────────────────────────────────
document.getElementById('runPasteBtn')?.addEventListener('click',()=>{
    const text=document.getElementById('pasteTextArea')?.value.trim();
    if(!text){setStatus('אנא הדבק טקסט לפני הבדיקה.','error');return;}
    startComparisonFromText(text);
});

function startComparisonFromText(text){
    isRunning=true;
    setStatus('מריץ השוואה על טקסט מודבק...','working');
    summaryEl.style.display='none';
    resultArea.innerHTML='';
    document.getElementById('resultsToolbar')?.remove();
    sortedCache=[];renderedCount=100;lastResults=null;
    filterQuery='';filterStatus='all';contentSearchQuery='';
    currentPage=0;
    startTimer();

    runButton.innerHTML=`<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><rect x="4" y="4" width="12" height="12" rx="2"/></svg> עצור`;
    runButton.classList.add('stop-mode');

    currentDbPath=dbPathEl.value.trim()||settings.defaultDb||'';
    activeJobId=Date.now().toString()+'-'+Math.random().toString(36).slice(2,8);

    const options={
        hebNums:settings.hebNums!==false,abbrev:settings.abbrev!==false,
        fuzzy:settings.fuzzy!==false,sefaria:settings.sefaria!==false,
        brackets:getBracketValue(),
    };

    resultArea.innerHTML='<div class="compare-list" id="streamList"></div>';
    streamStats={total:0,processed:0,found:0,notFound:0};

    // שולח טקסט ישיר — Rust מקבל inputText במקום inputFile
    invoke('compare_start',{
        jobId:activeJobId,
        inputFile:null,
        inputText:text,
        dbPath:currentDbPath||null,
        options,
    }).catch(err=>{
        stopTimer();setStatus('שגיאה: '+(err?.toString()||err),'error');resetRunButton();isRunning=false;
    });
}

function startComparison(){
    const filePath=inputFileEl.value.trim().replace(/^["']+|["']+$/g,'').trim();
    if(!filePath){setStatus('אנא הזן נתיב קובץ מלא.','error');return;}

    isRunning=true;
    setStatus('מריץ השוואה...','working');
    summaryEl.style.display='none';
    resultArea.innerHTML='';
    document.getElementById('resultsToolbar')?.remove();
    sortedCache=[];renderedCount=100;lastResults=null;
    filterQuery='';filterStatus='all';contentSearchQuery='';
    currentPage=0;
    startTimer();

    runButton.innerHTML=`<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><rect x="4" y="4" width="12" height="12" rx="2"/></svg> עצור`;
    runButton.classList.add('stop-mode');

    currentDbPath=dbPathEl.value.trim()||settings.defaultDb||'';
    activeJobId=Date.now().toString()+'-'+Math.random().toString(36).slice(2,8);

    const options={
        hebNums:settings.hebNums!==false,abbrev:settings.abbrev!==false,
        fuzzy:settings.fuzzy!==false,sefaria:settings.sefaria!==false,
        brackets:getBracketValue(),
    };

    resultArea.innerHTML='<div class="compare-list" id="streamList"></div>';
    streamStats={total:0,processed:0,found:0,notFound:0};

    invoke('compare_start',{
        jobId:activeJobId,
        inputFile:filePath,
        dbPath:currentDbPath||null,
        options,
    }).catch(err=>{
        stopTimer();setStatus('שגיאה: '+(err?.toString()||err),'error');resetRunButton();isRunning=false;
    });
}

function handleResultEvent(payload){
    const{idx,result,progress}=payload;
    streamStats={total:progress.total,processed:progress.processed,found:progress.foundCount,notFound:progress.notFoundCount};
    sortedCache[idx]=result;
    setStatus(`מעבד... ${progress.processed}/${progress.total} — נמצאו: ${progress.foundCount} | לא נמצאו: ${progress.notFoundCount}`,'working');
    updateProgressBar(progress.processed,progress.total);
    upsertCard(idx,result);
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

function upsertCard(idx,item){
    const list=document.getElementById('streamList');if(!list)return;
    const html=buildCompareCard(item,idx);
    const existing=document.getElementById('card-'+idx);
    if(existing){
        const tmp=document.createElement('div');tmp.innerHTML=html;
        existing.replaceWith(tmp.firstElementChild);
    }else{
        const div=document.createElement('div');div.innerHTML=html;
        const el=div.firstElementChild;
        list.appendChild(el);
        el?.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
}

function onStreamComplete(summary){
    if(!isRunning&&!summary)return;
    const elapsed=stopTimer();
    isRunning=false;activeJobId=null;
    resetRunButton();
    document.getElementById('progressBar')?.remove();
    if(summary.error){setStatus('שגיאה: '+summary.error,'error');return;}
    const dense=sortedCache.filter(x=>x);
    lastResults=summary;
    const aborted=summary.aborted;
    setStatus(aborted?`הופסק — עובד ${dense.length} הפניות (${elapsed})`:`ההשוואה הסתיימה ✓  (${elapsed})`,aborted?'':'ok');
    renderSummary({...summary,results:dense});
    renderToolbar({...summary,results:dense});
    const rank=x=>(x.rows?.length)?(x.matchType==='exact'?2:1):0;
    sortedCache=[...dense].sort((a,b)=>rank(a)-rank(b));
    renderResults();
    if(!aborted)addHistory({filePath:inputFileEl.value.trim(),dbPath:currentDbPath,
        totalRefs:summary.totalRefs,foundCount:summary.foundCount,
        notFoundCount:summary.notFoundCount,elapsed});
}

async function stopComparison(){
    if(activeJobId){
        try{await invoke('compare_abort',{jobId:activeJobId});}catch{}
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
    const words=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\$&').split(/\s+/).filter(w=>w.length>2);
    if(!words.length)return esc(content);
    return esc(content).replace(new RegExp('('+words.join('|')+')','g'),'<mark class="phrase-hl">$1</mark>');
}
function highlight(text,query){
    if(!query||query.length<2)return esc(text);
    return esc(text).replace(new RegExp('('+query.replace(/[.*+?^${}()|[\]\\]/g,'\$&')+')','gi'),'<mark class="hl">$1</mark>');
}
function highlightContent(text,query){
    // הדגשה בתוך תוכן המאגר (content search)
    if(!query||query.length<2)return text;
    return text.replace(new RegExp('('+query.replace(/[.*+?^${}()|[\]\\]/g,'\$&')+')','gi'),'<mark class="content-hl">$1</mark>');
}
function markRefInSentence(sentence,ref){
    const escaped=ref.replace(/[.*+?^${}()|[\]\\]/g,'\$&');
    return esc(sentence).replace(new RegExp('[{\\[(]'+escaped+'[}\\])]','g'),'<span class="ref-in-sentence">$&</span>');
}
function badgeHtml(mt){
    const labels={exact:'✓ מדויק',prefix:'✓ קידומת',fuzzy:'✓ חלקי',sefaria:'✓ Sefaria 🌐',none:'✗ לא נמצא'};
    const cls={exact:'badge-found',prefix:'badge-partial',fuzzy:'badge-partial',sefaria:'badge-sefaria',none:'badge-missing'};
    const t=mt||'none';
    return`<span class="badge ${cls[t]||'badge-missing'}">${labels[t]||t}</span>`;
}

// ── בניית כרטיס תוצאה ────────────────────────────────
function buildCompareCard(item,idx){
    const badge=badgeHtml(item.matchType);
    const sentenceHtml=item.sentence?markRefInSentence(item.sentence,item.ref):`<span style="color:var(--text-3)">(אין הקשר)</span>`;

    if(!item.rows?.length){
        return`<div class="ccard ccard-missing" id="card-${idx}">
            <div class="ccard-ref-row"><span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>${badge}</div>
            <div class="ccard-cols">
                <div class="ccard-source"><div class="ccard-section-label">📄 מהמקור</div><div class="ccard-sentence">${sentenceHtml}</div></div>
                <div class="ccard-divider"></div>
                <div class="ccard-db ccard-db-missing"><div class="ccard-section-label">🗄 מהמאגר</div><div class="ccard-not-found">לא נמצא</div></div>
            </div>
        </div>`;
    }

    // תוצאה ראשונה גלויה, שאר סגורות
    const dbBlocks=item.rows.map((row,ri)=>{
        const rawContent=row.content||'';
        // הדגש phrase וגם content search
        let contentHtml=highlightPhrase(rawContent,item.quoteBefore);
        if(contentSearchQuery.length>=2){
            contentHtml=highlightContent(contentHtml,contentSearchQuery);
        }

        // תוצאות נוספות (ri>0) — מגיעות סגורות
        const isExtra=ri>0;
        const sefariaLink=row.sefariaUrl?`<a class="sefaria-link" href="${esc(row.sefariaUrl)}" target="_blank" rel="noopener">🔗 פתח ב-Sefaria</a>`:'';
        const expandBtn=item.isBavli&&row.lineId?`<button class="expand-page-btn" data-action="expand-page" data-line-id="${row.lineId}" data-he-ref="${esc(row.heRef)}">📖 הרחב לדף מלא</button>`:'';
        const otzariaBtn=row.lineId&&row.bookTitle?`<button class="otzaria-open-btn" data-action="open-in-otzaria" data-book-title="${esc(row.bookTitle)}" data-line-index="${row.lineIndex??0}" data-book-id="${row.bookId??''}" title="פתח את המקום הזה ישירות באוצריא">📚 פתח באוצריא</button>`:'';
        const typeLabel={exact:'מדויק',prefix:'קידומת',fuzzy:'חלקי',sefaria:'Sefaria'}[row.matchType||item.matchType]||'';

        if(isExtra){
            return`<div class="db-match-extra" id="extra-${idx}-${ri}" style="display:none">
                <div class="db-match-meta">
                    <span class="book-name">${highlight(row.bookTitle,filterQuery)}</span>
                    <span class="db-heref">📌 ${highlight(row.heRef,filterQuery)}</span>
                    <span class="match-label match-${row.matchType||item.matchType}">${typeLabel}</span>
                    ${sefariaLink}
                </div>
                <div class="db-content" dir="rtl">${contentHtml}</div>
                ${expandBtn}
                ${otzariaBtn}
                <div class="page-expand-area" id="page-${idx}-${ri}" style="display:none"></div>
            </div>`;
        }

        return`<div class="db-match">
            <div class="db-match-meta">
                <span class="book-name">${highlight(row.bookTitle,filterQuery)}</span>
                <span class="db-heref">📌 ${highlight(row.heRef,filterQuery)}</span>
                <span class="match-label match-${row.matchType||item.matchType}">${typeLabel}</span>
                ${sefariaLink}
            </div>
            <div class="db-content" dir="rtl">${contentHtml}</div>
            ${expandBtn}
            ${otzariaBtn}
            <div class="page-expand-area" id="page-${idx}-0" style="display:none"></div>
        </div>`;
    }).join('');

    const extraCount=item.rows.length-1;
    const extraBtn=extraCount>0?`<button class="extra-results-btn" data-action="toggle-extra" data-card-idx="${idx}" data-extra-count="${extraCount}">▶ הצג עוד ${extraCount} תוצאות</button>`:'';

    return`<div class="ccard" id="card-${idx}">
        <div class="ccard-ref-row">
            <span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>${badge}
            ${item.rows.length>1?`<span class="multi-count">${item.rows.length} תוצאות</span>`:''}
        </div>
        <div class="ccard-cols">
            <div class="ccard-source"><div class="ccard-section-label">📄 מהמקור</div><div class="ccard-sentence">${sentenceHtml}</div></div>
            <div class="ccard-divider"></div>
            <div class="ccard-db"><div class="ccard-section-label">🗄 מהמאגר</div>${dbBlocks}${extraBtn}</div>
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
            <input id="contentSearchInput" class="filter-input content-search-input" type="text" placeholder="🔍 חפש בתוכן התוצאות..." title="חיפוש בתוכן עצמו (לא רק בשם ההפניה)" />
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
                    <button data-action="export" data-format="csv">CSV</button>
                    <button data-action="export" data-format="txt">טקסט</button>
                </div>
            </div>
        </div>`;
    document.getElementById('resultsToolbar')?.remove();
    resultArea.before(toolbar);

    document.getElementById('filterInput').addEventListener('input',e=>{
        clearTimeout(debounceTimer);
        debounceTimer=setTimeout(()=>{filterQuery=e.target.value.trim();currentPage=0;renderResults();},250);
    });
    document.getElementById('contentSearchInput').addEventListener('input',e=>{
        clearTimeout(debounceTimer);
        debounceTimer=setTimeout(()=>{contentSearchQuery=e.target.value.trim();currentPage=0;renderResults();},250);
    });
    toolbar.querySelectorAll('.filter-tab').forEach(btn=>btn.addEventListener('click',()=>{
        toolbar.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');filterStatus=btn.dataset.status;currentPage=0;renderResults();
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
    const q=filterQuery.toLowerCase();
    const cq=contentSearchQuery.toLowerCase();
    return sortedCache.filter(item=>{
        const found=item.rows?.length>0;
        if(filterStatus==='found'&&!found)return false;
        if(filterStatus==='missing'&&found)return false;
        // סינון לפי שם הפניה/ספר
        let passName=true;
        if(q){
            passName=item.ref.toLowerCase().includes(q)||
               item.sentence?.toLowerCase().includes(q)||
               item.rows?.some(r=>(r.bookTitle||'').toLowerCase().includes(q)||(r.heRef||'').toLowerCase().includes(q));
        }
        // סינון לפי תוכן (content search)
        let passContent=true;
        if(cq){
            passContent=item.rows?.some(r=>(r.content||'').toLowerCase().includes(cq))||
                        item.sentence?.toLowerCase().includes(cq)||
                        item.ref.toLowerCase().includes(cq);
        }
        return passName&&passContent;
    });
}

function renderResults(){
    if(!sortedCache?.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔍</div><div>לא נמצאו הפניות.</div></div>`;return;}
    const filtered=getFilteredResults();
    if(!filtered.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔎</div><div>אין תוצאות.</div></div>`;return;}

    const ps=getPageSize();
    if(ps===Infinity){
        // רציף
        const chunk=filtered.slice(0,renderedCount);
        const hasMore=filtered.length>renderedCount;
        const cards=chunk.map((item,idx)=>buildCompareCard(item,idx)).join('');
        const moreBtn=hasMore?`<div class="load-more-wrap"><button class="expand-btn" data-action="load-more">▼ הצג עוד (${filtered.length-chunk.length} נוספות)</button></div>`:'';
        resultArea.innerHTML=`<div class="compare-list">${cards}${moreBtn}</div>`;
    } else {
        // pagination
        const totalPages=Math.ceil(filtered.length/ps);
        const safePage=Math.min(currentPage,totalPages-1);
        const start=safePage*ps;
        const chunk=filtered.slice(start,start+ps);
        const cards=chunk.map((item,idx)=>buildCompareCard(item,start+idx)).join('');
        const pagerHtml=buildPager(safePage,totalPages,filtered.length);
        resultArea.innerHTML=`<div class="compare-list">${cards}</div>${pagerHtml}`;
        resultArea.scrollIntoView({behavior:'smooth',block:'start'});
    }
}

function buildPager(page,total,count){
    if(total<=1)return'';
    let btns='';
    btns+=`<button class="pager-btn${page===0?' pager-active':''}" data-action="go-page" data-page="0">1</button>`;
    if(page>2)btns+=`<span class="pager-ellipsis">…</span>`;
    for(let i=Math.max(1,page-1);i<=Math.min(total-2,page+1);i++){
        btns+=`<button class="pager-btn${i===page?' pager-active':''}" data-action="go-page" data-page="${i}">${i+1}</button>`;
    }
    if(page<total-3)btns+=`<span class="pager-ellipsis">…</span>`;
    if(total>1)btns+=`<button class="pager-btn${page===total-1?' pager-active':''}" data-action="go-page" data-page="${total-1}">${total}</button>`;
    return`<div class="pager">
        <button class="pager-btn" data-action="go-page" data-page="${Math.max(0,page-1)}" ${page===0?'disabled':''}>‹ הקודם</button>
        ${btns}
        <button class="pager-btn" data-action="go-page" data-page="${Math.min(total-1,page+1)}" ${page===total-1?'disabled':''}>הבא ›</button>
        <span class="pager-info">${count} תוצאות</span>
    </div>`;
}

function loadMore(){renderedCount+=100;renderResults();}

// ── Talmud page expand ────────────────────────────────
async function expandTalmudPage(lineId,heRef,btn){
    const area=btn.nextElementSibling;if(!area)return;
    if(area.style.display!=='none'){area.style.display='none';btn.textContent='📖 הרחב לדף מלא';return;}
    btn.disabled=true;btn.textContent='טוען...';
    try{
        const lines=await invoke('expand_page',{lineId,dbPath:currentDbPath||null});
        if(!lines?.length)throw new Error('לא נמצא');

        // מציג רק 2 שורות סביב ה-focus, עם אפשרות לפתוח הכל
        const focusIdx=lines.findIndex(l=>l.isFocus);
        const previewStart=Math.max(0,focusIdx-1);
        const previewLines=lines.slice(previewStart,previewStart+3);

        const makeLineHtml=(l)=>`<div class="page-line${l.isFocus?' page-line-focus':''}">
            <span class="page-line-ref">${esc(l.heRef||'')}</span>
            <span class="page-line-content">${l.isFocus?`<mark class="focus-mark">${esc(l.content)}</mark>`:esc(l.content)}</span>
        </div>`;

        const previewHtml=previewLines.map(makeLineHtml).join('');
        const fullHtml=lines.map(makeLineHtml).join('');
        const hiddenFull=lines.length>3;

        area.innerHTML=`<div class="page-expand">
            <div class="page-expand-header"><span>📖 ${esc(heRef)}</span>
                <button class="page-expand-close" data-action="close-page-expand">✕</button>
            </div>
            <div class="page-lines" dir="rtl" id="page-preview-${lineId}">${previewHtml}</div>
            ${hiddenFull?`<div class="page-lines page-lines-full" dir="rtl" id="page-full-${lineId}" style="display:none">${fullHtml}</div>
            <button class="expand-full-btn" data-action="toggle-full-page" data-line-id="${lineId}">▼ הצג דף מלא (${lines.length} שורות)</button>`:''}
        </div>`;
        area.style.display='';
        area.scrollIntoView({behavior:'smooth',block:'nearest'});
        btn.textContent='▲ סגור דף';
    }catch(err){
        area.innerHTML=`<div style="color:var(--red);padding:8px">שגיאה: ${esc(err?.toString()||err)}</div>`;
        area.style.display='';btn.textContent='📖 הרחב לדף מלא';
    }finally{btn.disabled=false;}
}

// ── Browse file ───────────────────────────────────────
async function browseFile(type){
    try{
        const filter=(type==='db'||type==='db-settings')?'db':'txt';
        const path=await invoke('pick_file',{filter});
        if(!path)return;
        if(type==='txt'){document.getElementById('inputFile').value=path;localStorage.setItem('bm_inputFile',path);}
        else if(type==='db'){document.getElementById('dbPath').value=path;localStorage.setItem('bm_dbPath',path);}
        else if(type==='db-settings'){document.getElementById('settingsDbPath').value=path;}
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
        content='﻿'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
        filename='compare_sources.csv';mime='text/csv;charset=utf-8';
    }else{
        const lines=['דוח בודק מקורות','='.repeat(50),''];
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
                <button class="history-load-btn" data-action="load-history" data-index="${i}">טען שוב</button>
            </div>
        </div>`;
    }).join('')}</div>`;
}
function loadFromHistory(idx){
    const h=loadHistory()[idx];if(!h)return;
    const ie=document.getElementById('inputFile');const de=document.getElementById('dbPath');
    if(ie){ie.value=h.filePath;localStorage.setItem('bm_inputFile',h.filePath);}
    if(de&&h.dbPath){de.value=h.dbPath;localStorage.setItem('bm_dbPath',h.dbPath);}
    showPage('compare');
}
document.getElementById('clearHistoryBtn')?.addEventListener('click',()=>{
    if(confirm('למחוק את כל ההיסטוריה?')){localStorage.removeItem('bm_history');renderHistory();}
});

// ── Settings ──────────────────────────────────────────
function loadSettingsUI(){
    const s=loadSettings();
    const dbEl=document.getElementById('settingsDbPath');if(dbEl)dbEl.value=s.defaultDb||'';
    const opts={'opt-hebnums':'hebNums','opt-abbrev':'abbrev','opt-fuzzy':'fuzzy','opt-sefaria':'sefaria','opt-history':'saveHistory'};
    Object.entries(opts).forEach(([id,key])=>{const el=document.getElementById(id);if(el)el.checked=s[key]!==false;});
    // light mode
    const lm=document.getElementById('opt-light-mode');if(lm)lm.checked=!!s.lightMode;
    // font size
    applyFontSize(s.resultFontSize||100);
    // page mode
    const pm=document.getElementById('opt-page-mode');if(pm)pm.value=s.pageMode||'continuous';
}

document.getElementById('saveSettingsBtn')?.addEventListener('click',()=>{
    const dbEl=document.getElementById('settingsDbPath');
    const opts={'opt-hebnums':'hebNums','opt-abbrev':'abbrev','opt-fuzzy':'fuzzy','opt-sefaria':'sefaria','opt-history':'saveHistory'};
    const ns={defaultDb:dbEl?.value.trim()||''};
    Object.entries(opts).forEach(([id,key])=>{const el=document.getElementById(id);ns[key]=el?el.checked:true;});
    // light mode
    const lm=document.getElementById('opt-light-mode');
    ns.lightMode=lm?lm.checked:false;
    applyTheme(ns.lightMode);
    // font size
    ns.resultFontSize=resultFontSize;
    // page mode
    const pm=document.getElementById('opt-page-mode');
    ns.pageMode=pm?pm.value:'continuous';
    pageMode=ns.pageMode;

    saveSettings(ns);settings=ns;
    const saved=document.getElementById('settingsSaved');
    if(saved){saved.style.display='flex';setTimeout(()=>saved.style.display='none',2500);}
});

// ── האזנה גלובלית מואצלת (delegation) ───────────────
document.addEventListener('click',(e)=>{
    const el=e.target.closest('[data-action]');
    if(!el)return;
    const action=el.dataset.action;

    if(action==='browse'){
        browseFile(el.dataset.type);

    }else if(action==='expand-page'){
        expandTalmudPage(Number(el.dataset.lineId),el.dataset.heRef,el);

    }else if(action==='toggle-full-page'){
        const lid=el.dataset.lineId;
        const preview=document.getElementById('page-preview-'+lid);
        const full=document.getElementById('page-full-'+lid);
        if(!full)return;
        const open=full.style.display!=='none';
        if(preview)preview.style.display=open?'':'none';
        full.style.display=open?'none':'';
        el.textContent=open?`▼ הצג דף מלא`:`▲ סגור דף מלא`;

    }else if(action==='toggle-extra'){
        const cardIdx=el.dataset.cardIdx;
        const count=parseInt(el.dataset.extraCount);
        const open=el.dataset.open==='1';
        for(let i=1;i<=count;i++){
            const extraEl=document.getElementById(`extra-${cardIdx}-${i}`);
            if(extraEl)extraEl.style.display=open?'none':'';
        }
        el.dataset.open=open?'0':'1';
        el.textContent=open?`▶ הצג עוד ${count} תוצאות`:`▲ הסתר תוצאות נוספות`;

    }else if(action==='open-in-otzaria'){
        const btn=el;
        const orig=btn.textContent;
        btn.textContent='⏳ פותח...';
        btn.disabled=true;
        invoke('open_in_otzaria',{
            bookTitle:btn.dataset.bookTitle,
            lineIndex:Number(btn.dataset.lineIndex),
            bookId:btn.dataset.bookId?Number(btn.dataset.bookId):null,
            dbPath:document.getElementById('dbPath')?.value.trim()||null
        }).then(()=>{
            btn.textContent='✅ נפתח!';
            setTimeout(()=>{btn.textContent=orig;btn.disabled=false;},2000);
        }).catch(err=>{
            btn.textContent=orig;
            btn.disabled=false;
            alert('שגיאה בפתיחת אוצריא:\n'+err);
        });

    }else if(action==='close-page-expand'){
        const area=el.closest('.page-expand-area');
        if(area)area.style.display='none';
        const expandBtn=el.closest('.db-match,.db-match-extra')?.querySelector('.expand-page-btn');
        if(expandBtn)expandBtn.textContent='📖 הרחב לדף מלא';

    }else if(action==='export'){
        exportData(el.dataset.format);

    }else if(action==='load-more'){
        loadMore();

    }else if(action==='go-page'){
        currentPage=parseInt(el.dataset.page);
        renderResults();

    }else if(action==='load-history'){
        loadFromHistory(Number(el.dataset.index));
    }
});

loadSettingsUI();
