const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ════════════════════════════════════════════════════════════════════
//  🔍 מודול חיפוש חכם — קיצורים, וריאציות, ציון ביטחון
// ════════════════════════════════════════════════════════════════════

const ABBREV_MAP = {
    // ש"ס בבלי
    'ב"ק': 'בבא קמא', "ב'ק": 'בבא קמא',
    'ב"מ': 'בבא מציעא', "ב'מ": 'בבא מציעא',
    'ב"ב': 'בבא בתרא', "ב'ב": 'בבא בתרא',
    'ר"ה': 'ראש השנה',
    'מו"ק': 'מועד קטן',
    'ע"ז': 'עבודה זרה',
    // שו"ע
    'או"ח': 'אורח חיים', "אוח": 'אורח חיים',
    'יו"ד': 'יורה דעה',
    'אה"ע': 'אבן העזר', 'אבה"ע': 'אבן העזר',
    'חו"מ': 'חושן משפט',
    // מדרש רבה
    'ב"ר': 'בראשית רבה', 'בר"ר': 'בראשית רבה',
    'שמ"ר': 'שמות רבה',
    'ויק"ר': 'ויקרא רבה',
    'במ"ר': 'במדבר רבה', 'במד"ר': 'במדבר רבה',
    'דב"ר': 'דברים רבה',
    'שה"ש': 'שיר השירים', 'שה"ש רבה': 'שיר השירים רבה',
    'אי"ר': 'איכה רבה',
    'קה"ר': 'קהלת רבה',
    'אס"ר': 'אסתר רבה',
    // קיצורי שם בסוף (גרש)
    "ברכ'": 'ברכות', "שב'": 'שבת', "עירו'": 'עירובין',
    "פסח'": 'פסחים', "תענ'": 'תענית', "מגיל'": 'מגילה',
    "חגיג'": 'חגיגה', "יבמ'": 'יבמות', "כתוב'": 'כתובות',
    "נדר'": 'נדרים', "גיט'": 'גיטין', "קיד'": 'קידושין',
    "סנה'": 'סנהדרין', "שבוע'": 'שבועות', "זבח'": 'זבחים',
    "מנח'": 'מנחות', "חול'": 'חולין', "בכור'": 'בכורות',
    "כרית'": 'כריתות',
    // רמב"ם
    'רמב"ם': 'רמב"ם', 'רמבם': 'רמב"ם',
    // ישעיהו/ירמיהו קיצור
    "ישעיה": 'ישעיהו', "ירמיה": 'ירמיהו',
};

// מילון וריאציות כתיב נפוצות
const SPELLING_VARIANTS = {
    'שבת': ['שבת', 'שַׁבָּת'],
    'ברכות': ['ברכות', 'ברכת'],
    'סנהדרין': ['סנהדרין', 'סנהדרן'],
    'פסחים': ['פסחים', 'פסחין'],
    'תהלים': ['תהלים', 'תהילים'],
    'ישעיהו': ['ישעיהו', 'ישעיה'],
    'ירמיהו': ['ירמיהו', 'ירמיה'],
};

/**
 * מרחיב שאילתת חיפוש: מפתח קיצורים, מוסיף וריאציות כתיב.
 * מחזיר מערך של כל הצורות שיש לחפש.
 */
