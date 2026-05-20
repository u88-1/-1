const fs      = require('fs');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_DB_PATH     = 'C:/ProgramData/otzaria/books/seforim.db';
const MAX_RESULTS_PER_REF = 5;
const SEFARIA_CONCURRENCY = 6;
const DB_CONCURRENCY      = 10;

const BAVLI_TRACTATES = new Set([
    'ברכות','שבת','עירובין','פסחים','שקלים','יומא','סוכה','ביצה',
    'ראש השנה','תענית','מגילה','מועד קטן','חגיגה','יבמות','כתובות',
    'נדרים','נזיר','סוטה','גיטין','קידושין','בבא קמא','בבא מציעא',
    'בבא בתרא','סנהדרין','מכות','שבועות','עדויות','עבודה זרה','אבות',
    'הוריות','זבחים','מנחות','חולין','בכורות','ערכין','תמורה','כריתות',
    'מעילה','תמיד','מידות','קינים','נדה',
]);

const HEB_VALS = {
    'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,
    'י':10,'כ':20,'ך':20,'ל':30,'מ':40,'ם':40,'נ':50,'ן':50,
    'ס':60,'ע':70,'פ':80,'ף':80,'צ':90,'ץ':90,'ק':100,'ר':200,'ש':300,'ת':400,
};
function hebrewToNumber(str) {
    const clean=str.replace(/[״׳"']/g,'').trim();
    if(!clean)return null;
    let sum=0;
    for(const ch of clean){if(HEB_VALS[ch]===undefined)return null;sum+=HEB_VALS[ch];}
    return sum>0?sum:null;
}
function replaceHebrewNumbers(text){
    return text.replace(/(?<![א-ת])([א-ת״׳"']{1,6})(?![א-ת])/g,m=>{
        const n=hebrewToNumber(m);return(n!==null&&n>0)?String(n):m;
    });
}
function normalizeTalmudPage(ref){
    ref=ref.replace(/([א-ת\d]+)\s+ע(?:מוד)?\s*["״]?א/g,(_,pg)=>_normPage(pg,'.'));
    ref=ref.replace(/([א-ת\d]+)\s+ע(?:מוד)?\s*["״]?ב/g,(_,pg)=>_normPage(pg,':'));
    ref=ref.replace(/(\d+)([אב])\b/g,(_,n,s)=>n+(s==='א'?'.':':'));
    ref=ref.replace(/([א-ת]{1,4})([.:])(?!\d)/g,(_,heb,dot)=>{
        const n=hebrewToNumber(heb);return n!=null?n+dot:heb+dot;
    });
    return ref;
}
function _normPage(pg,dot){
    const n=/^\d+$/.test(pg)?pg:(()=>{const v=hebrewToNumber(pg);return v?String(v):pg;})();
    return n+dot;
}

const TRACTATE_MAP={
    'ברכות':['ברכות'],"ברכ'":['ברכות'],
    'שבת':['שבת'],"שב'":['שבת'],
    'עירובין':['עירובין'],"עירו'":['עירובין'],
    'פסחים':['פסחים'],"פסח'":['פסחים'],
    'שקלים':['שקלים'],'יומא':['יומא'],'סוכה':['סוכה'],'ביצה':['ביצה'],
    'ראש השנה':['ראש השנה'],'ר"ה':['ראש השנה'],
    'תענית':['תענית'],"תענ'":['תענית'],
    'מגילה':['מגילה'],"מגיל'":['מגילה'],
    'מועד קטן':['מועד קטן'],'מו"ק':['מועד קטן'],
    'חגיגה':['חגיגה'],"חגיג'":['חגיגה'],
    'יבמות':['יבמות'],"יבמ'":['יבמות'],
    'כתובות':['כתובות'],"כתוב'":['כתובות'],
    'נדרים':['נדרים'],"נדר'":['נדרים'],
    'נזיר':['נזיר'],'סוטה':['סוטה'],
    'גיטין':['גיטין'],"גיט'":['גיטין'],
    'קידושין':['קידושין'],"קיד'":['קידושין'],
    'בבא קמא':['בבא קמא'],'ב"ק':['בבא קמא'],"ב'ק":['בבא קמא'],
    'בבא מציעא':['בבא מציעא'],'ב"מ':['בבא מציעא'],"ב'מ":['בבא מציעא'],
    'בבא בתרא':['בבא בתרא'],'ב"ב':['בבא בתרא'],"ב'ב":['בבא בתרא'],
    'סנהדרין':['סנהדרין'],"סנה'":['סנהדרין'],
    'מכות':['מכות'],'שבועות':['שבועות'],"שבוע'":['שבועות'],
    'עדויות':['עדויות'],'עבודה זרה':['עבודה זרה'],'ע"ז':['עבודה זרה'],
    'אבות':['אבות'],'הוריות':['הוריות'],
    'זבחים':['זבחים'],"זבח'":['זבחים'],
    'מנחות':['מנחות'],"מנח'":['מנחות'],
    'חולין':['חולין'],"חול'":['חולין'],
    'בכורות':['בכורות'],"בכור'":['בכורות'],
    'ערכין':['ערכין'],'תמורה':['תמורה'],
    'כריתות':['כריתות'],"כרית'":['כריתות'],
    'מעילה':['מעילה'],'תמיד':['תמיד'],'נדה':['נדה'],
};
const ABBREV_LIST=Object.keys(TRACTATE_MAP).sort((a,b)=>b.length-a.length);

function expandTractateAbbreviations(ref){
    for(const abbr of ABBREV_LIST){
        const targets=TRACTATE_MAP[abbr];if(!targets?.length)continue;
        const escaped=abbr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const re=new RegExp(`^${escaped}(?=[\\s,.]|$)`,'i');
        if(re.test(ref.trim()))return targets.map(t=>ref.trim().replace(re,t));
    }
    return[ref];
}

function cleanPath(p){return(p||'').trim().replace(/^["']+|["']+$/g,'').trim();}
function normalizeRef(ref){
    return ref.replace(/[\u0000-\u001F\u007F]/g,'').replace(/[""«»„\u201f]/g,'"')
        .replace(/[''\u201b]/g,"'").replace(/\s+/g,' ')
        .replace(/^(על פי\s+)/i,'').replace(/[.,;:]+$/g,'').trim();
}
function generateVariants(ref){
    const base=normalizeRef(ref);
    const variants=new Set([base]);
    const wp=normalizeTalmudPage(base);if(wp!==base)variants.add(wp);
    for(const v of[...variants]){const wa=replaceHebrewNumbers(v);if(wa!==v)variants.add(wa);}
    for(const v of[...variants]){
        for(const e of expandTractateAbbreviations(v)){
            variants.add(e);
            const ea=replaceHebrewNumbers(e);if(ea!==e)variants.add(ea);
            const ep=normalizeTalmudPage(e);if(ep!==e)variants.add(ep);
            const epa=replaceHebrewNumbers(ep);if(epa!==ep)variants.add(epa);
        }
    }
    return[...variants];
}
function detectBavli(ref){
    const norm=normalizeRef(ref);
    for(const t of BAVLI_TRACTATES){if(norm.startsWith(t))return t;}
    return null;
}

// ── Extract text from different file types ────────────────────────────────────
async function extractText(filePath){
    const ext=path.extname(filePath).toLowerCase();
    if(ext==='.txt'){
        return fs.readFileSync(filePath,'utf8');
    }
    if(ext==='.docx'){
        const mammoth=require('mammoth');
        const result=await mammoth.extractRawText({path:filePath});
        return result.value||'';
    }
    if(ext==='.pdf'){
        const pdfParse=require('pdf-parse');
        const buf=fs.readFileSync(filePath);
        const data=await pdfParse(buf);
        return data.text||'';
    }
    // fallback — try as text
    return fs.readFileSync(filePath,'utf8');
}

// ── Context extraction ────────────────────────────────────────────────────────
function extractContext(fullText,refRaw,brackets){
    const {open,close}=getBracketChars(brackets);
    const eo=open.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const ec=close.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const er=refRaw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(eo+er+ec);
    const match=re.exec(fullText);
    if(!match)return{sentence:'',quoteBefore:''};
    const pos=match.index,after=pos+match[0].length;
    let start=pos;while(start>0&&!/[.\n]/.test(fullText[start-1]))start--;
    let end=after;while(end<fullText.length&&!/[.\n]/.test(fullText[end]))end++;
    const sentence=fullText.slice(start,end).trim();
    const before=fullText.slice(Math.max(0,pos-200),pos);
    const qm=before.match(/["״"]([\s\S]{2,80})["״"]?\s*$/)||before.match(/[–—]\s*([\s\S]{2,60})\s*$/);
    return{sentence,quoteBefore:qm?qm[1].trim():''};
}

function getBracketChars(brackets){
    switch(brackets){
        case 'square': return{open:'[',close:']'};
        case 'round':  return{open:'(',close:')'};
        default:       return{open:'{',close:'}'};
    }
}

// ── DB Query ──────────────────────────────────────────────────────────────────
function queryRef(db,ref,options={},signal=null){
    const variants=generateVariants(ref);
    const useFuzzy=options.fuzzy!==false;
    return new Promise(resolve=>{
        if(!variants.length||signal?.aborted)
            return resolve({ref,rows:[],matchType:'none',variantsTried:variants});
        const allRows=new Map();
        let resolved=false;
        function finish(){
            if(resolved)return;resolved=true;
            const rows=[...allRows.values()].slice(0,MAX_RESULTS_PER_REF).map(({row,matchType:mt})=>({
                heRef:row.heRef,bookTitle:row.bookTitle,filePath:row.bookPath,
                lineIndex:row.lineIndex,lineId:row.lineId,
                content:(row.content||'').replace(/<[^>]+>/g,'').trim(),matchType:mt,
            }));
            const best=allRows.size===0?'none'
                :[...allRows.values()].some(r=>r.matchType==='exact')?'exact'
                :[...allRows.values()].some(r=>r.matchType==='prefix')?'prefix':'fuzzy';
            resolve({ref,rows,matchType:best,variantsTried:variants});
        }
        const SQL=`SELECT l.id AS lineId,l.lineIndex,l.heRef,l.content,b.title AS bookTitle,b.filePath AS bookPath FROM line l JOIN book b ON l.bookId=b.id WHERE `;
        (async()=>{
            for(const v of variants){
                if(resolved||signal?.aborted)break;
                await new Promise(r=>db.all(SQL+'l.heRef=? COLLATE NOCASE LIMIT ?',[v,MAX_RESULTS_PER_REF],(e,rows)=>{
                    if(!e&&rows?.length)rows.forEach(row=>{if(!allRows.has(row.lineId))allRows.set(row.lineId,{row,matchType:'exact'});});r();
                }));
                if([...allRows.values()].some(x=>x.matchType==='exact'))return finish();
                await new Promise(r=>db.all(SQL+'l.heRef LIKE ? COLLATE NOCASE LIMIT ?',[v+'%',MAX_RESULTS_PER_REF],(e,rows)=>{
                    if(!e&&rows?.length)rows.forEach(row=>{if(!allRows.has(row.lineId))allRows.set(row.lineId,{row,matchType:'prefix'});});r();
                }));
                if(useFuzzy&&v.length>=4){
                    await new Promise(r=>db.all(SQL+'l.heRef LIKE ? COLLATE NOCASE LIMIT ?',['%'+v+'%',MAX_RESULTS_PER_REF],(e,rows)=>{
                        if(!e&&rows?.length)rows.forEach(row=>{if(!allRows.has(row.lineId))allRows.set(row.lineId,{row,matchType:'fuzzy'});});r();
                    }));
                }
            }
            finish();
        })();
    });
}

function fetchPageLines(db,lineId,radius=40){
    return new Promise(resolve=>{
        db.get('SELECT bookId,lineIndex FROM line WHERE id=?',[lineId],(e,row)=>{
            if(e||!row)return resolve([]);
            const{bookId,lineIndex}=row;
            db.all(`SELECT l.id,l.lineIndex,l.heRef,l.content FROM line l WHERE l.bookId=? AND l.lineIndex BETWEEN ? AND ? ORDER BY l.lineIndex`,
                [bookId,Math.max(0,lineIndex-radius),lineIndex+radius],
                (e2,rows)=>resolve(e2?[]:(rows||[]).map(r=>({
                    lineId:r.id,lineIndex:r.lineIndex,heRef:r.heRef,
                    content:(r.content||'').replace(/<[^>]+>/g,'').trim(),isFocus:r.id===lineId,
                })))
            );
        });
    });
}

// ── Sefaria ───────────────────────────────────────────────────────────────────
const SEFARIA_EN={
    'ברכות':'Berakhot','שבת':'Shabbat','עירובין':'Eruvin','פסחים':'Pesachim',
    'שקלים':'Shekalim','יומא':'Yoma','סוכה':'Sukkah','ביצה':'Beitzah',
    'ראש השנה':'Rosh Hashanah','תענית':'Taanit','מגילה':'Megillah',
    'מועד קטן':'Moed Katan','חגיגה':'Chagigah','יבמות':'Yevamot',
    'כתובות':'Ketubot','נדרים':'Nedarim','נזיר':'Nazir','סוטה':'Sotah',
    'גיטין':'Gittin','קידושין':'Kiddushin','בבא קמא':'Bava Kamma',
    'בבא מציעא':'Bava Metzia','בבא בתרא':'Bava Batra','סנהדרין':'Sanhedrin',
    'מכות':'Makkot','שבועות':'Shevuot','עבודה זרה':'Avodah Zarah',
    'הוריות':'Horayot','זבחים':'Zevachim','מנחות':'Menachot','חולין':'Chullin',
    'בכורות':'Bekhorot','ערכין':'Arakhin','תמורה':'Temurah','כריתות':'Keritot',
    'מעילה':'Meilah','תמיד':'Tamid','נדה':'Niddah',
    'בראשית':'Genesis','שמות':'Exodus','ויקרא':'Leviticus','במדבר':'Numbers','דברים':'Deuteronomy',
    'יהושע':'Joshua','שופטים':'Judges','תהלים':'Psalms','משלי':'Proverbs',
    'איוב':'Job','שיר השירים':'Song of Songs','רות':'Ruth','איכה':'Lamentations',
    'קהלת':'Ecclesiastes','אסתר':'Esther','דניאל':'Daniel','עזרא':'Ezra','נחמיה':'Nehemiah',
};
function refToSefariaPath(ref){
    const norm=normalizeRef(ref);
    const m=norm.match(/^(.+?)\s+(\d+|[א-ת]{1,4})\s*[,.:]\s*(\d+|[א-ת]{1,4}\.?:?)?$/);
    if(!m)return null;
    let[,book,ch,vs]=m;book=book.trim();
    const enBook=SEFARIA_EN[book];if(!enBook)return null;
    const chN=hebrewToNumber(ch.replace(/[.:'״׳]/g,''))??(/^\d+$/.test(ch)?Number(ch):null);
    if(!chN)return null;
    if(!vs)return`${enBook}.${chN}`;
    const vsClean=String(vs).replace(/[.:'״׳]/g,'');
    const vsN=hebrewToNumber(vsClean)??(/^\d+$/.test(vsClean)?Number(vsClean):null);
    return vsN?`${enBook}.${chN}.${vsN}`:`${enBook}.${chN}`;
}
async function queryRefSefaria(ref,signal=null){
    if(signal?.aborted)return{ref,source:'sefaria',found:false};
    const spath=refToSefariaPath(ref);if(!spath)return{ref,source:'sefaria',found:false};
    try{
        const fetch=(await import('node-fetch')).default;
        const url=`https://www.sefaria.org/api/texts/${encodeURIComponent(spath)}?lang=he&context=0`;
        const res=await fetch(url,{signal:signal||AbortSignal.timeout(7000)});
        if(!res.ok)return{ref,source:'sefaria',found:false};
        const data=await res.json();
        let rawHe=data.he||data.text||'';
        if(Array.isArray(rawHe))rawHe=rawHe.flat(5).filter(Boolean).join(' ');
        const content=String(rawHe).replace(/<[^>]+>/g,'').trim();
        if(!content)return{ref,source:'sefaria',found:false};
        return{ref,source:'sefaria',found:true,sefariaPath:spath,
            sefariaUrl:`https://www.sefaria.org/${spath}`,content:content.substring(0,600),
            heRef:data.ref||spath,bookTitle:data.book||spath.split('.')[0],matchType:'sefaria'};
    }catch{return{ref,source:'sefaria',found:false};}
}

// ── Extract refs from text ────────────────────────────────────────────────────
function getReferencesWithContext(text,brackets='curly'){
    const{open,close}=getBracketChars(brackets);
    const eo=open.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const ec=close.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const regex=new RegExp(eo+'([^'+ec+']+)'+ec,'g');
    const refs=[];let match;
    while((match=regex.exec(text))!==null){
        const raw=match[1];const ref=normalizeRef(raw);if(!ref)continue;
        const{sentence,quoteBefore}=extractContext(text,raw,brackets);
        refs.push({ref,raw,sentence,quoteBefore});
    }
    return refs;
}

async function runWithConcurrency(items,fn,limit,signal=null){
    const results=new Array(items.length);let idx=0;
    async function worker(){
        while(idx<items.length){
            if(signal?.aborted)break;
            const i=idx++;results[i]=await fn(items[i]);
        }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
    return results;
}

// ── Main streaming function ───────────────────────────────────────────────────
async function runComparisonStreaming(inputFile,dbPath,options={},onResult,onDone,signal=null){
    const resolvedInputFile=cleanPath(inputFile);
    const resolvedDbPath=cleanPath(dbPath)||DEFAULT_DB_PATH;
    const brackets=options.brackets||'curly';

    if(!fs.existsSync(resolvedInputFile)){onDone({error:'קובץ לא נמצא: '+resolvedInputFile});return;}
    if(!fs.existsSync(resolvedDbPath)){onDone({error:'מסד הנתונים לא נמצא: '+resolvedDbPath});return;}

    let text;
    try{
        text=await extractText(resolvedInputFile);
    }catch(err){
        onDone({error:'שגיאה בקריאת הקובץ: '+err.message});return;
    }

    const allRefs=getReferencesWithContext(text,brackets);
    const seen=new Map();
    for(const r of allRefs){if(!seen.has(r.ref))seen.set(r.ref,r);}
    const uniqueRefs=[...seen.values()];

    if(!uniqueRefs.length){onDone({totalRefs:0,foundCount:0,notFoundCount:0,results:[]});return;}

    const db=new sqlite3.Database(resolvedDbPath,sqlite3.OPEN_READONLY,err=>{
        if(err){onDone({error:'שגיאה בפתיחת DB: '+err.message});return;}
    });

    const allResults=[];
    let foundCount=0,notFoundCount=0;

    try{
        let active=0,qi=0;
        await new Promise(resolve=>{
            function next(){
                while(active<DB_CONCURRENCY&&qi<uniqueRefs.length){
                    if(signal?.aborted){resolve();return;}
                    const item=uniqueRefs[qi++];active++;
                    queryRef(db,item.ref,options,signal).then(res=>{
                        if(signal?.aborted){active--;if(active===0&&qi>=uniqueRefs.length)resolve();next();return;}
                        const result={
                            ref:res.ref,matchType:res.matchType,
                            variantsTried:res.variantsTried||[],
                            rows:res.rows||[],row:res.rows?.length?res.rows[0]:null,
                            source:'local',sefariaData:null,
                            sentence:item.sentence||'',quoteBefore:item.quoteBefore||'',
                            isBavli:!!detectBavli(res.ref),
                        };
                        allResults.push(result);
                        if(result.rows.length>0)foundCount++;else notFoundCount++;
                        onResult(result,{done:false,total:uniqueRefs.length,processed:allResults.length,foundCount,notFoundCount});
                        active--;
                        if(active===0&&qi>=uniqueRefs.length)resolve();
                        else next();
                    });
                }
            }
            next();
        });

        // Sefaria fallback
        if(!signal?.aborted&&options.sefaria!==false){
            const notFoundLocally=allResults.filter(r=>r.rows.length===0);
            if(notFoundLocally.length>0){
                await runWithConcurrency(notFoundLocally,async r=>{
                    if(signal?.aborted)return;
                    const sf=await queryRefSefaria(r.ref,signal);
                    if(sf?.found){
                        r.source='sefaria';r.matchType='sefaria';r.sefariaData=sf;
                        r.rows=[{heRef:sf.heRef,bookTitle:sf.bookTitle,content:sf.content,
                            lineIndex:null,lineId:null,matchType:'sefaria',sefariaUrl:sf.sefariaUrl}];
                        r.row=r.rows[0];
                        notFoundCount--;foundCount++;
                        onResult(r,{done:false,total:uniqueRefs.length,processed:allResults.length,foundCount,notFoundCount,sefariaUpdate:true});
                    }
                },SEFARIA_CONCURRENCY,signal);
            }
        }

        db.close();
        onDone({
            totalRefs:uniqueRefs.length,foundCount,notFoundCount,
            sefariaFoundCount:allResults.filter(r=>r.source==='sefaria'&&r.rows.length>0).length,
            results:allResults,aborted:!!signal?.aborted,
        });
    }catch(err){try{db.close();}catch{}onDone({error:err.message});}
}

function runComparison(inputFile,dbPath,options={}){
    return new Promise((resolve,reject)=>{
        runComparisonStreaming(inputFile,dbPath,options,()=>{},
            summary=>{if(summary.error)reject(new Error(summary.error));else resolve(summary);}
        );
    });
}

function fetchTalmudPage(dbPath,lineId){
    const resolvedDbPath=cleanPath(dbPath)||DEFAULT_DB_PATH;
    return new Promise((resolve,reject)=>{
        const db=new sqlite3.Database(resolvedDbPath,sqlite3.OPEN_READONLY,err=>{if(err)return reject(err);});
        fetchPageLines(db,lineId,50).then(lines=>{db.close();resolve(lines);}).catch(err=>{db.close();reject(err);});
    });
}

if(require.main===module){
    const inputFile=process.argv[2];const dbPath=process.argv[3];
    if(!inputFile){console.error('שימוש: node compare_sources.js <קובץ> [DB]');process.exit(1);}
    runComparison(inputFile,dbPath).then(r=>console.log('נמצאו: '+r.foundCount+'/'+r.totalRefs)).catch(err=>{console.error(err.message);process.exit(1);});
}
module.exports={runComparison,runComparisonStreaming,fetchTalmudPage};
