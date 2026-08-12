/* =====================================================
   עורך עריכה אנליטי — analyzer.js
   ניתוח ר"ת, סוגריים, ועקביות — HITL
   ===================================================== */
'use strict';

// ══════════════════════════════════════════════════════
//  קבועים
// ══════════════════════════════════════════════════════
const BRACKET_PAIRS = {
    curly:  ['{', '}'],
    square: ['[', ']'],
    round:  ['(', ')'],
};

// ביטויים לזיהוי ר"ת (ראשי תיבות) נפוצים
const ACRONYM_RE = /[א-ת]["״']([ \u05d0-\u05ea]|$)|(?:^|[\s({\[])([א-ת]"[א-ת])/gmu;

// ר"ת נפוצים שהמערכת מכירה
const KNOWN_ACRONYMS = new Set([
    'רמב"ם','רש"י','ר"ן','ר"ת','ר"ח','רמ"א','ריטב"א','ר"א','ר"י','ר"ש',
    'רשב"א','רשב"ם','רשב"ג','ריב"ש','מהר"ם','מהרש"א','מהרש"ל','מהרי"ל',
    'ב"ח','ט"ז','ש"ך','מ"ב','מ"א','פמ"ג','ח"מ','א"ח','יו"ד','אה"ע',
    'ב"י','ב"מ','ב"ב','ב"ק','ב"כ','כ"י','כ"מ','ד"ה','ד"א','ס"ד','ס"ל',
    'ע"ב','ע"א','ל"ה','לא"ש','ל"ד','כ"ד','כ"ג','כ"ב','כ"א',
    'ז"ל','ע"ה','ע"ש','ע"פ','ע"פ','ע"ז','ע"כ','כ"ף','צ"ע',
    'ק"ו','קצ"ו','קל"ח','תרי"ג','ת"ח','ת"ת','ת"ר','ת"ש',
]);

// ══════════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════════
let _rows = [];          // כל שורות הניתוח
let _decisions = {};     // {rowId: {action:'keep'|'replace', replacement:''}}
let _filterSev = 'all';  // 'all'|'error'|'warning'|'ok'
let _ctxPopup = null;

// ══════════════════════════════════════════════════════
//  ניתוח הטקסט
// ══════════════════════════════════════════════════════
function analyzeText(text, bracketType) {
    const rows = [];
    let id = 0;
    const lines = text.split('\n');
    const [open, close] = BRACKET_PAIRS[bracketType] || BRACKET_PAIRS.curly;

    // ── 1. בדיקת סוגריים לא סגורים / לא פתוחים ──────
    let depth = 0;
    let openPos = null;
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        for (let ci = 0; ci < line.length; ci++) {
            const ch = line[ci];
            if (ch === open) {
                if (depth > 0) {
                    rows.push({
                        id: id++, line: li + 1, col: ci + 1,
                        snippet: buildSnippet(lines, li, ci, 30),
                        severity: 'error',
                        reason: `סוגר פותח "${open}" בתוך סוגר פתוח — סוגריים מקוננים`,
                        category: 'bracket',
                        original: open,
                    });
                }
                depth++; openPos = { li, ci };
            } else if (ch === close) {
                if (depth === 0) {
                    rows.push({
                        id: id++, line: li + 1, col: ci + 1,
                        snippet: buildSnippet(lines, li, ci, 30),
                        severity: 'error',
                        reason: `סוגר סוגר "${close}" ללא סוגר פותח מקביל`,
                        category: 'bracket',
                        original: close,
                    });
                } else {
                    depth--;
                    openPos = null;
                }
            }
        }
    }
    if (depth > 0 && openPos) {
        rows.push({
            id: id++, line: openPos.li + 1, col: openPos.ci + 1,
            snippet: buildSnippet(lines, openPos.li, openPos.ci, 30),
            severity: 'error',
            reason: `סוגר פותח "${open}" שנשאר ללא סגירה עד סוף המסמך`,
            category: 'bracket',
            original: open,
        });
    }

    // ── 2. ניתוח תוכן הסוגריים ───────────────────────
    const bracketContentRe = new RegExp(
        escRegex(open) + '([^' + escRegex(open) + escRegex(close) + ']+)' + escRegex(close),
        'g'
    );
    // ספירת מופעים לכל מקור
    const sourceCount = {};
    for (let li = 0; li < lines.length; li++) {
        let m;
        bracketContentRe.lastIndex = 0;
        while ((m = bracketContentRe.exec(lines[li])) !== null) {
            const content = m[1].trim();
            sourceCount[content] = (sourceCount[content] || 0) + 1;
        }
    }
    // בדוק מקורות עם מופעים רבים מאוד
    for (const [src, cnt] of Object.entries(sourceCount)) {
        if (cnt >= 5) {
            rows.push({
                id: id++, line: null, col: null,
                snippet: `${open}${src}${close}`,
                severity: 'warning',
                reason: `המקור מופיע ${cnt} פעמים — שקול אם כדאי להוסיף קיצור או להסביר בפעם הראשונה`,
                category: 'frequency',
                original: src,
            });
        }
    }

    // ── 3. ר"ת (ראשי תיבות) ─────────────────────────
    const gershRe = /([א-ת]+["״][א-ת]+(?:["״][א-ת]+)*)/gu;
    for (let li = 0; li < lines.length; li++) {
        let m;
        gershRe.lastIndex = 0;
        while ((m = gershRe.exec(lines[li])) !== null) {
            const word = m[1];
            if (KNOWN_ACRONYMS.has(word)) continue; // ר"ת מוכר — דלג
            rows.push({
                id: id++, line: li + 1, col: m.index + 1,
                snippet: buildSnippet(lines, li, m.index, 40, word.length),
                severity: 'warning',
                reason: `ר"ת לא-מוכר: "${word}" — שקול ביאור בסוגריים בהופעה הראשונה`,
                category: 'acronym',
                original: word,
            });
        }
    }

    // ── 4. עקביות כתיב ───────────────────────────────
    // זיהוי מקורות דומים שנכתבו בצורות שונות
    const allSources = Object.keys(sourceCount);
    const usedPairs = new Set();
    for (let i = 0; i < allSources.length; i++) {
        for (let j = i + 1; j < allSources.length; j++) {
            const a = allSources[i], b = allSources[j];
            if (usedPairs.has(a + '|' + b)) continue;
            if (similarEnough(a, b)) {
                usedPairs.add(a + '|' + b);
                rows.push({
                    id: id++, line: null, col: null,
                    snippet: `${open}${a}${close}  vs  ${open}${b}${close}`,
                    severity: 'warning',
                    reason: `שני כתיבים דומים לאותו מקור — שקול אחידות`,
                    category: 'consistency',
                    original: b,
                    suggestion: a,
                });
            }
        }
    }

    return rows;
}