function expandSearchQuery(q) {
    const forms = new Set();
    const base = q.trim();
    forms.add(base);
    forms.add(base.toLowerCase());

    // פתח קיצורים ידועים
    for (const [abbr, full] of Object.entries(ABBREV_MAP)) {
        if (base.includes(abbr)) {
            forms.add(base.replace(abbr, full));
            forms.add(full);
        }
        // גם הפוך: אם מחפשים שם מלא, הוסף קיצור
        if (base.includes(full)) {
            forms.add(base.replace(full, abbr));
        }
    }

    // וריאציות כתיב
    for (const [canonical, variants] of Object.entries(SPELLING_VARIANTS)) {
        for (const v of variants) {
            if (base.includes(v)) {
                for (const other of variants) {
                    forms.add(base.replace(v, other));
                }
            }
        }
    }

    // נרמול: הסר ניקוד, גרשיים מיותרים
    forms.add(base.replace(/[\u0591-\u05C7]/g, '')); // ניקוד
    forms.add(base.replace(/['"״׳]/g, ''));

    return [...forms].filter(Boolean);
}

/**
 * חיפוש חכם: בודק אם item תואם לשאילתה, כולל קיצורים ווריאציות.
 * מחזיר ציון 0–1 (0 = לא נמצא, 1 = התאמה מושלמת).
 */
function smartSearchScore(item, query) {
    if (!query || query.length < 2) return 1;
    const forms = expandSearchQuery(query.toLowerCase());

    const textFields = [
        item.ref || '',
        item.sentence || '',
        ...(item.rows || []).map(r => (r.bookTitle || '') + ' ' + (r.heRef || '') + ' ' + (r.content || '')),
    ].join(' ').toLowerCase();

    for (const form of forms) {
        if (textFields.includes(form)) {
            // ציון לפי עדיפות: התאמה ישירה לשם ההפניה = 1.0, לשאר = 0.7
            if ((item.ref || '').toLowerCase().includes(form)) return 1.0;
            return 0.7;
        }
    }
    return 0;
}

/**
 * חישוב ציון ביטחון (confidence) לתוצאה — 0–100
 */
function calcConfidence(item) {
    if (!item.rows?.length) return 0;
    const mt = item.matchType;
    const baseScore = { exact: 95, prefix: 72, fuzzy: 45, sefaria: 60, none: 0 }[mt] ?? 0;
    if (baseScore === 0) return 0;
    // בונוס אם יש יותר מתוצאה אחת (מעיד על מקור מוכר היטב)
    const multiBonus = Math.min(item.rows.length - 1, 3) * 1.5;
    return Math.min(100, Math.round(baseScore + multiBonus));
}

/**
 * מחזיר צבע/תווית לציון הביטחון
 */
function confidenceMeta(score) {
    if (score >= 90) return { cls: 'conf-high', label: score + '%' };
    if (score >= 60) return { cls: 'conf-mid',  label: score + '%' };
    if (score >  0)  return { cls: 'conf-low',  label: score + '%' };
    return { cls: 'conf-none', label: '—' };
}

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
    document.documentElement.classList.toggle('light-mode', !!light);
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
    ['compare','history','biblio','aieditor','summarizer','about','settings'].forEach(p=>{
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
        minCharCount:settings.minCharCount||0,
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
        minCharCount:settings.minCharCount||0,
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
    const labels={exact:'✓ מדויק',prefix:'≈ קידומת',fuzzy:'~ חלקי',sefaria:'🌐 Sefaria',none:'✗ לא נמצא'};
    const titles={
        exact:'התאמה מדויקת ל-he_ref במאגר',
        prefix:'התאמה לפי קידומת (מכסה את הדף/פרק)',
        fuzzy:'התאמה חלקית / FTS',
        sefaria:'נמצא דרך Sefaria.org',
        none:'לא נמצאה התאמה במאגר ובSefaria'
    };
    const cls={exact:'badge-found',prefix:'badge-partial',fuzzy:'badge-partial',sefaria:'badge-sefaria',none:'badge-missing'};
    const t=mt||'none';
    return`<span class="badge ${cls[t]||'badge-missing'}" title="${titles[t]||''}">${labels[t]||t}</span>`;
}

// ── בניית כרטיס תוצאה ────────────────────────────────
function buildCompareCard(item,idx){
    const badge=badgeHtml(item.matchType);
    const confidence=calcConfidence(item);
    const confMeta=confidenceMeta(confidence);
    const confBadge=`<span class="conf-badge ${confMeta.cls}" title="ציון ביטחון: ${confMeta.label}">🎯 ${confMeta.label}</span>`;
    const sentenceHtml=item.sentence?markRefInSentence(item.sentence,item.ref):`<span style="color:var(--text-3)">(אין הקשר)</span>`;

    if(!item.rows?.length){
        return`<div class="ccard ccard-missing" id="card-${idx}">
            <div class="ccard-ref-row">
                <span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>${badge}${confBadge}
            </div>
            <div class="ccard-cols">
                <div class="ccard-source"><div class="ccard-section-label">📄 מהמקור</div><div class="ccard-sentence">${sentenceHtml}</div></div>
                <div class="ccard-divider"></div>
                <div class="ccard-db ccard-db-missing">
                    <div class="ccard-section-label">🗄 מהמאגר</div>
                    <div class="ccard-not-found">לא נמצא</div>
                    <div class="missing-hint">💡 נסה: <a href="#" class="missing-sefaria-link" data-ref="${esc(item.ref)}" target="_blank">חפש ב-Sefaria</a></div>
                </div>
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
        // הדגש גם את מילות החיפוש של הפילטר בתוכן
        if(filterQuery.length>=2){
            const fqForms=expandSearchQuery(filterQuery);
            for(const form of fqForms){
                if(form.length>=2)contentHtml=highlightContent(contentHtml,form);
            }
        }

        // תוצאות נוספות (ri>0) — מגיעות סגורות
        const isExtra=ri>0;
        const sefariaLink=row.sefariaUrl?`<a class="sefaria-link" href="${esc(row.sefariaUrl)}" target="_blank" rel="noopener">🔗 Sefaria</a>`:'';
        const expandBtn=item.isBavli&&row.lineId?`<button class="expand-page-btn" data-action="expand-page" data-line-id="${row.lineId}" data-he-ref="${esc(row.heRef)}">📖 דף מלא</button>`:'';
        const otzariaBtn=row.lineId&&row.bookTitle?`<button class="otzaria-open-btn" data-action="open-in-otzaria" data-book-title="${esc(row.bookTitle)}" data-line-index="${row.lineIndex??0}" data-book-id="${row.bookId??''}" title="פתח ישירות באוצריא">📚 אוצריא</button>`:'';
        const copyBtn=`<button class="copy-citation-btn" data-action="copy-citation" data-ref="${esc(item.ref)}" data-book="${esc(row.bookTitle)}" data-heref="${esc(row.heRef)}" data-content="${esc((rawContent||'').substring(0,200))}" title="העתק ציטוט">📋</button>`;
        const typeLabel={exact:'מדויק',prefix:'קידומת',fuzzy:'חלקי',sefaria:'Sefaria'}[row.matchType||item.matchType]||'';

        if(isExtra){
            return`<div class="db-match-extra" id="extra-${idx}-${ri}" style="display:none">
                <div class="db-match-meta">
                    <span class="book-name">${highlight(row.bookTitle,filterQuery)}</span>
                    <span class="db-heref">📌 ${highlight(row.heRef,filterQuery)}</span>
                    <span class="match-label match-${row.matchType||item.matchType}">${typeLabel}</span>
                    <div class="db-match-actions">${sefariaLink}${expandBtn}${otzariaBtn}${copyBtn}</div>
                </div>
                <div class="db-content" dir="rtl">${contentHtml}</div>
                <div class="page-expand-area" id="page-${idx}-${ri}" style="display:none"></div>
            </div>`;
        }

        return`<div class="db-match">
            <div class="db-match-meta">
                <span class="book-name">${highlight(row.bookTitle,filterQuery)}</span>
                <span class="db-heref">📌 ${highlight(row.heRef,filterQuery)}</span>
                <span class="match-label match-${row.matchType||item.matchType}">${typeLabel}</span>
                <div class="db-match-actions">${sefariaLink}${expandBtn}${otzariaBtn}${copyBtn}</div>
            </div>
            <div class="db-content" dir="rtl">${contentHtml}</div>
            <div class="page-expand-area" id="page-${idx}-0" style="display:none"></div>
        </div>`;
    }).join('');

    const extraCount=item.rows.length-1;
    const extraBtn=extraCount>0?`<button class="extra-results-btn" data-action="toggle-extra" data-card-idx="${idx}" data-extra-count="${extraCount}">▶ עוד ${extraCount} תוצאות</button>`:'';

    return`<div class="ccard" id="card-${idx}">
        <div class="ccard-ref-row">
            <span class="ccard-ref">${highlight(item.ref,filterQuery)}</span>
            <div class="ccard-badges">${badge}${confBadge}${item.rows.length>1?`<span class="multi-count">${item.rows.length} תוצאות</span>`:''}</div>
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
// מיון תוצאות
let sortMode = 'default'; // 'default' | 'confidence-desc' | 'confidence-asc' | 'alpha'

function getSortedFiltered(){
    const filtered = getFilteredResults();
    if(sortMode==='confidence-desc') return [...filtered].sort((a,b)=>calcConfidence(b)-calcConfidence(a));
    if(sortMode==='confidence-asc')  return [...filtered].sort((a,b)=>calcConfidence(a)-calcConfidence(b));
    if(sortMode==='alpha') return [...filtered].sort((a,b)=>(a.ref||'').localeCompare(b.ref||'','he'));
    return filtered; // default: סדר הזנה (exact ראשון)
}

function renderToolbar(r){
    const toolbar=document.createElement('div');
    toolbar.id='resultsToolbar';toolbar.className='results-toolbar';
    toolbar.innerHTML=`
        <div class="toolbar-right">
            <input id="filterInput" class="filter-input" type="text" placeholder='חפש: ב"ק, ישעיה, או"ח...' title="חיפוש חכם: מזהה קיצורים ווריאציות כתיב. קיצור Ctrl+F" />
            <input id="contentSearchInput" class="filter-input content-search-input" type="text" placeholder="🔍 חפש בתוכן..." title="חיפוש בתוכן המאגר עצמו. קיצור Ctrl+G" />
            <div class="filter-tabs">
                <button class="filter-tab active" data-status="all">הכל <span class="tab-count">${r.results.length}</span></button>
                <button class="filter-tab" data-status="found">נמצאו <span class="tab-count s-found">${r.foundCount}</span></button>
                <button class="filter-tab" data-status="missing">לא נמצאו <span class="tab-count s-missing">${r.notFoundCount}</span></button>
            </div>
        </div>
        <div class="toolbar-left">
            <select id="sortModeSelect" class="field-input sort-select" title="מיון תוצאות">
                <option value="default">מיון: ברירת מחדל</option>
                <option value="confidence-desc">מיון: ביטחון גבוה→נמוך</option>
                <option value="confidence-asc">מיון: ביטחון נמוך→גבוה</option>
                <option value="alpha">מיון: א-ב</option>
            </select>
            <div class="export-wrap">
                <button class="export-btn" id="exportBtn">↓ ייצוא</button>
                <div class="export-menu" id="exportMenu" style="display:none">
                    <button data-action="export" data-format="csv">CSV</button>
                    <button data-action="export" data-format="txt">טקסט</button>
                    <button data-action="export" data-format="json">JSON</button>
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
    document.getElementById('sortModeSelect').addEventListener('change',e=>{
        sortMode=e.target.value;currentPage=0;renderResults();
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
        // חיפוש חכם — כולל קיצורים ווריאציות כתיב
        let passName=true;
        if(q){
            passName = smartSearchScore(item, q) > 0;
        }
        // סינון לפי תוכן (content search) — גם עם חיפוש חכם
        let passContent=true;
        if(cq){
            const cqForms = expandSearchQuery(cq);
            passContent = cqForms.some(form =>
                item.rows?.some(r=>(r.content||'').toLowerCase().includes(form)) ||
                item.sentence?.toLowerCase().includes(form) ||
                item.ref.toLowerCase().includes(form)
            );
        }
        return passName&&passContent;
    });
}

function renderResults(){
    if(!sortedCache?.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔍</div><div>לא נמצאו הפניות.</div></div>`;return;}
    const filtered=getSortedFiltered();
    if(!filtered.length){resultArea.innerHTML=`<div class="empty-state"><div class="empty-icon">🔎</div><div>אין תוצאות — נסה מונח אחר או בדוק קיצורים.</div></div>`;return;}

    const ps=getPageSize();
    if(ps===Infinity){
        const chunk=filtered.slice(0,renderedCount);
        const hasMore=filtered.length>renderedCount;
        const cards=chunk.map((item,idx)=>buildCompareCard(item,idx)).join('');
        const moreBtn=hasMore?`<div class="load-more-wrap"><button class="expand-btn" data-action="load-more">▼ הצג עוד (${filtered.length-chunk.length} נוספות)</button></div>`:'';
        resultArea.innerHTML=`<div class="compare-list">${cards}${moreBtn}</div>`;
    } else {
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

// ── קיצורי מקלדת ─────────────────────────────────────
document.addEventListener('keydown',e=>{
    // Ctrl+F → פוקוס על שדה חיפוש הפניות
    if((e.ctrlKey||e.metaKey)&&e.key==='f'){
        const fi=document.getElementById('filterInput');
        if(fi){e.preventDefault();fi.focus();fi.select();}
    }
    // Ctrl+G → פוקוס על חיפוש תוכן
    if((e.ctrlKey||e.metaKey)&&e.key==='g'){
        const ci=document.getElementById('contentSearchInput');
        if(ci){e.preventDefault();ci.focus();ci.select();}
    }
    // Escape → נקה חיפוש
    if(e.key==='Escape'){
        const fi=document.getElementById('filterInput');
        const ci=document.getElementById('contentSearchInput');
        if(document.activeElement===fi){fi.value='';filterQuery='';renderResults();fi.blur();}
        else if(document.activeElement===ci){ci.value='';contentSearchQuery='';renderResults();ci.blur();}
    }
});

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
    const filtered=getSortedFiltered();
    let content,filename,mime;
    if(format==='csv'){
        const rows=[['הפניה','הקשר','סטטוס','ציון ביטחון','ספר','הפניה ב-DB','תוכן']];
        filtered.forEach(item=>{
            const conf=calcConfidence(item);
            if(!item.rows?.length)rows.push([item.ref,item.sentence||'','לא נמצא','0','','','']);
            else item.rows.forEach(r=>rows.push([item.ref,item.sentence||'',item.matchType,conf+'%',r.bookTitle,r.heRef,(r.content||'').substring(0,200)]));
        });
        content='﻿'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
        filename='compare_sources.csv';mime='text/csv;charset=utf-8';
    }else if(format==='json'){
        const data=filtered.map(item=>({
            ref:item.ref,
            matchType:item.matchType,
            confidence:calcConfidence(item),
            sentence:item.sentence||'',
            results:(item.rows||[]).map(r=>({
                bookTitle:r.bookTitle,heRef:r.heRef,
                matchType:r.matchType,
                content:(r.content||'').substring(0,300),
                sefariaUrl:r.sefariaUrl||null,
            })),
        }));
        content=JSON.stringify({exportedAt:new Date().toISOString(),totalRefs:data.length,results:data},null,2);
        filename='compare_sources.json';mime='application/json;charset=utf-8';
    }else{
        const lines=['דוח בודק מקורות','='.repeat(50),''];
        filtered.forEach(item=>{
            const conf=calcConfidence(item);
            lines.push('─'.repeat(50),'הפניה: '+item.ref+(conf>0?' [ביטחון: '+conf+'%]':''));
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
    const lm=document.getElementById('opt-light-mode');if(lm)lm.checked=!!s.lightMode;
    applyFontSize(s.resultFontSize||100);
    const pm=document.getElementById('opt-page-mode');if(pm)pm.value=s.pageMode||'continuous';
    const mc=document.getElementById('opt-min-char-count');if(mc)mc.value=s.minCharCount||0;
}

document.getElementById('saveSettingsBtn')?.addEventListener('click',()=>{
    const dbEl=document.getElementById('settingsDbPath');
    const opts={'opt-hebnums':'hebNums','opt-abbrev':'abbrev','opt-fuzzy':'fuzzy','opt-sefaria':'sefaria','opt-history':'saveHistory'};
    const ns={defaultDb:dbEl?.value.trim()||''};
    Object.entries(opts).forEach(([id,key])=>{const el=document.getElementById(id);ns[key]=el?el.checked:true;});
    const lm=document.getElementById('opt-light-mode');
    ns.lightMode=lm?lm.checked:false;
    applyTheme(ns.lightMode);
    ns.resultFontSize=resultFontSize;
    const pm=document.getElementById('opt-page-mode');
    ns.pageMode=pm?pm.value:'continuous';
    pageMode=ns.pageMode;
    // minCharCount — סינון שורות קצרות (כותרות)
    const mc=document.getElementById('opt-min-char-count');
    ns.minCharCount=mc?Math.max(0,parseInt(mc.value)||0):0;

    saveSettings(ns);settings=ns;
    const saved=document.getElementById('settingsSaved');
    if(saved){saved.style.display='flex';setTimeout(()=>saved.style.display='none',2500);}
    // רענון תוצאות שכבר מוצגות (אם יש) — כדי שהעימוד/מצב יום ישתקפו מיד
    // בלי לחייב הרצת השוואה מחדש. בלי זה, ה-DOM נשאר במצב הרינדור
    // הקודם (למשל: גלילה אינסופית) עד שמשהו אחר יגרום ל-renderResults.
    currentPage=0;
    if(typeof sortedCache!=='undefined'&&sortedCache?.length){renderResults();}
});

// ── האזנה גלובלית מואצלת (delegation) ───────────────
document.addEventListener('click',(e)=>{
    const el=e.target.closest('[data-action]');
    if(!el)return;
    const action=el.dataset.action;

    if(action==='browse'){
        browseFile(el.dataset.type);

    }else if(action==='biblio-browse'){
        document.getElementById('biblioFileInput')?.click();

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

    }else if(action==='copy-citation'){
        // העתק ציטוט מעוצב: "שם הפניה (ספר, he_ref): תוכן..."
        const ref=el.dataset.ref||'';
        const book=el.dataset.book||'';
        const heref=el.dataset.heref||'';
        const content=el.dataset.content||'';
        const citation=`${ref} (${book}${heref&&heref!==ref?', '+heref:''})${content?': '+content:''}`;
        navigator.clipboard.writeText(citation).then(()=>{
            const orig=el.textContent;
            el.textContent='✅';
            setTimeout(()=>{el.textContent=orig;},1500);
        }).catch(()=>{
            // fallback
            const ta=document.createElement('textarea');
            ta.value=citation;document.body.appendChild(ta);ta.select();
            document.execCommand('copy');document.body.removeChild(ta);
            const orig=el.textContent;el.textContent='✅';
            setTimeout(()=>{el.textContent=orig;},1500);
        });

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

// ════════════════════════════════════════════════════════════════════════════
//  🔍 Spotlight — חיפוש גלובלי באוצריא (Ctrl+K)
// ════════════════════════════════════════════════════════════════════════════

(function initOtzariaSpotlight() {
    const overlay   = document.getElementById('otzSpotlightOverlay');
    const input     = document.getElementById('otzSpotlightInput');
    const statusEl  = document.getElementById('otzSpotlightStatus');
    const resultsEl = document.getElementById('otzSpotlightResults');
    const trigger   = document.getElementById('otzSpotlightTrigger');

    let searchTimer = null;
    let activeIdx   = -1;
    let lastResults = [];
    let isSearching = false;

    function openSpotlight() {
        overlay.style.display = 'flex';
        input.focus();
        input.select();
    }
    function closeSpotlight() {
        overlay.style.display = 'none';
        activeIdx = -1;
    }

    // פתיחה: כפתור / Ctrl+K
    trigger?.addEventListener('click', openSpotlight);
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSpotlight(); }
        if (e.key === 'Escape' && overlay.style.display !== 'none') closeSpotlight();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSpotlight(); });

    // ניווט ↑↓ + Enter בשדה החיפוש
    input.addEventListener('keydown', e => {
        const cards = resultsEl.querySelectorAll('.otz-result-card');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, cards.length - 1);
            updateActive(cards);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, -1);
            updateActive(cards);
        } else if (e.key === 'Enter') {
            if (activeIdx >= 0 && cards[activeIdx]) {
                // Enter על תוצאה מסומנת → פתח באוצריא
                cards[activeIdx].querySelector('.otzaria-open-btn')?.click();
            } else {
                doSearch(input.value.trim());
            }
        }
    });

    function updateActive(cards) {
        cards.forEach((c, i) => c.classList.toggle('otz-card-active', i === activeIdx));
        if (activeIdx >= 0) cards[activeIdx]?.scrollIntoView({ block: 'nearest' });
    }

    // חיפוש עם debounce (400ms אחרי עצירת הקלדה)
    input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = input.value.trim();
        if (!q) { resultsEl.innerHTML = ''; statusEl.style.display = 'none'; return; }
        if (q.length < 2) return;
        searchTimer = setTimeout(() => doSearch(q), 400);
    });

    async function doSearch(q) {
        if (!q || isSearching) return;
        isSearching = true;
        activeIdx = -1;

        const dbPath = document.getElementById('dbPath')?.value.trim() || settings?.defaultDb || null;
        const limit  = 50;

        statusEl.style.display = '';
        statusEl.className = 'otz-status working';
        statusEl.textContent = `מחפש "${q}"...`;
        resultsEl.innerHTML = '';

        try {
            const rows = await invoke('fts_search', { query: q, dbPath: dbPath || null, limit });
            lastResults = rows;

            if (!rows.length) {
                statusEl.className = 'otz-status';
                statusEl.textContent = `לא נמצאו תוצאות עבור "${q}"`;
                resultsEl.innerHTML = `<div class="otz-empty">🔎 אין תוצאות — נסה מונח אחר</div>`;
                return;
            }

            statusEl.className = 'otz-status ok';
            statusEl.textContent = `${rows.length} תוצאות${rows.length >= limit ? ' (הוצגו ראשונות)' : ''}`;

            resultsEl.innerHTML = rows.map((row, i) => {
                const snippet   = (row.content || '').substring(0, 300);
                const hlSnippet = hlTerm(snippet, q);
                const sefariaUrl = row.heRef
                    ? `https://www.sefaria.org.il/${encodeURIComponent(row.heRef.replace(/\s/g,'_'))}`
                    : '';
                return `<div class="otz-result-card" data-idx="${i}" tabindex="-1">
                    <div class="otz-result-header">
                        <span class="otz-book-name">${esc(row.bookTitle)}</span>
                        <span class="otz-he-ref">📌 ${esc(row.heRef)}</span>
                        <div class="otz-result-actions">
                            ${sefariaUrl ? `<a class="sefaria-link" href="${sefariaUrl}" target="_blank" rel="noopener">🔗 Sefaria</a>` : ''}
                            <button class="otzaria-open-btn"
                                data-action="open-in-otzaria"
                                data-book-title="${esc(row.bookTitle)}"
                                data-line-index="${row.lineIndex}"
                                data-book-id="${row.bookId}"
                                title="פתח ישירות באוצריא">📚 פתח</button>
                            <button class="copy-citation-btn"
                                data-action="copy-citation"
                                data-ref="${esc(row.heRef)}"
                                data-book="${esc(row.bookTitle)}"
                                data-heref="${esc(row.heRef)}"
                                data-content="${esc(snippet.substring(0,200))}"
                                title="העתק ציטוט">📋</button>
                        </div>
                    </div>
                    <div class="otz-result-content" dir="rtl">${hlSnippet}</div>
                </div>`;
            }).join('');

            // סמן ראשון
            activeIdx = 0;
            updateActive(resultsEl.querySelectorAll('.otz-result-card'));

        } catch (err) {
            statusEl.className = 'otz-status error';
            statusEl.textContent = 'שגיאה: ' + (err?.toString() || err);
        } finally {
            isSearching = false;
        }
    }

    function hlTerm(text, term) {
        if (!term || !text) return esc(text);
        const escaped = esc(text);
        const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escaped.replace(new RegExp(`(${safeTerm})`, 'gi'), '<mark class="otz-hl">$1</mark>');
    }
})();

// ── לינק Sefaria ל"לא נמצא" ──────────────────────────
document.addEventListener('click',e=>{
    const a=e.target.closest('.missing-sefaria-link');
    if(!a)return;
    e.preventDefault();
    const ref=a.dataset.ref||'';
    const sefariaSearch='https://www.sefaria.org/search?q='+encodeURIComponent(ref)+'&lang=he';
    window.open(sefariaSearch,'_blank','noopener');
});

loadSettingsUI();

// ════════════════════════════════════════════════════════════════════════
//  ניתוח ביבליוגרפי — סטטיסטיקה, ענן מקורות, קורלציות (v1)
// ════════════════════════════════════════════════════════════════════════
let biblioReport = null;
let biblioVerifyResults = null; // Map: displayName -> {found, bookTitle, bookId, lineIndex, heRef} (מאומת מול ה-DB בפועל)

document.getElementById('biblioFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('biblioFile').value = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => { document.getElementById('biblioText').value = ev.target.result; };
    reader.readAsText(file, 'UTF-8');
});

function getBiblioBrackets(){
    const el = document.querySelector('input[name="biblioBrackets"]:checked');
    return el ? el.value : 'curly';
}
function bracketChars(kind){
    return kind === 'square' ? ['[',']'] : kind === 'round' ? ['(',')'] : ['{','}'];
}

document.getElementById('biblioRunBtn')?.addEventListener('click', async () => {
    const text = document.getElementById('biblioText').value;
    const statusEl = document.getElementById('biblioStatus');
    const resultsEl = document.getElementById('biblioResults');
    if (!text.trim()) {
        statusEl.style.display='block'; statusEl.className='status-bar error';
        statusEl.textContent = 'הדבק או טען טקסט תחילה.';
        return;
    }
    statusEl.style.display='block'; statusEl.className='status-bar working';
    statusEl.textContent = 'מנתח...';
    resultsEl.style.display='none';
    try {
        biblioReport = await invoke('analyze_bibliography', { text, brackets: getBiblioBrackets() });
        biblioVerifyResults = null;
        statusEl.style.display='none';
        resultsEl.style.display='block';
        renderBiblioKpis(biblioReport);
        renderBiblioStats(biblioReport);
        renderBiblioCloud(biblioReport);
        renderBiblioRelations(biblioReport);
    } catch(err) {
        statusEl.style.display='block'; statusEl.className='status-bar error';
        statusEl.textContent = 'שגיאה: ' + err;
    }
});

function renderBiblioKpis(r){
    const el = document.getElementById('biblioKpis');
    let verifyCard = '';
    if (biblioVerifyResults) {
        const notFound = r.sources.filter(s => biblioVerifyResults[s.displayName]?.found === false).length;
        verifyCard = `<div class="stat-card ${notFound>0?'s-missing':'s-found'}"><div class="stat-num">${notFound}</div><div class="stat-label">לא נמצאו במאגר</div></div>`;
    }
    el.innerHTML = `
        <div class="stat-card"><div class="stat-num">${r.totalCitations}</div><div class="stat-label">סך ציטוטים</div></div>
        <div class="stat-card s-found"><div class="stat-num">${r.uniqueSources}</div><div class="stat-label">מקורות ייחודיים</div></div>
        <div class="stat-card"><div class="stat-num">${r.paragraphsScanned}</div><div class="stat-label">פסקאות נסרקו</div></div>
        <div class="stat-card ${r.unrecognizedCount>0?'s-missing':''}"><div class="stat-num">${r.unrecognizedCount}</div><div class="stat-label">מקורות לא מזוהים</div></div>
        <div class="stat-card"><div class="stat-num">${r.diversityPct.toFixed(0)}%</div><div class="stat-label">גיוון ביבליוגרפי</div></div>
        ${verifyCard}
    `;
}

/// אימות אמיתי מול ה-DB: לכל מקור ייחודי, בודקים אם קיימת שורה תואמת
/// בפועל (לא רק אם שם המסכת "מוכר" כמו is_recognized). זה ה"שדרוג"
/// שהוסכם - חיבור הניתוח הביבליוגרפי לתוצאות חיפוש אמיתיות.
document.getElementById('biblioVerifyBtn')?.addEventListener('click', async () => {
    if (!biblioReport) return;
    const btn = document.getElementById('biblioVerifyBtn');
    const orig = btn.textContent;
    btn.textContent = '⏳ בודק מול המאגר...';
    btn.disabled = true;
    try {
        const dbPath = document.getElementById('dbPath')?.value.trim() || settings?.defaultDb || '';
        const refs = biblioReport.sources.map(s => s.displayName);
        biblioVerifyResults = await invoke('verify_biblio_sources', { refs, dbPath: dbPath || null });
        renderBiblioKpis(biblioReport);
        renderBiblioStats(biblioReport);
    } catch(err) {
        const statusEl = document.getElementById('biblioStatus');
        statusEl.style.display='block'; statusEl.className='status-bar error';
        statusEl.textContent = 'שגיאת אימות: ' + err;
    } finally {
        btn.textContent = orig;
        btn.disabled = false;
    }
});

function getBiblioFilteredSortedSources(r){
    const filterText = (document.getElementById('biblioFilterInput')?.value || '').trim().toLowerCase();
    const sortMode = document.getElementById('biblioSortSelect')?.value || 'count-desc';
    const onlyUnrecognized = document.getElementById('biblioOnlyUnrecognized')?.checked;
    const onlyNotInDb = document.getElementById('biblioOnlyNotInDb')?.checked;

    let list = r.sources.slice();
    if (filterText) {
        list = list.filter(s => s.displayName.toLowerCase().includes(filterText) || s.variantsSeen.some(v => v.toLowerCase().includes(filterText)));
    }
    if (onlyUnrecognized) {
        list = list.filter(s => !s.recognized);
    }
    if (onlyNotInDb && biblioVerifyResults) {
        list = list.filter(s => biblioVerifyResults[s.displayName]?.found === false);
    }
    if (sortMode === 'count-asc') list.sort((a,b) => a.count - b.count);
    else if (sortMode === 'name') list.sort((a,b) => a.displayName.localeCompare(b.displayName, 'he'));
    else list.sort((a,b) => b.count - a.count); // count-desc (ברירת מחדל)
    return list;
}

/// בונה את תא ה"אימות" האינטראקטיבי — עמודה אחת ממוזגת במקום שתי
/// עמודות סטטיות נפרדות (זוהה?/במאגר?). מצב תלוי בשלב:
/// - טרם אומת מול ה-DB: רמז חלש בלבד (שם מוכר/לא מוכר)
/// - אומת ונמצא: כפתור לחיץ שפותח ישירות באוצריא (משתמש ב-bookId/
///   lineIndex האמיתיים שהוחזרו מ-verify_biblio_sources)
/// - אומת ולא נמצא: תג אדום, לא לחיץ
function buildVerifyCell(src){
    const wrap = document.createElement('div');
    const info = biblioVerifyResults ? biblioVerifyResults[src.displayName] : null;
    if (info && info.found) {
        const btn = document.createElement('button');
        btn.className = 'biblio-mini-btn primary';
        btn.textContent = '✓ פתח באוצריא';
        if (info.heRef) btn.title = `${info.bookTitle || ''} ${info.heRef}`.trim();
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const orig = btn.textContent;
            btn.textContent = '⏳ פותח...';
            btn.disabled = true;
            try {
                await invoke('open_in_otzaria', {
                    bookTitle: info.bookTitle,
                    lineIndex: info.lineIndex,
                    bookId: info.bookId ?? null,
                    dbPath: document.getElementById('dbPath')?.value.trim() || null,
                });
                btn.textContent = '✅ נפתח!';
                setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
            } catch (err) {
                btn.textContent = orig;
                btn.disabled = false;
                alert('שגיאה בפתיחת אוצריא:\n' + err);
            }
        });
        wrap.appendChild(btn);
    } else if (info && !info.found) {
        wrap.innerHTML = `<span class="biblio-unrecognized" title="לא נמצאה התאמה מדויקת במאגר">✗ לא נמצא</span>`;
    } else {
        wrap.innerHTML = src.recognized
            ? `<span class="biblio-chapters" title="שם מוכר — עדיין לא נבדק מול המאגר בפועל (לחץ 'אימות מול המאגר' למעלה)">שם מוכר —</span>`
            : `<span class="biblio-unrecognized" title="שם לא מוכר — עדיין לא נבדק מול המאגר">לא ידוע</span>`;
    }
    return wrap;
}

function renderBiblioStats(r){
    const tbody = document.getElementById('biblioStatsBody');
    tbody.innerHTML = '';
    const sources = getBiblioFilteredSortedSources(r);
    if (!sources.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:20px">אין מקורות תואמים לסינון הנוכחי</td></tr>`;
        return;
    }
    sources.forEach((src, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'biblio-name-cell';
        tr.id = `biblio-row-${btoa(unescape(encodeURIComponent(src.canonical))).replace(/[^a-zA-Z0-9]/g,'')}`;

        const tdName = document.createElement('td');
        const variantsHint = src.variantsSeen.length > 1 ? ` <span class="biblio-chapters">(${src.variantsSeen.length} צורות כתיב)</span>` : '';
        tdName.innerHTML = `<span class="biblio-toggle-name">▸ ${escapeHtml(src.displayName)}</span>${variantsHint} <button class="biblio-mini-btn" data-biblio-edit="${idx}">✏️ שנה שם</button>`;

        const tdCount = document.createElement('td');
        tdCount.textContent = src.count;

        const tdLocs = document.createElement('td');
        tdLocs.className = 'biblio-chapters';
        tdLocs.textContent = src.chapters.join(', ');

        const tdVerify = document.createElement('td');
        tdVerify.appendChild(buildVerifyCell(src));

        tr.append(tdName, tdCount, tdLocs, tdVerify);
        tbody.appendChild(tr);

        // שורת פרטים (מוסתרת כברירת מחדל) — כל מופע עם ההקשר שלו ואפשרות עריכה
        const detailTr = document.createElement('tr');
        detailTr.style.display = 'none';
        detailTr.className = 'biblio-detail-row';
        const detailTd = document.createElement('td');
        detailTd.colSpan = 4;
        detailTd.appendChild(buildOccurrencesPanel(src, idx));
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);

        tdName.querySelector('.biblio-toggle-name').addEventListener('click', () => {
            const isOpen = detailTr.style.display !== 'none';
            detailTr.style.display = isOpen ? 'none' : '';
            tdName.querySelector('.biblio-toggle-name').textContent = (isOpen ? '▸ ' : '▾ ') + src.displayName;
        });
        tdName.querySelector('[data-biblio-edit]').addEventListener('click', (e) => {
            e.stopPropagation();
            enableBiblioEdit(tdName, src);
        });
    });
}

/// בונה את פאנל המופעים (הקשר + עריכה) עבור מקור בודד — בהשראת הסקיצה
/// שהועברה, אך עם תיקון הבאג המרכזי שלה: כל מופע נושא context_start/
/// context_end מדויקים שחושבו ב-Rust (לא הנחת חלון קבוע של ±100 תווים),
/// כך שעריכה אף פעם לא דורסת טקסט של מופע סמוך.
function buildOccurrencesPanel(src, srcIdx){
    const wrap = document.createElement('div');
    wrap.className = 'biblio-occurrences';
    src.occurrences.forEach((occ, occIdx) => {
        const box = document.createElement('div');
        box.className = 'biblio-occ-box';
        box.innerHTML = `
            <div class="biblio-occ-meta">${escapeHtml(occ.chapter)}</div>
            <div class="biblio-occ-text" data-occ-view="${srcIdx}-${occIdx}">…${escapeHtml(occ.contextBefore)}<mark>${escapeHtml(occ.matchedText)}</mark>${escapeHtml(occ.contextAfter)}…</div>
            <div class="biblio-occ-actions">
                <button class="biblio-mini-btn" data-occ-edit="${srcIdx}-${occIdx}">✏️ ערוך הקשר זה</button>
            </div>
        `;
        wrap.appendChild(box);
        box.querySelector('[data-occ-edit]').addEventListener('click', () => enableOccurrenceEdit(box, occ));
    });
    return wrap;
}