// ══════════════════════════════════════════════════════
//  עזרים
// ══════════════════════════════════════════════════════
function buildSnippet(lines, li, ci, radius = 30, markLen = 0) {
    const line = lines[li] || '';
    const start = Math.max(0, ci - radius);
    const end   = Math.min(line.length, ci + Math.max(markLen, 1) + radius);
    const before = line.slice(start, ci);
    const marked = line.slice(ci, ci + Math.max(markLen, 1));
    const after  = line.slice(ci + Math.max(markLen, 1), end);
    return (start > 0 ? '…' : '') + before +
           '<mark>' + esc(marked) + '</mark>' +
           esc(after) + (end < line.length ? '…' : '');
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}

function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function similarEnough(a, b) {
    if (Math.abs(a.length - b.length) > 4) return false;
    if (a === b) return false;
    // normalization: strip geresh, spaces, maqqef
    const norm = s => s.replace(/["״'\u05f4\u05f3\u2019\u05be\s]/g,'').replace(/ה$/,'');
    return norm(a) === norm(b) && norm(a).length > 2;
}

function sevLabel(sev) {
    if (sev === 'error')   return '<span class="sev-badge error">שגיאה</span>';
    if (sev === 'warning') return '<span class="sev-badge warning">אזהרה</span>';
    return '<span class="sev-badge ok">תקין</span>';
}

// ══════════════════════════════════════════════════════
//  רינדור הטבלה
// ══════════════════════════════════════════════════════
function renderTable() {
    const tbody = document.getElementById('analyzerTbody');
    if (!tbody) return;

    const visible = _filterSev === 'all'
        ? _rows
        : _rows.filter(r => r.severity === _filterSev);

    if (visible.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5">
            <div class="analyzer-empty">
                <div class="empty-icon">✅</div>
                ${_rows.length === 0 ? 'לא נמצאו ממצאים' : 'אין ממצאים בסינון זה'}
            </div></td></tr>`;
        return;
    }

    tbody.innerHTML = visible.map(row => {
        const dec = _decisions[row.id] || { action: 'keep', replacement: row.suggestion || '' };
        const locStr = row.line ? `שורה ${row.line}${row.col ? ', עמ\' ' + row.col : ''}` : 'כלל-מסמכי';

        return `
<tr class="sev-${row.severity}" data-row-id="${row.id}">
  <td class="analyzer-loc">${esc(locStr)}</td>
  <td class="analyzer-snippet" data-row-id="${row.id}" title="לחץ לתצוגת הקשר">${row.snippet}</td>
  <td>${sevLabel(row.severity)}<div class="analyzer-reason" style="margin-top:4px">${esc(row.reason)}</div></td>
  <td class="analyzer-action-cell">
    <div class="action-radios">
      <label class="action-radio-label">
        <input type="radio" name="action-${row.id}" value="keep" ${dec.action==='keep'?'checked':''} />
        שמור
      </label>
      <label class="action-radio-label">
        <input type="radio" name="action-${row.id}" value="replace" ${dec.action==='replace'?'checked':''} />
        החלף
      </label>
    </div>
    <div class="replacement-wrap" style="${dec.action==='replace'?'':'display:none'}">
      <input class="replacement-input" type="text" placeholder="טקסט חלופי…" dir="rtl"
             value="${esc(dec.replacement)}" data-row-id="${row.id}" />
      <button class="apply-btn${dec.applied?' applied':''}" data-row-id="${row.id}">
        ${dec.applied ? '✓ הוחל' : 'החל'}
      </button>
    </div>
  </td>
</tr>`;
    }).join('');
}

function renderKpis() {
    const errors   = _rows.filter(r => r.severity === 'error').length;
    const warnings = _rows.filter(r => r.severity === 'warning').length;
    const ok       = _rows.filter(r => r.severity === 'ok').length;
    const box = document.getElementById('analyzerKpis');
    if (!box) return;
    box.innerHTML = `
      <div class="analyzer-kpi kpi-red">
        <div class="analyzer-kpi-val">${errors}</div>
        <div class="analyzer-kpi-label">שגיאות</div>
      </div>
      <div class="analyzer-kpi kpi-yellow">
        <div class="analyzer-kpi-val">${warnings}</div>
        <div class="analyzer-kpi-label">אזהרות</div>
      </div>
      <div class="analyzer-kpi kpi-green">
        <div class="analyzer-kpi-val">${ok}</div>
        <div class="analyzer-kpi-label">תקין</div>
      </div>
      <div class="analyzer-kpi">
        <div class="analyzer-kpi-val">${_rows.length}</div>
        <div class="analyzer-kpi-label">סה"כ ממצאים</div>
      </div>`;
}

// ══════════════════════════════════════════════════════
//  ייצוא
// ══════════════════════════════════════════════════════
function exportCsv() {
    const headers = ['שורה','קטע','חומרה','סיבה','פעולה','תחליף'];
    const rows = _rows.map(r => {
        const dec = _decisions[r.id] || { action: 'keep', replacement: '' };
        return [
            r.line || '',
            '"' + (r.original || '').replace(/"/g,'""') + '"',
            r.severity,
            '"' + r.reason.replace(/"/g,'""') + '"',
            dec.action,
            '"' + (dec.replacement || '').replace(/"/g,'""') + '"',
        ].join(',');
    });
    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ניתוח.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCorrectedText() {
    const text = document.getElementById('analyzerInput')?.value || '';
    // החלף לפי ההחלטות (מהסוף לתחילה למניעת הזזת אינדקסים)
    const replacements = _rows
        .filter(r => {
            const dec = _decisions[r.id];
            return dec && dec.action === 'replace' && dec.replacement && r.line;
        })
        .sort((a, b) => (b.line - a.line) || ((b.col || 0) - (a.col || 0)));

    let lines = text.split('\n');
    for (const row of replacements) {
        const li = row.line - 1;
        if (li < 0 || li >= lines.length) continue;
        const dec = _decisions[row.id];
        if (row.category === 'acronym' || row.category === 'consistency') {
            lines[li] = lines[li].replaceAll(row.original, dec.replacement);
        }
    }
    const out = lines.join('\n');
    const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'טקסט-מתוקן.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ══════════════════════════════════════════════════════
//  context popup
// ══════════════════════════════════════════════════════
function showCtxPopup(rowId, anchorEl) {
    hideCtxPopup();
    const row = _rows.find(r => r.id === +rowId);
    if (!row || !row.line) return;
    const text = document.getElementById('analyzerInput')?.value || '';
    const lines = text.split('\n');
    const li = row.line - 1;
    const ctx = lines.slice(Math.max(0, li - 1), Math.min(lines.length, li + 2))
        .map((l, i) => {
            const lineNum = Math.max(0, li - 1) + i;
            const content = lineNum === li
                ? l.replace(row.original, '<mark>' + esc(row.original) + '</mark>')
                : esc(l);
            return `<div style="${lineNum===li?'color:var(--gold)':''}">${content || '&nbsp;'}</div>`;
        }).join('');

    const popup = document.createElement('div');
    popup.className = 'ctx-popup';
    popup.innerHTML = `<div class="ctx-popup-label">הקשר — שורה ${row.line}</div>${ctx}`;
    document.body.appendChild(popup);
    _ctxPopup = popup;

    const rect = anchorEl.getBoundingClientRect();
    const top = rect.bottom + 6;
    const right = window.innerWidth - rect.right;
    popup.style.top  = Math.min(top, window.innerHeight - 160) + 'px';
    popup.style.right = Math.max(8, right) + 'px';
}

function hideCtxPopup() {
    if (_ctxPopup) { _ctxPopup.remove(); _ctxPopup = null; }
}

// ══════════════════════════════════════════════════════
//  אתחול ואירועים
// ══════════════════════════════════════════════════════
function initAnalyzer() {
    const runBtn    = document.getElementById('analyzerRunBtn');
    const clearBtn  = document.getElementById('analyzerClearBtn');
    const csvBtn    = document.getElementById('analyzerExportCsv');
    const txtBtn    = document.getElementById('analyzerExportTxt');
    const table     = document.getElementById('analyzerTable');
    const results   = document.getElementById('analyzerResults');
    const filterBar = document.getElementById('analyzerFilterBar');

    if (!runBtn) return; // טאב לא נמצא ב-DOM

    // ── הרצת ניתוח ──────────────────────────────────
    runBtn.addEventListener('click', () => {
        const text = document.getElementById('analyzerInput')?.value?.trim() || '';
        if (!text) {
            document.getElementById('analyzerStatus').textContent = 'יש להזין טקסט לניתוח.';
            document.getElementById('analyzerStatus').style.display = 'block';
            return;
        }
        const bracketType = document.querySelector('input[name="analyzerBrackets"]:checked')?.value || 'curly';
        document.getElementById('analyzerStatus').style.display = 'none';
        _decisions = {};
        _rows = analyzeText(text, bracketType);
        _filterSev = 'all';
        // עדכן chips
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.sev === 'all'));

        results.style.display = '';
        renderKpis();
        renderTable();
    });

    // ── ניקוי ───────────────────────────────────────
    clearBtn.addEventListener('click', () => {
        document.getElementById('analyzerInput').value = '';
        results.style.display = 'none';
        _rows = []; _decisions = {};
    });

    // ── פילטרים ─────────────────────────────────────
    filterBar.addEventListener('click', e => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        _filterSev = chip.dataset.sev;
        document.querySelectorAll('.filter-chip').forEach(c =>
            c.classList.toggle('active', c.dataset.sev === _filterSev));
        renderTable();
    });

    // ── פעולות בטבלה (delegated) ────────────────────
    table.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (!radio) return;
        const rowId = +radio.name.replace('action-', '');
        if (!_decisions[rowId]) _decisions[rowId] = { action: 'keep', replacement: '' };
        _decisions[rowId].action = radio.value;
        _decisions[rowId].applied = false;
        // הצג/הסתר שדה החלפה
        const wrap = radio.closest('td').querySelector('.replacement-wrap');
        if (wrap) wrap.style.display = radio.value === 'replace' ? '' : 'none';
    });

    table.addEventListener('input', e => {
        const inp = e.target.closest('.replacement-input');
        if (!inp) return;
        const rowId = +inp.dataset.rowId;
        if (!_decisions[rowId]) _decisions[rowId] = { action: 'replace', replacement: '' };
        _decisions[rowId].replacement = inp.value;
        _decisions[rowId].applied = false;
        const btn = inp.closest('.replacement-wrap')?.querySelector('.apply-btn');
        if (btn) { btn.textContent = 'החל'; btn.classList.remove('applied'); }
    });

    table.addEventListener('click', e => {
        // כפתור החל
        const applyBtn = e.target.closest('.apply-btn');
        if (applyBtn) {
            const rowId = +applyBtn.dataset.rowId;
            if (!_decisions[rowId]) _decisions[rowId] = {};
            _decisions[rowId].applied = true;
            applyBtn.textContent = '✓ הוחל';
            applyBtn.classList.add('applied');
            return;
        }
        // snippet — הצג הקשר
        const snippet = e.target.closest('.analyzer-snippet');
        if (snippet) {
            showCtxPopup(snippet.dataset.rowId, snippet);
            return;
        }
        hideCtxPopup();
    });

    // ── ייצוא ───────────────────────────────────────
    csvBtn?.addEventListener('click', exportCsv);
    txtBtn?.addEventListener('click', exportCorrectedText);

    // סגור popup בלחיצה חיצונית
    document.addEventListener('click', e => {
        if (!e.target.closest('.analyzer-snippet') && !e.target.closest('.ctx-popup')) hideCtxPopup();
    });
}

// אתחול כשה-DOM מוכן
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnalyzer);
} else {
    initAnalyzer();
}