function enableOccurrenceEdit(box, occ){
    const combined = occ.contextBefore + occ.matchedText + occ.contextAfter;
    const viewEl = box.querySelector('.biblio-occ-text');
    const actionsEl = box.querySelector('.biblio-occ-actions');
    viewEl.style.display = 'none';
    actionsEl.style.display = 'none';
    const editBox = document.createElement('div');
    editBox.className = 'biblio-edit-row';
    editBox.innerHTML = `
        <textarea class="biblio-occ-editarea">${escapeHtml(combined)}</textarea>
        <div style="display:flex;gap:6px;margin-top:6px">
            <button class="biblio-mini-btn primary" data-occ-save>שמור</button>
            <button class="biblio-mini-btn" data-occ-cancel>בטל</button>
        </div>
    `;
    box.appendChild(editBox);
    editBox.querySelector('[data-occ-cancel]').addEventListener('click', () => {
        editBox.remove();
        viewEl.style.display = '';
        actionsEl.style.display = '';
    });
    editBox.querySelector('[data-occ-save]').addEventListener('click', async () => {
        const newText = editBox.querySelector('textarea').value;
        const statusEl = document.getElementById('biblioStatus');
        try {
            const fullText = document.getElementById('biblioText').value;
            const updated = await invoke('edit_biblio_context', {
                text: fullText,
                contextStart: occ.contextStart,
                contextEnd: occ.contextEnd,
                newText,
            });
            document.getElementById('biblioText').value = updated;
            document.getElementById('biblioRunBtn').click();
        } catch(err) {
            statusEl.style.display='block'; statusEl.className='status-bar error';
            statusEl.textContent = 'שגיאת עריכה: ' + err + ' — כנראה הטקסט השתנה. הרץ ניתוח מחדש ונסה שוב.';
        }
    });
}

function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function enableBiblioEdit(td, src){
    const nameSpan = td.querySelector('.biblio-toggle-name');
    const editBtn = td.querySelector('[data-biblio-edit]');
    nameSpan.style.display = 'none';
    editBtn.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'biblio-edit-row';
    row.innerHTML = `
        <input type="text" value="${escapeHtml(src.displayName)}" id="biblioEditInput" />
        <button class="biblio-mini-btn primary" id="biblioEditSave">שמור בכל הצורות</button>
        <button class="biblio-mini-btn" id="biblioEditCancel">בטל</button>
    `;
    td.appendChild(row);
    document.getElementById('biblioEditInput').focus();
    document.getElementById('biblioEditCancel').addEventListener('click', () => renderBiblioStats(biblioReport));
    document.getElementById('biblioEditSave').addEventListener('click', () => saveBiblioRename(src));
}

/// שינוי שם גלובלי — מחליף את *כל* הצורות שנמצאו (variantsSeen) עבור מקור
/// זה, לא רק צורת כתיבה אחת. זה ה"שדרוג" מעל הסקיצה המקורית: אם אותו
/// מקור נכתב פעם כ"ברכות ב." ופעם כ"ברכות דף ב, עמוד א" — לחיצה אחת
/// מתקנת את שתי הצורות בכל הטקסט בבת אחת.
function saveBiblioRename(src){
    const newName = document.getElementById('biblioEditInput').value.trim();
    if (!newName) { renderBiblioStats(biblioReport); return; }
    let fullText = document.getElementById('biblioText').value;
    const [open, close] = bracketChars(getBiblioBrackets());
    const escRe = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const eo = escRe(open), ec = escRe(close);
    src.variantsSeen.forEach(variant => {
        const re = new RegExp(`${eo}\\s*${escRe(variant)}\\s*${ec}`, 'g');
        fullText = fullText.replace(re, `${open}${newName}${close}`);
    });
    document.getElementById('biblioText').value = fullText;
    document.getElementById('biblioRunBtn').click();
}

function renderBiblioCloud(r){
    const el = document.getElementById('biblioCloud');
    el.innerHTML = '';
    const maxCount = Math.max(...r.sources.map(s => s.count), 1);
    r.sources.forEach(src => {
        const tag = document.createElement('span');
        tag.className = 'cloud-tag';
        tag.textContent = src.displayName;
        const size = 12 + (src.count / maxCount) * 22;
        tag.style.fontSize = size.toFixed(1) + 'px';
        tag.title = `${src.count} מופעים${src.recognized ? '' : ' — לא מזוהה'} (לחץ לפתיחה בטבלה)`;
        if (!src.recognized) tag.style.opacity = '0.6';
        tag.addEventListener('click', () => jumpToBiblioSource(src));
        el.appendChild(tag);
    });
}

/// קפיצה ממקור בענן/פילוח-פרקים לשורה המתאימה בטבלת הסטטיסטיקה — מנקה
/// סינון פעיל (אחרת השורה עלולה להיות מוסתרת), עובר לטאב הסטטיסטיקה,
/// ופותח את פאנל המופעים של השורה תוך גלילה חלקה אליה.
function jumpToBiblioSource(src){
    document.getElementById('biblioFilterInput').value = '';
    document.getElementById('biblioOnlyUnrecognized').checked = false;
    document.getElementById('biblioOnlyNotInDb').checked = false;
    document.querySelector('input[name="biblioTab"][value="stats"]').checked = true;
    document.getElementById('biblioTabStats').style.display = '';
    document.getElementById('biblioTabCloud').style.display = 'none';
    document.getElementById('biblioTabRelations').style.display = 'none';
    document.getElementById('biblioTabChapters').style.display = 'none';
    renderBiblioStats(biblioReport);
    const rowId = `biblio-row-${btoa(unescape(encodeURIComponent(src.canonical))).replace(/[^a-zA-Z0-9]/g,'')}`;
    const row = document.getElementById(rowId);
    if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background 0.3s ease';
        row.style.background = 'var(--gold-dim)';
        setTimeout(() => { row.style.background = ''; }, 1500);
        row.querySelector('.biblio-toggle-name')?.click();
    }
}

function renderBiblioRelations(r){
    const tbody = document.getElementById('biblioRelationsBody');
    tbody.innerHTML = '';
    if (!r.relations.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-3)">אין מספיק מקורות חופפים באותה פסקה כדי להציג קשרים</td></tr>`;
        return;
    }
    r.relations.forEach(rel => {
        tbody.insertAdjacentHTML('beforeend', `<tr><td>${escapeHtml(rel.sourceA)}</td><td>${escapeHtml(rel.sourceB)}</td><td><strong>${rel.count}</strong></td></tr>`);
    });
}

/// פילוח לפי פרק — סך כל הציטוטים (מכל המקורות) שהופיעו בכל "מיקום"
/// (פרק/סימן/חלק שזוהה), מציג כמות יחסית כעמודת-בר. עוזר לאתר פרקים
/// עם צפיפות ציטוטים חריגה, או פרקים שכלל לא צוטטו.
function renderBiblioChapters(r){
    const el = document.getElementById('biblioChaptersBox');
    const chapterCounts = {};
    r.sources.forEach(src => {
        (src.occurrences || []).forEach(occ => {
            chapterCounts[occ.chapter] = (chapterCounts[occ.chapter] || 0) + 1;
        });
    });
    const entries = Object.entries(chapterCounts).sort((a,b) => b[1] - a[1]);
    if (!entries.length) {
        el.innerHTML = `<p style="text-align:center;color:var(--text-3);padding:20px">לא זוהו כותרות פרק/סימן/חלק במסמך</p>`;
        return;
    }
    const maxCount = Math.max(...entries.map(e => e[1]), 1);
    el.innerHTML = entries.map(([chapter, count]) => `
        <div class="biblio-chapter-row">
            <div class="biblio-chapter-name">${escapeHtml(chapter)}</div>
            <div class="biblio-chapter-bar-track"><div class="biblio-chapter-bar-fill" style="width:${(count/maxCount*100).toFixed(1)}%"></div></div>
            <div class="biblio-chapter-count">${count}</div>
        </div>
    `).join('');
}

// ── מעבר בין טאבים (סטטיסטיקה / ענן / קשרים / פילוח פרקים) ───────────
document.querySelectorAll('input[name="biblioTab"]').forEach(radio => {
    radio.addEventListener('change', () => {
        const val = radio.value;
        document.getElementById('biblioTabStats').style.display = val === 'stats' ? '' : 'none';
        document.getElementById('biblioTabCloud').style.display = val === 'cloud' ? '' : 'none';
        document.getElementById('biblioTabRelations').style.display = val === 'relations' ? '' : 'none';
        document.getElementById('biblioTabChapters').style.display = val === 'chapters' ? '' : 'none';
        if (val === 'chapters' && biblioReport) renderBiblioChapters(biblioReport);
    });
});

// ── סינון/מיון טבלת הסטטיסטיקה ────────────────────────────────────────
['biblioFilterInput', 'biblioSortSelect', 'biblioOnlyUnrecognized', 'biblioOnlyNotInDb'].forEach(id => {
    const el = document.getElementById(id);
    const evt = el?.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change';
    el?.addEventListener(evt, () => { if (biblioReport) renderBiblioStats(biblioReport); });
});

// ── הורדות ────────────────────────────────────────────────────────────
document.getElementById('biblioDownloadTxt')?.addEventListener('click', () => {
    const txt = document.getElementById('biblioText').value;
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'טקסט_מתוקן.txt';
    a.click();
});

document.getElementById('biblioDownloadCsv')?.addEventListener('click', () => {
    if (!biblioReport) return;
    const rows = [['מקור', 'מופעים', 'מיקומים', 'זוהה', 'צורות כתיב שנמצאו']];
    biblioReport.sources.forEach(s => {
        rows.push([s.canonical, s.count, s.chapters.join(' | '), s.recognized ? 'כן' : 'לא', s.variantsSeen.join(' | ')]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ניתוח_ביבליוגרפי.csv';
    a.click();
});

// ════════════════════════════════════════════════════════════════════════
//  עורך AI — פיסוק ומקורות (Gemini)
//  הועתק מהכלי שסופק, עם שינוי עיצוב/מזהי-DOM בלבד. הלוגיקה (הפרומפט,
//  אלגוריתם ה-diff, לחיצה-להסתרה, שמירה) נשארה זהה לחלוטין ולא נגעתי בה.
// ════════════════════════════════════════════════════════════════════════
// ── מפתח Gemini משותף — אחסון מוצפן דרך ה-OS keychain, לא localStorage ──
// משמש גם את עורך ה-AI וגם את מסכם הטקסט; טעינה/שמירה חד-פעמית מספיקה
// כי שני הכלים משתמשים באותו slot ב-keychain.
async function wireGeminiKeyInput(inputEl){
    if (!inputEl) return;
    try {
        const saved = await invoke('load_gemini_key');
        if (saved) inputEl.value = saved;
    } catch (e) {
        console.warn('לא ניתן היה לטעון מפתח Gemini שמור:', e);
    }
    // קריטי: 'input' (לא 'change') כדי לשמור מיד עם כל הקלדה/הדבקה,
    // בלי להסתמך על blur — 'change' לא תמיד מספיק להיווצר לפני
    // שהמשתמש כבר לוחץ על כפתור ההרצה (למשל בהדבקה מהירה + Enter/קליק).
    let saveDebounce = null;
    inputEl.addEventListener('input', () => {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(async () => {
            const val = inputEl.value.trim();
            try {
                if (val) {
                    await invoke('save_gemini_key', { key: val });
                } else {
                    await invoke('delete_gemini_key');
                }
            } catch (e) {
                console.warn('לא ניתן היה לשמור את מפתח Gemini:', e);
            }
        }, 400);
    });
}

(function initAiEditor(){
    const aiStatusDiv = document.getElementById('aiStatus');
    if (!aiStatusDiv) return;

    // מפתח ה-API נשמר כעת באחסון המוצפן של מערכת ההפעלה (Windows
    // Credential Manager וכו') דרך wireGeminiKeyInput המשותפת — לא
    // ב-localStorage גלוי. אותה פונקציה משמשת גם את כלי הסיכום, כך
    // שהמפתח משותף בין שני הכלים ולא צריך להזין אותו פעמיים.
    const aiApiKeyInput = document.getElementById('aiApiKey');
    wireGeminiKeyInput(aiApiKeyInput);

    // ── הנחיה מותאמת אישית ────────────────────────────────────────────
    // המשתמש יכול להוסיף כל בקשה חופשית (למשל "הוסף ניקוד") שמצטרפת
    // להנחיה הבסיסית (לא מחליפה אותה) בכל הרצה. נשמרת בהגדרות כדי
    // שלא תצטרך להזין אותה מחדש בכל פעם.
    function updateAiInstructionHint(){
        const val = (loadSettings().aiCustomInstruction || '').trim();
        const hint = document.getElementById('aiInstructionHint');
        hint.textContent = val ? `✓ הנחיה פעילה: "${val.length > 40 ? val.slice(0,40)+'…' : val}"` : '';
    }
    updateAiInstructionHint();

    document.getElementById('aiBtnEditInstruction').addEventListener('click', () => {
        const current = (loadSettings().aiCustomInstruction || '');
        const existing = document.getElementById('instructionEditOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'instructionEditOverlay';
        overlay.className = 'bracket-choice-overlay';
        overlay.innerHTML = `
            <div class="bracket-choice-box" style="max-width:520px;width:90%">
                <div class="bracket-choice-title" style="text-align:right">הנחיה מותאמת אישית (מצטרפת להנחיה הבסיסית)</div>
                <textarea id="instructionEditTextarea" class="paste-textarea" style="min-height:120px;margin-bottom:14px" placeholder="לדוגמה: הוסף ניקוד לכל המילים. או: כתוב בעברית מודרנית ולא ארכאית. או כל בקשה אחרת...">${escapeHtml(current)}</textarea>
                <div class="bracket-choice-opts">
                    <button class="biblio-mini-btn primary" id="instructionSaveBtn">שמור</button>
                    <button class="biblio-mini-btn" id="instructionClearBtn">נקה הנחיה</button>
                    <button class="biblio-mini-btn" id="instructionCancelBtn">בטל</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        document.getElementById('instructionEditTextarea').focus();

        document.getElementById('instructionCancelBtn').addEventListener('click', () => overlay.remove());
        document.getElementById('instructionClearBtn').addEventListener('click', () => {
            const ns = loadSettings();
            delete ns.aiCustomInstruction;
            saveSettings(ns);
            settings = ns;
            updateAiInstructionHint();
            overlay.remove();
        });
        document.getElementById('instructionSaveBtn').addEventListener('click', () => {
            const val = document.getElementById('instructionEditTextarea').value.trim();
            const ns = loadSettings();
            ns.aiCustomInstruction = val;
            saveSettings(ns);
            settings = ns;
            updateAiInstructionHint();
            overlay.remove();
        });
    });

    const aiBtnRun = document.getElementById('aiBtnRun');
    aiBtnRun.onclick = async () => {
        const key = document.getElementById('aiApiKey').value.trim();
        const txt = document.getElementById('aiTextA').value.trim();
        const model = document.getElementById('aiModelSelect').value;

        if(!txt) { alert("אנא הכנס טקסט לתיבה הימנית"); return; }
        if(!key) { alert("אנא הכנס מפתח API של Gemini"); return; }

        // רשת ביטחון — שמירה מפורשת עכשיו, בלי קשר לתזמון ה-debounce
        // של wireGeminiKeyInput (מונע מצב שבו מדביקים מפתח ומיד לוחצים
        // הרצה לפני שהשמירה האוטומטית הספיקה לרוץ).
        invoke('save_gemini_key', { key }).catch(() => {});

        // מניעת שליחה כפולה — נועל את הכפתור עד לסיום הבקשה (הצלחה או כישלון)
        const origBtnHtml = aiBtnRun.innerHTML;
        aiBtnRun.disabled = true;
        aiBtnRun.style.opacity = '0.6';
        aiBtnRun.style.cursor = 'not-allowed';

        aiStatusDiv.style.display = 'block';
        aiStatusDiv.className = 'status-bar working';
        aiStatusDiv.innerText = `מתחבר ל- ${model}...`;

        try {
            const basePrompt = "אתה עורך תורני מומחה. בצע פיסוק לטקסט הבא והוסף מראה מקומות (תנ\"ך, גמרא, מדרש, רמב\"ם) בסוגריים מסולסלים {}. אל תשנה את המילים המקוריות, רק הוסף פיסוק ומקורות, וציטוטים תשים בתוך גרשיים תחילה וסוף. תוסיף כותרות נושא קצרות, בסיגנון ישיבתי ליטאי, בין 3 ל6 מילים בתוך סוגרים מרובעות, ותפתח ראשי תיבות (לא ראשי תיבות של ז\"ל זכרונו או זכרונם לברכה או ה' - השם, או הקב\"ה - הקדוש ברוך הוא) רק בתוך סוגרים עגולות, ולא לשנות מהטקסט את הפענוח בתוך סוגרים עגולות, וחלק פסקאות לפי נושאים בלבד אבל אל תשנה מהמילים המקוריות בכלל אל תוסיף כוכביות סימני שאלה וסולמיות.";
            // הנחיה מותאמת אישית — אם המשתמש הגדיר אחת (דרך "⚙️ הנחיה
            // מותאמת אישית"), היא מצטרפת להנחיה הבסיסית ולא מחליפה אותה,
            // כך שהכללים הבסיסיים (לא לשנות מילים, לא להוסיף כוכביות וכו')
            // תמיד נשמרים גם אם המשתמש מוסיף בקשה נוספת (כמו ניקוד).
            const customInstruction = (loadSettings().aiCustomInstruction || '').trim();
            const fullInstruction = customInstruction
                ? `${basePrompt}\n\nהנחיה נוספת מהמשתמש (בצע גם אותה):\n${customInstruction}`
                : basePrompt;
            const prompt = fullInstruction + "\n\n" + txt;

            // invoke דרך Rust במקום fetch() ישיר מה-JS — עוקף לחלוטין את
            // חסימת ה-CORS שה-webview עלול להטיל על תגובות מ-Google (זו
            // הסיבה ל"Failed to fetch" הסתמי). כל לוגיקת הזיהוי (quota/
            // מפתח לא תקין/חסימת בטיחות) רצה עכשיו בצד Rust בפקודת
            // call_gemini, עם אותן הודעות שגיאה בדיוק.
            const resultText = await invoke('call_gemini', { prompt, apiKey: key, model });

            document.getElementById('aiTextB').value = resultText;
            aiStatusDiv.className = 'status-bar ok';
            aiStatusDiv.innerText = "העיבוד הושלם בהצלחה!";
            setTimeout(() => aiStatusDiv.style.display = 'none', 3000);
        } catch (e) {
            aiStatusDiv.className = 'status-bar error';
            aiStatusDiv.style.whiteSpace = 'pre-wrap';
            aiStatusDiv.innerText = "שגיאה: " + (e.message || e);
        } finally {
            aiBtnRun.disabled = false;
            aiBtnRun.style.opacity = '';
            aiBtnRun.style.cursor = '';
        }
    };

    document.getElementById('aiBtnCompare').onclick = () => {
        const container = document.getElementById('aiDiffContainer');
        const rawA = document.getElementById('aiTextA').value.trim();
        const rawB = document.getElementById('aiTextB').value.trim();
        if(!rawB) return;
        container.innerHTML = '';
        const wordsA = rawA.split(/\s+/);
        const wordsB = rawB.match(/\{[^}]+\}|[^\s{}]+/g) || [];
        let i = 0, j = 0;
        while (j < wordsB.length) {
            let wB = wordsB[j];
            if (wB.startsWith('{') && wB.endsWith('}')) {
                createAiSpan(wB, 'bracket', container);
                j++;
                continue;
            }
            let cleanA = (wordsA[i] || "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
            let cleanB = wB.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
            if (cleanA === cleanB || i >= wordsA.length) {
                createAiSpan(wB, (i >= wordsA.length || wordsA[i] !== wB) ? 'added' : 'match', container);
                if (i < wordsA.length) i++;
                j++;
            } else { i++; }
        }
        updateAiPreview();
    };

    document.getElementById('aiBtnSave').onclick = () => {
        const text = document.getElementById('aiPreviewContainer').innerText;
        if(!text) return;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'טקסט_ערוך.txt';
        a.click();
    };

    function createAiSpan(text, type, parent) {
        const span = document.createElement('span');
        span.innerText = text;
        span.className = `ai-word ${type}`;
        if (type !== 'match') {
            span.onclick = () => { span.classList.toggle('user-hidden'); updateAiPreview(); };
        }
        parent.appendChild(span);
        parent.appendChild(document.createTextNode(' '));
    }

    function updateAiPreview() {
        let final = "";
        document.querySelectorAll('#aiDiffContainer .ai-word').forEach(s => {
            if (!s.classList.contains('user-hidden')) final += s.innerText + " ";
        });
        document.getElementById('aiPreviewContainer').innerText = final.trim().replace(/\s+([,.])/g, '$1');
    }
})();

// ════════════════════════════════════════════════════════════════════════
//  מסכם טקסט חכם (Gemini) — נושאים, שמות/מקורות, סיכום ישיבתי, שאלות-תשובה
//  הועתק מהכלי שסופק: הפרומפטים, לוגיקת החילוץ/רינדור, ואפקט ההקלדה
//  נשארו זהים. שונה: קריאת ה-API עברה מ-fetch() ישיר ל-invoke('call_gemini')
//  (עוקף CORS, כמו בעורך ה-AI), והמפתח משותף עם עורך ה-AI דרך אותו
//  אחסון מוצפן.
// ════════════════════════════════════════════════════════════════════════
(function initSummarizer(){
    const sumInputText = document.getElementById('sumInputText');
    if (!sumInputText) return;

    let sumLastText = '';

    wireGeminiKeyInput(document.getElementById('sumApiKey'));

    sumInputText.addEventListener('input', () => {
        document.getElementById('sumCharCount').textContent =
            sumInputText.value.length.toLocaleString('he-IL') + ' תווים';
    });

    function sumShowError(msg){
        const box = document.getElementById('sumErrorBox');
        box.style.display = 'block';
        box.textContent = '⚠ ' + msg;
    }
    function sumHideError(){
        document.getElementById('sumErrorBox').style.display = 'none';
    }

    function sumCleanText(text){
        return text
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/^[-•]\s+/gm, '')
            .replace(/^\d+\.\s+/gm, '')
            .replace(/`{1,3}[^`]*`{1,3}/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function sumCallGemini(prompt, temperature, maxOutputTokens){
        const apiKey = document.getElementById('sumApiKey').value.trim();
        const model = document.getElementById('sumModelSelect').value;
        return await invoke('call_gemini', { prompt, apiKey, model, temperature, maxOutputTokens: maxOutputTokens });
    }

    function sumAddTag(wrap, text, type){
        const span = document.createElement('span');
        span.className = `sum-tag sum-tag-${type}`;
        span.textContent = text;
        wrap.appendChild(span);
    }

    document.getElementById('sumBtnRun').addEventListener('click', async () => {
        sumHideError();
        const text = sumInputText.value.trim();
        const btn = document.getElementById('sumBtnRun');

        if (!document.getElementById('sumApiKey').value.trim()) { sumShowError('נא להזין מפתח API.'); return; }
        if (!text) { sumShowError('נא להדביק טקסט לסיכום.'); return; }
        if (text.length < 30) { sumShowError('הטקסט קצר מדי לסיכום.'); return; }

        invoke('save_gemini_key', { key: document.getElementById('sumApiKey').value.trim() }).catch(() => {});

        sumLastText = text;
        btn.disabled = true;
        btn.style.opacity = '0.6';
        ['sumTopicsCard','sumNamesCard','sumSummaryCard','sumQaCard'].forEach(id =>
            document.getElementById(id).style.display = 'none'
        );

        const topicsPrompt = `קרא את הטקסט הבא וחלץ ממנו את הנושאים העיקריים שנדונו בו.
החזר רשימה של כל הנושאים שנדונו בטקסט, כמה שיש.
כל נושא — כותרת תמציתית של 3-6 מילים בלבד.
הפרד כל נושא בשורה חדשה המתחילה בסימן | (מקף אנכי).
אל תוסיף הסברים נוספים, רק שמות הנושאים.

טקסט:
"""
${text}
"""

נושאים:`;

        const namesPrompt = `קרא את הטקסט הבא וחלץ ממנו:
א. שמות אנשים (חכמים, רבנים, מחברים, דמויות)
ב. שמות ספרים, מסכתות, מקורות תורניים
ג. שמות מקומות

החזר JSON בלבד, ללא שום טקסט נוסף, בפורמט הזה בדיוק:
{"persons":["שם1","שם2"],"books":["ספר1","ספר2"],"places":["מקום1"]}

אם אין פריטים בקטגוריה מסוימת, החזר מערך ריק [].

טקסט:
"""
${text}
"""`;

        const summaryPrompt = `אתה תלמיד חכם הכותב בסגנון ישיבתי-ליטאי קלאסי.
עליך לסכם את הטקסט שלהלן בסגנון זה במדויק.

כללי הסגנון:
- לשון הגמרא והראשונים: "דהיינו", "כלומר", "ומבואר", "ויש לומר", "ונראה", "והביאור הוא", "ומשמע מדבריו"
- מבנה הגיוני-ניתוחי: כל עניין נובע מקודמו
- חלוקה לנושאים עם כותרות קצרות (כותרת בשורה נפרדת ואחריה נקודתיים)
- פסקאות רצופות ורהוטות — ללא רשימות ולא מקפים
- פתיחה בנוסח: "יסוד הדברים הוא..." או "עניין זה עוסק ב..."
- סיום בנוסח: "ויוצא מכל האמור כי..." או "ונמצא שהעיקר הוא..."
- מושגים מרכזיים — הקף בגרשיים: "מילה"
- אסור: כוכביות, סולמיות, מקפים כרשימה, מרקדאון
- אל תוסיף מידע שאינו בטקסט

טקסט:
"""
${text}
"""

סיכום בסגנון ישיבתי:`;

        try {
            const [topicsRaw, namesRaw, summaryRaw] = await Promise.all([
                sumCallGemini(topicsPrompt, 0.3, 8192),
                sumCallGemini(namesPrompt, 0.3, 8192),
                sumCallGemini(summaryPrompt, 0.3, 8192),
            ]);

            // ── נושאים ──
            const topicsItems = (topicsRaw || '').split('\n')
                .map(l => l.replace(/^\|/, '').trim())
                .filter(l => l.length > 2);
            const hebrewLetters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','יא','יב','יג','יד','טו','טז','יז','יח','יט','כ','כא','כב','כג','כד','כה','כו','כז','כח','כט','ל'];
            const topicsList = document.getElementById('sumTopicsList');
            topicsList.innerHTML = '';
            topicsItems.forEach((item, i) => {
                const li = document.createElement('li');
                li.innerHTML = `<span class="sum-topic-num">${hebrewLetters[i] || (i+1)}.</span><span>${escapeHtml(item)}</span>`;
                topicsList.appendChild(li);
            });
            document.getElementById('sumTopicsCard').style.display = '';

            // ── שמות ומקורות ──
            let namesObj = { persons: [], books: [], places: [] };
            try {
                const cleaned = (namesRaw || '').replace(/```json|```/g, '').trim();
                namesObj = JSON.parse(cleaned);
            } catch(e) {}
            const tagsWrap = document.getElementById('sumNamesTags');
            tagsWrap.innerHTML = '';
            let hasAny = false;
            (namesObj.persons||[]).forEach(n => { sumAddTag(tagsWrap, n, 'person'); hasAny = true; });
            (namesObj.books||[]).forEach(n   => { sumAddTag(tagsWrap, n, 'book');   hasAny = true; });
            (namesObj.places||[]).forEach(n  => { sumAddTag(tagsWrap, n, 'place');  hasAny = true; });
            if (!hasAny) tagsWrap.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem">לא זוהו שמות ומקורות</span>';
            document.getElementById('sumNamesCard').style.display = '';

            // ── סיכום (עם אפקט הקלדה) ──
            const summary = sumCleanText(summaryRaw || '');
            const summaryEl = document.getElementById('sumSummaryText');
            document.getElementById('sumSummaryCard').style.display = '';
            summaryEl.textContent = '';
            summaryEl.classList.add('sum-cursor');
            let i = 0;
            const interval = setInterval(() => {
                if (i < summary.length) {
                    summaryEl.textContent += summary[i++];
                } else {
                    clearInterval(interval);
                    summaryEl.classList.remove('sum-cursor');
                }
            }, 10);

            document.getElementById('sumQaCard').style.display = '';
        } catch (err) {
            sumShowError(err.message || err);
        } finally {
            btn.disabled = false;
            btn.style.opacity = '';
        }
    });

    document.getElementById('sumBtnAsk').addEventListener('click', async () => {
        const question = document.getElementById('sumQaInput').value.trim();
        if (!question || !sumLastText) return;

        const btn = document.getElementById('sumBtnAsk');
        const answerEl = document.getElementById('sumQaAnswer');
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = 'מחפש...';
        answerEl.style.display = 'none';

        const prompt = `להלן טקסט, ואחריו שאלה עליו. ענה על השאלה בסגנון ישיבתי-ליטאי בלבד על סמך הטקסט.
אל תוסיף מידע שאינו בטקסט. ענה בתמציתיות ובדיוק.
אסור: כוכביות, סולמיות, מרקדאון.

טקסט:
"""
${sumLastText}
"""

שאלה: ${question}

תשובה:`;

        try {
            const answerRaw = await sumCallGemini(prompt, 0.3, 8192);
            answerEl.textContent = sumCleanText(answerRaw || 'לא נמצאה תשובה.');
            answerEl.style.display = '';
        } catch(e) {
            answerEl.textContent = 'שגיאה: ' + (e.message || e);
            answerEl.style.display = '';
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    });

    document.getElementById('sumBtnCopy').addEventListener('click', (e) => {
        const text = document.getElementById('sumSummaryText').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = e.target;
            const orig = btn.textContent;
            btn.textContent = 'הועתק!';
            setTimeout(() => btn.textContent = orig, 2000);
        });
    });

    document.getElementById('sumBtnClear').addEventListener('click', () => {
        sumInputText.value = '';
        document.getElementById('sumSummaryText').textContent = '';
        document.getElementById('sumTokenInfo').innerHTML = '';
        document.getElementById('sumQaInput').value = '';
        document.getElementById('sumQaAnswer').textContent = '';
        document.getElementById('sumQaAnswer').style.display = 'none';
        ['sumTopicsCard','sumNamesCard','sumSummaryCard','sumQaCard'].forEach(id =>
            document.getElementById(id).style.display = 'none'
        );
        sumHideError();
        document.getElementById('sumCharCount').textContent = '0 תווים';
        sumLastText = '';
    });

    document.getElementById('sumQaInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('sumBtnAsk').click();
    });
})();

// ════════════════════════════════════════════════════════════════════════
//  זיהוי אוטומטי של סוג הסוגריים — אם יש רק סוג אחד בטקסט, נבחר אותו
//  לבד; אם יש כמה סוגים, שואלים את המשתמש איזה מהם להשתמש.
// ════════════════════════════════════════════════════════════════════════
const BRACKET_PATTERNS = {
    curly:  /\{[^{}]+\}/,
    square: /\[[^\[\]]+\]/,
    round:  /\([^()]+\)/,
};
const BRACKET_LABELS = { curly: '{ } מסולסל', square: '[ ] מרובע', round: '( ) עגול' };

function detectBracketTypes(text){
    return Object.keys(BRACKET_PATTERNS).filter(t => BRACKET_PATTERNS[t].test(text));
}

/// חלונית קטנה ששואלת איזה סוג סוגריים להשתמש כשזוהו כמה סוגים בטקסט.
/// נבנתה כ-overlay פשוט (אין מערכת מודלים קיימת באפליקציה) — מוסרת
/// את עצמה מיד לאחר בחירה.
function showBracketChoiceModal(types, onChoose){
    const existing = document.getElementById('bracketChoiceOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'bracketChoiceOverlay';
    overlay.className = 'bracket-choice-overlay';
    overlay.innerHTML = `
        <div class="bracket-choice-box">
            <div class="bracket-choice-title">זוהו כמה סוגי סוגריים בטקסט — איזה מהם משמש למקורות?</div>
            <div class="bracket-choice-opts">
                ${types.map(t => `<button class="bracket-choice-btn" data-type="${t}">${BRACKET_LABELS[t]}</button>`).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.bracket-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            onChoose(btn.dataset.type);
            overlay.remove();
        });
    });
}

/// מחבר טקסטאריה לרדיו-בוטונים של בחירת סוגריים: סוג יחיד → נבחר לבד;
/// כמה סוגים → נשאלת שאלה (רק פעם אחת לכל תוכן שונה, לא בכל הקשה).
function wireAutoBracketDetection(textareaId, radioGroupName, hintId){
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    const hintEl = hintId ? document.getElementById(hintId) : null;
    let lastSignature = '';
    let debounceTimer = null;

    textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const text = textarea.value;
            const types = detectBracketTypes(text);
            const signature = types.join(',');
            if (!types.length || signature === lastSignature) return;
            lastSignature = signature;

            const setBracket = (type) => {
                const radio = document.querySelector(`input[name="${radioGroupName}"][value="${type}"]`);
                if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
                if (hintEl) {
                    hintEl.textContent = `✓ זוהה אוטומטית: ${BRACKET_LABELS[type]}`;
                    setTimeout(() => { if (hintEl.textContent.startsWith('✓')) hintEl.textContent = ''; }, 4000);
                }
            };

            if (types.length === 1) {
                setBracket(types[0]);
            } else {
                showBracketChoiceModal(types, setBracket);
            }
        }, 500);
    });
}

wireAutoBracketDetection('pasteTextArea', 'brackets', 'bracketsAutoHint');
wireAutoBracketDetection('biblioText', 'biblioBrackets', 'biblioBracketsAutoHint');
