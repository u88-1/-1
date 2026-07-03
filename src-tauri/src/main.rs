// ════════════════════════════════════════════════════════════════════════════
//  בודק מקורות  —  Tauri (Rust) core
//  פורט מלא של compare_sources.js: חילוץ, נרמול, וריאנטים, התאמה ב-SQLite + FTS5,
//  נפילה ל-Sefaria, והרחבת דף גמרא. מנוע סינכרוני (rusqlite) + Mutex<Connection>.
//  v4.1.5: Tantivy index על he_ref — חיפוש מהיר כמו אוצריא.
// ════════════════════════════════════════════════════════════════════════════
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fancy_regex::Regex as FRegex;
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

// Tantivy — בדיוק כמו בדוגמה הרשמית
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Schema as TantivySchema, TEXT, STORED, FAST};
use tantivy::schema::Value as TantivyValue;
use tantivy::{Index, IndexWriter, ReloadPolicy, TantivyDocument};

// ── Tantivy ───────────────────────────────────────────────────────────────


const DEFAULT_DB_PATH: &str = "C:/ProgramData/otzaria/books/seforim.db";
const MAX_RESULTS_PER_REF: i64 = 5;
const SEFARIA_CONCURRENCY: usize = 6;
// כמה זמן (בשניות) תוצאת Sefaria נשמרת במטמון מקומי לפני שנחשבת "ישנה"
// ונשלפת מחדש. טקסט תורני קנוני כמעט ולא משתנה, אז 180 יום זה שמרני וסביר.
const SEFARIA_CACHE_TTL_SECS: i64 = 60 * 60 * 24 * 180;
// מספר חיבורי קריאה-בלבד מקביליים לסריקה המקומית. עם Tantivy אנחנו פחות
// תלויים ב-IO כבד, אבל עדיין שומרים workers לסריקת תוכן מורחב.
const MAX_SCAN_WORKERS: usize = 4;

// ════════════════════════════════════════════════════════════════════════════
//  1. נתוני ליבה — מסכתות, גימטריה, קיצורים, מיפוי Sefaria
// ════════════════════════════════════════════════════════════════════════════

static BAVLI_TRACTATES: Lazy<Vec<&'static str>> = Lazy::new(|| {
    vec![
        "ברכות", "שבת", "עירובין", "פסחים", "שקלים", "יומא", "סוכה", "ביצה",
        "ראש השנה", "תענית", "מגילה", "מועד קטן", "חגיגה", "יבמות", "כתובות",
        "נדרים", "נזיר", "סוטה", "גיטין", "קידושין", "בבא קמא", "בבא מציעא",
        "בבא בתרא", "סנהדרין", "מכות", "שבועות", "עדויות", "עבודה זרה", "אבות",
        "הוריות", "זבחים", "מנחות", "חולין", "בכורות", "ערכין", "תמורה", "כריתות",
        "מעילה", "תמיד", "מידות", "קינים", "נדה",
    ]
});

fn heb_val(ch: char) -> Option<i64> {
    Some(match ch {
        'א' => 1, 'ב' => 2, 'ג' => 3, 'ד' => 4, 'ה' => 5, 'ו' => 6, 'ז' => 7,
        'ח' => 8, 'ט' => 9, 'י' => 10, 'כ' | 'ך' => 20, 'ל' => 30, 'מ' | 'ם' => 40,
        'נ' | 'ן' => 50, 'ס' => 60, 'ע' => 70, 'פ' | 'ף' => 80, 'צ' | 'ץ' => 90,
        'ק' => 100, 'ר' => 200, 'ש' => 300, 'ת' => 400,
        _ => return None,
    })
}

/// המרת מחרוזת אותיות עבריות למספר (גימטריה). מחזיר None אם יש תו לא-המרה.
fn hebrew_to_number(s: &str) -> Option<i64> {
    let clean: String = s.chars().filter(|c| !matches!(c, '״' | '׳' | '"' | '\'')).collect();
    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }
    let mut sum = 0i64;
    for ch in clean.chars() {
        match heb_val(ch) {
            Some(v) => sum += v,
            None => return None,
        }
    }
    if sum > 0 {
        Some(sum)
    } else {
        None
    }
}

// קיצורי מסכתות → שם מלא. ממוין בהמשך מהארוך לקצר.
fn tractate_pairs() -> Vec<(&'static str, &'static str)> {
    vec![
        ("ברכות", "ברכות"), ("ברכ'", "ברכות"),
        ("שבת", "שבת"), ("שב'", "שבת"),
        ("עירובין", "עירובין"), ("עירו'", "עירובין"),
        ("פסחים", "פסחים"), ("פסח'", "פסחים"),
        ("שקלים", "שקלים"), ("יומא", "יומא"), ("סוכה", "סוכה"), ("ביצה", "ביצה"),
        ("ראש השנה", "ראש השנה"), ("ר\"ה", "ראש השנה"),
        ("תענית", "תענית"), ("תענ'", "תענית"),
        ("מגילה", "מגילה"), ("מגיל'", "מגילה"),
        ("מועד קטן", "מועד קטן"), ("מו\"ק", "מועד קטן"),
        ("חגיגה", "חגיגה"), ("חגיג'", "חגיגה"),
        ("יבמות", "יבמות"), ("יבמ'", "יבמות"),
        ("כתובות", "כתובות"), ("כתוב'", "כתובות"),
        ("נדרים", "נדרים"), ("נדר'", "נדרים"),
        ("נזיר", "נזיר"), ("סוטה", "סוטה"),
        ("גיטין", "גיטין"), ("גיט'", "גיטין"),
        ("קידושין", "קידושין"), ("קיד'", "קידושין"),
        ("בבא קמא", "בבא קמא"), ("ב\"ק", "בבא קמא"), ("ב'ק", "בבא קמא"),
        ("בבא מציעא", "בבא מציעא"), ("ב\"מ", "בבא מציעא"), ("ב'מ", "בבא מציעא"),
        ("בבא בתרא", "בבא בתרא"), ("ב\"ב", "בבא בתרא"), ("ב'ב", "בבא בתרא"),
        ("סנהדרין", "סנהדרין"), ("סנה'", "סנהדרין"),
        ("מכות", "מכות"), ("שבועות", "שבועות"), ("שבוע'", "שבועות"),
        ("עדויות", "עדויות"), ("עבודה זרה", "עבודה זרה"), ("ע\"ז", "עבודה זרה"),
        ("אבות", "אבות"), ("הוריות", "הוריות"),
        ("זבחים", "זבחים"), ("זבח'", "זבחים"),
        ("מנחות", "מנחות"), ("מנח'", "מנחות"),
        ("חולין", "חולין"), ("חול'", "חולין"),
        ("בכורות", "בכורות"), ("בכור'", "בכורות"),
        ("ערכין", "ערכין"), ("תמורה", "תמורה"),
        ("כריתות", "כריתות"), ("כרית'", "כריתות"),
        ("מעילה", "מעילה"), ("תמיד", "תמיד"), ("נדה", "נדה"),
        // ── מדרש רבה ──────────────────────────────────────────────────────────
        // חשוב: שמות ארוכים (שיר השירים רבה) חייבים לבוא לפני הקצרים כדי
        // שה-sort-by-length יתפוס אותם ראשון.
        ("שיר השירים רבה", "שיר השירים רבה"), ("שה\"ש רבה", "שיר השירים רבה"), ("שיר רבה", "שיר השירים רבה"),
        ("בראשית רבה", "בראשית רבה"), ("בר\"ר", "בראשית רבה"), ("ב\"ר", "בראשית רבה"),
        ("שמות רבה", "שמות רבה"), ("שמ\"ר", "שמות רבה"),
        ("ויקרא רבה", "ויקרא רבה"), ("ויק\"ר", "ויקרא רבה"),
        ("במדבר רבה", "במדבר רבה"), ("במ\"ר", "במדבר רבה"), ("במד\"ר", "במדבר רבה"),
        ("דברים רבה", "דברים רבה"), ("דב\"ר", "דברים רבה"),
        ("רות רבה", "רות רבה"),
        ("איכה רבה", "איכה רבה"), ("אי\"ר", "איכה רבה"),
        ("קהלת רבה", "קהלת רבה"), ("קה\"ר", "קהלת רבה"),
        ("אסתר רבה", "אסתר רבה"), ("אס\"ר", "אסתר רבה"),
    ]
}

// רשימת (regex מקומפל לתחילת מחרוזת, שם מלא) — ממוין מהארוך לקצר.
static ABBREV_RES: Lazy<Vec<(FRegex, String)>> = Lazy::new(|| {
    let mut pairs = tractate_pairs();
    pairs.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
    pairs
        .into_iter()
        .map(|(abbr, target)| {
            let escaped = regex_escape(abbr);
            // עוקב אחרי רווח / פסיק / נקודה / סוף-מחרוזת (lookahead)
            let re = FRegex::new(&format!(r"(?i)^{}(?=[\s,.]|$)", escaped)).unwrap();
            (re, target.to_string())
        })
        .collect()
});

static SEFARIA_EN: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    HashMap::from([
        // ── ש"ס בבלי ────────────────────────────────────────────────────────
        ("ברכות", "Berakhot"), ("שבת", "Shabbat"), ("עירובין", "Eruvin"),
        ("פסחים", "Pesachim"), ("שקלים", "Shekalim"), ("יומא", "Yoma"),
        ("סוכה", "Sukkah"), ("ביצה", "Beitzah"), ("ראש השנה", "Rosh Hashanah"),
        ("תענית", "Taanit"), ("מגילה", "Megillah"), ("מועד קטן", "Moed Katan"),
        ("חגיגה", "Chagigah"), ("יבמות", "Yevamot"), ("כתובות", "Ketubot"),
        ("נדרים", "Nedarim"), ("נזיר", "Nazir"), ("סוטה", "Sotah"),
        ("גיטין", "Gittin"), ("קידושין", "Kiddushin"), ("בבא קמא", "Bava Kamma"),
        ("בבא מציעא", "Bava Metzia"), ("בבא בתרא", "Bava Batra"),
        ("סנהדרין", "Sanhedrin"), ("מכות", "Makkot"), ("שבועות", "Shevuot"),
        ("עבודה זרה", "Avodah Zarah"), ("הוריות", "Horayot"), ("זבחים", "Zevachim"),
        ("מנחות", "Menachot"), ("חולין", "Chullin"), ("בכורות", "Bekhorot"),
        ("ערכין", "Arakhin"), ("תמורה", "Temurah"), ("כריתות", "Keritot"),
        ("מעילה", "Meilah"), ("תמיד", "Tamid"), ("נדה", "Niddah"),
        // ── תנ"ך ────────────────────────────────────────────────────────────
        ("בראשית", "Genesis"), ("שמות", "Exodus"), ("ויקרא", "Leviticus"),
        ("במדבר", "Numbers"), ("דברים", "Deuteronomy"), ("יהושע", "Joshua"),
        ("שופטים", "Judges"), ("תהלים", "Psalms"), ("משלי", "Proverbs"),
        ("איוב", "Job"), ("שיר השירים", "Song of Songs"), ("רות", "Ruth"),
        ("איכה", "Lamentations"), ("קהלת", "Ecclesiastes"), ("אסתר", "Esther"),
        ("דניאל", "Daniel"), ("עזרא", "Ezra"), ("נחמיה", "Nehemiah"),
        // ── מדרש רבה ────────────────────────────────────────────────────────
        // נתיב ה-API של Sefaria: ספר_Rabbah.פרשה.סימן (קו_תחתי לא רווח)
        ("בראשית רבה", "Genesis_Rabbah"),
        ("שמות רבה", "Exodus_Rabbah"),
        ("ויקרא רבה", "Leviticus_Rabbah"),
        ("במדבר רבה", "Numbers_Rabbah"),
        ("דברים רבה", "Deuteronomy_Rabbah"),
        ("שיר השירים רבה", "Song_of_Songs_Rabbah"),
        ("רות רבה", "Ruth_Rabbah"),
        ("איכה רבה", "Lamentations_Rabbah"),
        ("קהלת רבה", "Ecclesiastes_Rabbah"),
        ("אסתר רבה", "Esther_Rabbah"),
    ])
});

// ════════════════════════════════════════════════════════════════════════════
//  2. עזרי regex + נרמול
// ════════════════════════════════════════════════════════════════════════════

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for ch in s.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// replace_all עם closure עבור fancy-regex (ללא תלות ב-Replacer trait).
fn fre_replace_all<F>(re: &FRegex, text: &str, mut f: F) -> String
where
    F: FnMut(&fancy_regex::Captures) -> String,
{
    let mut out = String::new();
    let mut last = 0usize;
    for cap in re.captures_iter(text) {
        let cap = match cap {
            Ok(c) => c,
            Err(_) => break,
        };
        let m = cap.get(0).unwrap();
        out.push_str(&text[last..m.start()]);
        out.push_str(&f(&cap));
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

fn cap_str<'a>(cap: &'a fancy_regex::Captures, i: usize) -> &'a str {
    cap.get(i).map(|m| m.as_str()).unwrap_or("")
}

// regex לנרמול (regex רגיל — ללא lookaround)
static RE_CTRL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\u{0000}-\u{001F}\u{007F}]").unwrap());
static RE_DQUOTE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[\u{201C}\u{201D}\u{00AB}\u{00BB}\u{201E}\u{201F}]"#).unwrap());
static RE_SQUOTE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\u{2019}\u{2018}\u{201B}]").unwrap());
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_ALPI: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^על פי\s+").unwrap());
static RE_TRAIL_PUNCT: Lazy<Regex> = Lazy::new(|| Regex::new(r"[.,;:]+$").unwrap());
static RE_TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());

fn strip_tags(s: &str) -> String {
    RE_TAGS.replace_all(s, "").trim().to_string()
}

/// נרמול הפניה: הסרת בקרה, איחוד גרשיים, כיווץ רווחים, הסרת "על פי" ופיסוק קצה.
fn normalize_ref(input: &str) -> String {
    let s = RE_CTRL.replace_all(input, "");
    let s = RE_DQUOTE.replace_all(&s, "\"");
    let s = RE_SQUOTE.replace_all(&s, "'");
    let s = RE_WS.replace_all(&s, " ");
    let s = RE_ALPI.replace(&s, "");
    let s = RE_TRAIL_PUNCT.replace(&s, "");
    s.trim().to_string()
}

// fancy-regex עבור נרמול מספרים/דפי גמרא/קיצורים (דורש lookaround)
static RE_HEBNUM: Lazy<FRegex> =
    Lazy::new(|| FRegex::new(r#"(?<![א-ת])([א-ת׳״"']{1,6})(?![א-ת])"#).unwrap());
static RE_PAGE_A: Lazy<FRegex> =
    Lazy::new(|| FRegex::new(r#"([א-ת0-9]+)\s+ע(?:מוד)?\s*["״]?א['׳]?"#).unwrap());
static RE_PAGE_B: Lazy<FRegex> =
    Lazy::new(|| FRegex::new(r#"([א-ת0-9]+)\s+ע(?:מוד)?\s*["״]?ב['׳]?"#).unwrap());
// הסרת "דף" לפני מספר/אות — "דף לג" → "לג"
static RE_DAF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"דף\s+").unwrap());
// הסרת "עמ'" / "עמוד" לפני מספר — מאחר שכבר מטופל ב-RE_PAGE_A/B
static RE_SIMAN_COMMA: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"פרש(?:ה|ת)\s+([א-ת]{1,4}['׳]?|\d+)[,،،]\s*סי(?:מן?)?['׳]?\s+([א-ת]{1,4}['׳]?|\d+)").unwrap());
static RE_PAGE_DIGIT: Lazy<FRegex> = Lazy::new(|| FRegex::new(r"(\d+)([אב])\b").unwrap());
static RE_PAGE_HEBDOT: Lazy<FRegex> =
    Lazy::new(|| FRegex::new(r"([א-ת]{1,4})([.:])(?!\d)").unwrap());

// מדרש רבה: נרמול פורמט "פרשה X סימן Y" → "X, Y" (לפני חיפוש מקומי/Sefaria)
// תואם גם: "פרשה ח'", "פרשה א'", "סי' ב'", "סי׳ ה" וכו'
static RE_PARASHA_SIMAN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"פרש(?:ה|ת)\s+([א-ת]{1,4}['׳]?|\d+)(?:[,،،]?\s*סי(?:מן?)?['׳]?\s+([א-ת]{1,4}['׳]?|\d+))?")
        .unwrap()
});
// נרמול "פרשה X" בלי סימן (לכיסוי מקרה שה-DB מאחסן רק ברמת הפרשה)
static RE_PARASHA_ONLY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"פרש(?:ה|ת)\s+([א-ת]{1,4}['׳]?|\d+)").unwrap()
});

/// החלפת רצפי אותיות עבריות (לא חלק ממילה ארוכה) במספר גימטרי.
fn replace_hebrew_numbers(text: &str) -> String {
    fre_replace_all(&RE_HEBNUM, text, |c| {
        let m = cap_str(c, 0);
        match hebrew_to_number(m) {
            Some(n) if n > 0 => n.to_string(),
            _ => m.to_string(),
        }
    })
}

fn norm_page(pg: &str, dot: char) -> String {
    let n = if pg.chars().all(|c| c.is_ascii_digit()) {
        pg.to_string()
    } else {
        match hebrew_to_number(pg) {
            Some(v) => v.to_string(),
            None => pg.to_string(),
        }
    };
    format!("{}{}", n, dot)
}

/// נרמול עמוד גמרא לפורמט קנוני "<מספר>." (ע"א) / "<מספר>:" (ע"ב).
fn normalize_talmud_page(input: &str) -> String {
    let s = fre_replace_all(&RE_PAGE_A, input, |c| norm_page(cap_str(c, 1), '.'));
    let s = fre_replace_all(&RE_PAGE_B, &s, |c| norm_page(cap_str(c, 1), ':'));
    let s = fre_replace_all(&RE_PAGE_DIGIT, &s, |c| {
        let n = cap_str(c, 1);
        let side = cap_str(c, 2);
        format!("{}{}", n, if side == "א" { "." } else { ":" })
    });
    fre_replace_all(&RE_PAGE_HEBDOT, &s, |c| {
        let heb = cap_str(c, 1);
        let dot = cap_str(c, 2);
        match hebrew_to_number(heb) {
            Some(n) => format!("{}{}", n, dot),
            None => format!("{}{}", heb, dot),
        }
    })
}

/// פיתוח קיצור מסכת בתחילת ההפניה (אם זוהה). מחזיר וריאנט/ים.
fn expand_tractate_abbreviations(input: &str) -> Vec<String> {
    let trimmed = input.trim();
    for (re, target) in ABBREV_RES.iter() {
        if re.is_match(trimmed).unwrap_or(false) {
            let replaced = fre_replace_all(re, trimmed, |_| target.clone());
            return vec![replaced];
        }
    }
    vec![input.to_string()]
}

/// בניית סט וריאנטים לחיפוש (סדר עדיפות נשמר, ללא כפילויות).
fn generate_variants(reference: &str) -> Vec<String> {
    let raw = normalize_ref(reference);
    // הסר "דף " לפני מספר/אות — "ברכות דף לג" → "ברכות לג"
    let base = RE_DAF.replace_all(&raw, "").to_string();
    let base = base.trim().to_string();
    // אם "דף" הוסר, הוסף גם את הגרסה המקורית כוריאנט ראשון
    let mut order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |v: String, order: &mut Vec<String>, seen: &mut HashSet<String>| {
        if seen.insert(v.clone()) {
            order.push(v);
        }
    };
    // אם "דף" הוסר, הוסף גם את הגרסה המקורית
    if raw != base {
        push(raw.clone(), &mut order, &mut seen);
    }
    push(base.clone(), &mut order, &mut seen);

    // "פרשה X, סימן Y" עם פסיק (נפוץ בכתיבה ידנית)
    if let Some(caps) = RE_SIMAN_COMMA.captures(&base) {
        let parasha = caps.get(1).map(|m| m.as_str().trim_matches(|c| c == '\'' || c == '׳')).unwrap_or("");
        let siman   = caps.get(2).map(|m| m.as_str().trim_matches(|c| c == '\'' || c == '׳')).unwrap_or("");
        let before  = &base[..caps.get(0).unwrap().start()].trim_end();
        push(format!("{} {}, {}", before, parasha, siman), &mut order, &mut seen);
        push(format!("{} {}:{}", before, parasha, siman), &mut order, &mut seen);
        push(format!("{} {}", before, parasha), &mut order, &mut seen);
    }

    // נרמול "פרשה X סימן Y" (מדרש רבה וספרות דומה) → "X, Y" + "X" כוריאנטים
    // נעשה לפני שאר הנרמולים כך שהוריאנטים המנורמלים עוברים גם עיבוד גימטריה.
    if let Some(caps) = RE_PARASHA_SIMAN.captures(&base) {
        let parasha = caps.get(1).map(|m| m.as_str().trim_matches(|c| c == '\'' || c == '׳')).unwrap_or("");
        let before = &base[..caps.get(0).unwrap().start()].trim_end();
        if let Some(siman) = caps.get(2).map(|m| m.as_str().trim_matches(|c| c == '\'' || c == '׳')) {
            push(format!("{} {}, {}", before, parasha, siman), &mut order, &mut seen);
            push(format!("{} {}:{}", before, parasha, siman), &mut order, &mut seen);
        }
        push(format!("{} {}", before, parasha), &mut order, &mut seen);
    } else if let Some(caps) = RE_PARASHA_ONLY.captures(&base) {
        let parasha = caps.get(1).map(|m| m.as_str().trim_matches(|c| c == '\'' || c == '׳')).unwrap_or("");
        let before = &base[..caps.get(0).unwrap().start()].trim_end();
        push(format!("{} {}", before, parasha), &mut order, &mut seen);
    }

    let wp = normalize_talmud_page(&base);
    if wp != base {
        push(wp, &mut order, &mut seen);
    }

    // עיבוד גימטריה — עובדים על indices כדי לא לשכפל את ה-Vec
    let mut i = 0;
    while i < order.len() {
        let v = order[i].clone();
        let wa = replace_hebrew_numbers(&v);
        if wa != v {
            push(wa, &mut order, &mut seen);
        }
        i += 1;
    }

    // פיתוח קיצורי מסכתות + גימטריה + עמוד גמרא — שוב עם indices
    let mut j = 0;
    while j < order.len() {
        let v = order[j].clone();
        for e in expand_tractate_abbreviations(&v) {
            push(e.clone(), &mut order, &mut seen);
            let ea = replace_hebrew_numbers(&e);
            if ea != e {
                push(ea, &mut order, &mut seen);
            }
            let ep = normalize_talmud_page(&e);
            if ep != e {
                push(ep.clone(), &mut order, &mut seen);
                let epa = replace_hebrew_numbers(&ep);
                if epa != ep {
                    push(epa, &mut order, &mut seen);
                }
            }
        }
        j += 1;
    }
    order
}

fn detect_bavli(reference: &str) -> Option<String> {
    let norm = normalize_ref(reference);
    BAVLI_TRACTATES
        .iter()
        .find(|t| norm.starts_with(*t))
        .map(|t| t.to_string())
}

// ════════════════════════════════════════════════════════════════════════════
//  3. חילוץ הפניות + הקשר מהטקסט
// ════════════════════════════════════════════════════════════════════════════

fn bracket_chars(brackets: &str) -> (char, char) {
    match brackets {
        "square" => ('[', ']'),
        "round" => ('(', ')'),
        _ => ('{', '}'),
    }
}

#[derive(Clone)]
struct RefCtx {
    reference: String,
    sentence: String,
    quote_before: String,
    /// וריאנטים מחושבים מראש (לפני חלוקה ל-threads) — חוסך חישוב כפול
    variants: Vec<String>,
}

static RE_QUOTE1: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?s)["״“”]([\s\S]{2,80})["״“”]?\s*$"#).unwrap());
static RE_QUOTE2: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)[–—]\s*([\s\S]{2,60})\s*$").unwrap());

/// חילוץ המשפט המכיל את ההפניה + ציטוט שקדם לה (להדגשה).
fn extract_context(full_chars: &[char], raw: &str, open: char, close: char) -> (String, String) {
    // needle = open + raw + close (חיפוש ליטרלי, בטוח ל-UTF-8)
    let needle: Vec<char> = std::iter::once(open)
        .chain(raw.chars())
        .chain(std::iter::once(close))
        .collect();
    let n = needle.len();
    if n == 0 || full_chars.len() < n {
        return (String::new(), String::new());
    }
    let mut found: Option<usize> = None;
    for i in 0..=(full_chars.len() - n) {
        if full_chars[i..i + n] == needle[..] {
            found = Some(i);
            break;
        }
    }
    let pos = match found {
        Some(p) => p,
        None => return (String::new(), String::new()),
    };
    let after = pos + n;
    let mut start = pos;
    while start > 0 && !matches!(full_chars[start - 1], '.' | '\n') {
        start -= 1;
    }
    let mut end = after;
    while end < full_chars.len() && !matches!(full_chars[end], '.' | '\n') {
        end += 1;
    }
    let sentence: String = full_chars[start..end].iter().collect::<String>().trim().to_string();
    let before_start = pos.saturating_sub(200);
    let before: String = full_chars[before_start..pos].iter().collect();
    let quote = RE_QUOTE1
        .captures(&before)
        .or_else(|| RE_QUOTE2.captures(&before))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();
    (sentence, quote)
}

fn get_references_with_context(text: &str, brackets: &str) -> Vec<RefCtx> {
    let (open, close) = bracket_chars(brackets);
    let eo = regex_escape(&open.to_string());
    let ec = regex_escape(&close.to_string());
    let re = Regex::new(&format!("{}([^{}]+){}", eo, ec, ec)).unwrap();
    let full_chars: Vec<char> = text.chars().collect();
    let mut refs = Vec::new();
    for cap in re.captures_iter(text) {
        let raw = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let reference = normalize_ref(raw);
        if reference.is_empty() {
            continue;
        }
        let (sentence, quote_before) = extract_context(&full_chars, raw, open, close);
        let variants = generate_variants(&reference);
        refs.push(RefCtx {
            reference,
            sentence,
            quote_before,
            variants,
        });
    }
    refs
}

// ════════════════════════════════════════════════════════════════════════════
//  4. חילוץ טקסט מקבצים (txt / docx / pdf)
// ════════════════════════════════════════════════════════════════════════════

fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

static RE_WT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<w:t[^>]*>(.*?)</w:t>").unwrap());

fn extract_docx(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|e| e.to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    let xml = xml.replace("</w:p>", "\n");
    let mut out = String::new();
    for cap in RE_WT.captures_iter(&xml) {
        out.push_str(&decode_xml_entities(&cap[1]));
    }
    Ok(out)
}

fn extract_text(path: &str) -> Result<String, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "txt" => std::fs::read_to_string(path).map_err(|e| e.to_string()),
        "docx" => extract_docx(path),
        "pdf" => pdf_extract::extract_text(path).map_err(|e| e.to_string()),
        _ => std::fs::read_to_string(path).map_err(|e| e.to_string()),
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  5. שכבת DB — סכמה דינמית (camelCase של אוצריא או snake_case), חיבור יחיד
// ════════════════════════════════════════════════════════════════════════════

struct DbSchema {
    he_ref: String,
    line_index: String,
    content: String,
    book_id: String,
    title: String,
    file_path: String,
    /// עמודת tocEntryId — קיימת בסכמה החדשה בלבד; ריק-מחרוזת = לא קיימת
    toc_entry_id: String,
    /// עמודת charCount — קיימת בסכמה החדשה בלבד; ריק-מחרוזת = לא קיימת
    char_count: String,
}

struct OpenDb {
    path: String,
    conn: Connection,
    schema: DbSchema,
    fts: bool,
}

fn line_columns(conn: &Connection) -> Vec<String> {
    let mut cols = Vec::new();
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(line)") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.flatten() {
                cols.push(c);
            }
        }
    }
    cols
}

fn book_columns(conn: &Connection) -> Vec<String> {
    let mut cols = Vec::new();
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(book)") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.flatten() {
                cols.push(c);
            }
        }
    }
    cols
}

fn detect_schema(conn: &Connection) -> DbSchema {
    let lc = line_columns(conn);
    let bc = book_columns(conn);
    let has = |cols: &[String], name: &str| cols.iter().any(|c| c == name);
    DbSchema {
        he_ref: if has(&lc, "heRef") { "heRef" } else { "he_ref" }.to_string(),
        line_index: if has(&lc, "lineIndex") { "lineIndex" } else { "line_index" }.to_string(),
        content: "content".to_string(),
        book_id: if has(&lc, "bookId") { "bookId" } else { "book_id" }.to_string(),
        title: "title".to_string(),
        file_path: if has(&bc, "filePath") { "filePath" }
                   else if has(&bc, "file_path") { "file_path" }
                   else { "" }.to_string(),
        // עמודות חדשות — camelCase בסכמה החדשה, snake_case כ-fallback היסטורי
        toc_entry_id: if has(&lc, "tocEntryId") { "tocEntryId" }
                      else if has(&lc, "toc_entry_id") { "toc_entry_id" }
                      else { "" }.to_string(),
        char_count: if has(&lc, "charCount") { "charCount" }
                    else if has(&lc, "char_count") { "char_count" }
                    else { "" }.to_string(),
    }
}

fn detect_fts(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='line_fts'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

// ════════════════════════════════════════════════════════════════════════════
//  Tantivy index על he_ref — בניה חד-פעמית + חיפוש מהיר
// ════════════════════════════════════════════════════════════════════════════

const TANTIVY_INDEX_DIR: &str = "bodek_heref_index";

fn tantivy_index_path(db_path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(db_path);
    p.parent().unwrap_or(std::path::Path::new(".")).join(TANTIVY_INDEX_DIR)
}

pub fn build_tantivy_index(db_path: &str) -> Result<(), String> {
    let idx_path = tantivy_index_path(db_path);
    std::fs::create_dir_all(&idx_path).map_err(|e| e.to_string())?;

    // schema — בדיוק כמו בדוגמה הרשמית
    let mut schema_builder = TantivySchema::builder();
    let fld_id  = schema_builder.add_u64_field("line_id", STORED | FAST);
    let fld_ref = schema_builder.add_text_field("he_ref", TEXT | STORED);
    let schema  = schema_builder.build();

    let index = Index::create_in_dir(&idx_path, schema.clone()).map_err(|e| e.to_string())?;
    let mut writer: IndexWriter = index.writer(128_000_000).map_err(|e| e.to_string())?;

    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA mmap_size=4294967296;").map_err(|e| e.to_string())?;

    // גלה את שם עמודת he_ref
    let he_ref_col: String = {
        let mut s = conn.prepare("PRAGMA table_info(line)").map_err(|e| e.to_string())?;
        let cols: Vec<String> = s.query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        cols.into_iter()
            .find(|c| c.eq_ignore_ascii_case("he_ref") || c.eq_ignore_ascii_case("heRef"))
            .ok_or_else(|| "לא נמצאה עמודת he_ref".to_string())?
    };

    let sql = format!("SELECT id, {c} FROM line WHERE {c} IS NOT NULL AND {c} != ''", c = he_ref_col);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut count = 0u64;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    for row in rows {
        let (id, href) = row.map_err(|e| e.to_string())?;
        let mut doc = TantivyDocument::default();
        doc.add_u64(fld_id, id as u64);
        doc.add_text(fld_ref, &href);
        writer.add_document(doc).map_err(|e| e.to_string())?;
        count += 1;
        if count % 500_000 == 0 {
            writer.commit().map_err(|e| e.to_string())?;
        }
    }
    writer.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn tantivy_search(db_path: &str, variant: &str, limit: usize, fuzzy: bool) -> Vec<i64> {
    let idx_path = tantivy_index_path(db_path);
    if !idx_path.exists() { return vec![]; }
    let Ok(index) = Index::open_in_dir(&idx_path) else { return vec![]; };
    let Ok(reader) = index.reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .try_into() else { return vec![]; };
    let searcher = reader.searcher();
    let schema  = index.schema();
    let fld_id  = schema.get_field("line_id").unwrap();
    let fld_ref = schema.get_field("he_ref").unwrap();

    let mut qp = QueryParser::for_index(&index, vec![fld_ref]);
    // נסה exact → prefix → fuzzy
    let escaped = variant.replace('"', "");
    let queries = if fuzzy {
        vec![
            format!(r#"he_ref:"{}""#, escaped),
            format!("he_ref:{}*", escaped),
            format!("he_ref:{}~1", escaped),
        ]
    } else {
        vec![
            format!(r#"he_ref:"{}""#, escaped),
            format!("he_ref:{}*", escaped),
        ]
    };

    for q_str in &queries {
        let Ok(q) = qp.parse_query(q_str) else { continue; };
        let Ok(top) = searcher.search(&q, &TopDocs::with_limit(limit)) else { continue; };
        if top.is_empty() { continue; }
        return top.into_iter().filter_map(|(_, addr)| {
            let doc: TantivyDocument = searcher.doc(addr).ok()?;
            doc.get_first(fld_id).and_then(|v| TantivyValue::as_u64(&v)).map(|v| v as i64)
        }).collect();
    }
    vec![]
}

fn tantivy_index_exists(db_path: &str) -> bool {
    tantivy_index_path(db_path).join("meta.json").exists()
}

fn open_db(path: &str) -> Result<OpenDb, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("שגיאה בפתיחת DB: {e}"))?;

    // Pragmas לביצועים — best-effort (חלקם עלולים להיכשל על DB קריאה-בלבד).
    for pragma in [
        "PRAGMA query_only = ON;",
        "PRAGMA cache_size = -64000;",
        "PRAGMA temp_store = MEMORY;",
        "PRAGMA mmap_size = 268435456;",
        // מאפשר ל-SQLite להשתמש בריצות פנימיות מקבילות לסריקות גדולות.
        "PRAGMA threads = 4;",
        // מפחית lock-contention בקריאה-בלבד (WAL mode): מאפשר לקרוא pages
        // שעדיין לא עברו checkpoint בלי להמתין ל-lock של כותב.
        "PRAGMA read_uncommitted = TRUE;",
        // מריץ ANALYZE קל על טבלאות/אינדקסים שלא נותחו לאחרונה —
        // משפר את תוכניות השאילתות של query planner.
        "PRAGMA optimize;",
    ] {
        let _ = conn.execute_batch(pragma);
    }

    let schema = detect_schema(&conn);
    let fts = detect_fts(&conn);
    Ok(OpenDb {
        path: path.to_string(),
        conn,
        schema,
        fts,
    })
}

/// וידוא שחיבור פתוח ל-path המבוקש (פותח מחדש רק אם הנתיב השתנה).
fn ensure_db(guard: &mut Option<OpenDb>, path: &str) -> Result<(), String> {
    let need = match guard {
        Some(o) => o.path != path,
        None => true,
    };
    if need {
        *guard = Some(open_db(path)?);
    }
    Ok(())
}

struct RawRow {
    line_id: i64,
    line_index: i64,
    he_ref: String,
    content: String,
    book_title: String,
    book_path: Option<String>,
    book_id: i64,
    toc_entry_id: Option<i64>,
    char_count: Option<i64>,
}

fn map_raw(r: &rusqlite::Row) -> rusqlite::Result<RawRow> {
    Ok(RawRow {
        line_id:      r.get::<_, Option<i64>>(0)?.unwrap_or(0),
        line_index:   r.get::<_, Option<i64>>(1)?.unwrap_or(0),
        he_ref:       r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        content:      r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        book_title:   r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        book_path:    r.get::<_, Option<String>>(5)?,
        book_id:      r.get::<_, Option<i64>>(6)?.unwrap_or(0),
        // עמודות 7-8 קיימות רק כאשר select_prefix כולל אותן (סכמה חדשה).
        // כאשר הן נבחרות כ-NULL (סכמה ישנה) — get מחזיר Ok(None) בטוח.
        toc_entry_id: r.get::<_, Option<i64>>(7).unwrap_or(None),
        char_count:   r.get::<_, Option<i64>>(8).unwrap_or(None),
    })
}

fn select_prefix(s: &DbSchema) -> String {
    let fp_expr = if s.file_path.is_empty() {
        "NULL".to_string()
    } else {
        format!("b.{}", s.file_path)
    };
    // עמודות חדשות — NULL כ-fallback כאשר הסכמה הישנה לא מכילה אותן,
    // כך ש-map_raw תמיד מקבל 9 עמודות ללא תלות בגרסת ה-DB.
    let toc_expr = if s.toc_entry_id.is_empty() {
        "NULL".to_string()
    } else {
        format!("l.{}", s.toc_entry_id)
    };
    let cc_expr = if s.char_count.is_empty() {
        "NULL".to_string()
    } else {
        format!("l.{}", s.char_count)
    };
    format!(
        "SELECT l.id AS lineId, l.{li} AS lineIndex, l.{hr} AS heRef, l.{ct} AS content, \
         b.{ti} AS bookTitle, {fp} AS bookPath, b.id AS bookId, \
         {toc} AS tocEntryId, {cc} AS charCount \
         FROM line l JOIN book b ON l.{bid}=b.id WHERE ",
        li  = s.line_index,
        hr  = s.he_ref,
        ct  = s.content,
        ti  = s.title,
        fp  = fp_expr,
        bid = s.book_id,
        toc = toc_expr,
        cc  = cc_expr,
    )
}

/// בריחה מתווי תבנית של LIKE (% ו-_) ומתו הבריחה עצמו (\), כדי שתווים
/// כאלה שמופיעים בפועל בטקסט ההפניה לא יתפרשו כג'וקרים. נעשה שימוש יחד
/// עם סעיף `ESCAPE '\'` בשאילתת ה-SQL.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// בניית שאילתת FTS5 בטוחה (phrase match) מתוך וריאנט.
fn fts_query(v: &str) -> String {
    let escaped = v.replace('"', "''");
    format!("\"{}\"", escaped)
}

/// בניית שאילתת IN עם N placeholders לבדיקת כל הוריאנטים בפעם אחת.
/// מהיר משמעותית מ-N שאילתות = נפרדות כי SQLite מבצע table-scan יחיד.
fn build_batch_exact_sql(prefix: &str, he_ref_col: &str, n: usize) -> String {
    let placeholders = (0..n).map(|_| "?").collect::<Vec<_>>().join(", ");
    format!(
        "{prefix}l.{he_ref_col} IN ({placeholders}) COLLATE NOCASE LIMIT ?",
        he_ref_col = he_ref_col
    )
}

/// collect עם bind params דינמיים (לשאילתת IN).
fn collect_batch(
    conn: &Connection,
    sql: &str,
    variants: &[String],
    match_type: &str,
    seen: &mut HashSet<i64>,
    out: &mut Vec<RowOut>,
) -> rusqlite::Result<()> {
    use rusqlite::types::ToSql;
    let mut params_vec: Vec<Box<dyn ToSql>> = variants
        .iter()
        .map(|v| -> Box<dyn ToSql> { Box::new(v.clone()) })
        .collect();
    params_vec.push(Box::new(MAX_RESULTS_PER_REF));
    let params_refs: Vec<&dyn ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params_refs.as_slice(), map_raw)?;
    for row in rows {
        let raw = row?;
        if seen.insert(raw.line_id) {
            out.push(RowOut {
                he_ref:       raw.he_ref,
                book_title:   raw.book_title,
                file_path:    raw.book_path,
                line_index:   Some(raw.line_index),
                line_id:      Some(raw.line_id),
                content:      strip_tags(&raw.content),
                match_type:   match_type.to_string(),
                sefaria_url:  None,
                book_id:      Some(raw.book_id),
                toc_entry_id: raw.toc_entry_id,
                char_count:   raw.char_count,
            });
        }
    }
    Ok(())
}

/// collect עם statement מוכן מראש (לשאילתות prefix/fuzzy החוזרות).
fn collect_single_stmt(
    stmt: &mut rusqlite::Statement,
    bind: &str,
    match_type: &str,
    seen: &mut HashSet<i64>,
    out: &mut Vec<RowOut>,
) -> rusqlite::Result<()> {
    let rows = stmt.query_map(params![bind, MAX_RESULTS_PER_REF], map_raw)?;
    for row in rows {
        let raw = row?;
        if seen.insert(raw.line_id) {
            out.push(RowOut {
                he_ref:       raw.he_ref,
                book_title:   raw.book_title,
                file_path:    raw.book_path,
                line_index:   Some(raw.line_index),
                line_id:      Some(raw.line_id),
                content:      strip_tags(&raw.content),
                match_type:   match_type.to_string(),
                sefaria_url:  None,
                book_id:      Some(raw.book_id),
                toc_entry_id: raw.toc_entry_id,
                char_count:   raw.char_count,
            });
        }
    }
    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════
//  6. מבני פלט (JSON ל-Frontend)  — camelCase
// ════════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RowOut {
    he_ref: String,
    book_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_id: Option<i64>,
    content: String,
    match_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sefaria_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    book_id: Option<i64>,
    /// מזהה רשומת תוכן עניינים — None בסכמה ישנה או בתוצאות Sefaria
    #[serde(skip_serializing_if = "Option::is_none")]
    toc_entry_id: Option<i64>,
    /// מספר תווים בשורה — שימושי לסינון שורות קצרות/כותרות, None בסכמה ישנה
    #[serde(skip_serializing_if = "Option::is_none")]
    char_count: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResultOut {
    #[serde(rename = "ref")]
    reference: String,
    match_type: String,
    variants_tried: Vec<String>,
    rows: Vec<RowOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row: Option<RowOut>,
    source: String,
    sentence: String,
    quote_before: String,
    is_bavli: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    total: usize,
    processed: usize,
    found_count: i64,
    not_found_count: i64,
    #[serde(skip_serializing_if = "is_false")]
    sefaria_update: bool,
}
fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultEnvelope<'a> {
    job_id: &'a str,
    idx: usize,
    result: &'a ResultOut,
    progress: Progress,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    total_refs: usize,
    found_count: i64,
    not_found_count: i64,
    sefaria_found_count: i64,
    aborted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEnvelope {
    job_id: String,
    summary: Summary,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LineRowOut {
    line_id: i64,
    line_index: i64,
    he_ref: String,
    content: String,
    is_focus: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    toc_entry_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    char_count: Option<i64>,
}

// ════════════════════════════════════════════════════════════════════════════
//  7. Sefaria fallback
// ════════════════════════════════════════════════════════════════════════════

static RE_SEFARIA: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s+(\d+|[א-ת]{1,4})\s*[,.:]\s*(\d+|[א-ת]{1,4}\.?:?)?$")
        .unwrap()
});

fn ref_to_sefaria_path(reference: &str) -> Option<String> {
    let norm = normalize_ref(reference);
    let caps = RE_SEFARIA.captures(&norm)?;
    let book = caps.get(1)?.as_str().trim();
    let ch = caps.get(2)?.as_str();
    let en_book = SEFARIA_EN.get(book)?;
    let ch_clean: String = ch.chars().filter(|c| !matches!(c, '.' | ':' | '\'' | '״' | '׳')).collect();
    let ch_n = hebrew_to_number(&ch_clean).or_else(|| ch_clean.parse::<i64>().ok())?;
    if ch_n == 0 {
        return None;
    }
    match caps.get(3).map(|m| m.as_str()).filter(|s| !s.is_empty()) {
        None => Some(format!("{}.{}", en_book, ch_n)),
        Some(vs) => {
            let vs_clean: String = vs.chars().filter(|c| !matches!(c, '.' | ':' | '\'' | '״' | '׳')).collect();
            match hebrew_to_number(&vs_clean).or_else(|| vs_clean.parse::<i64>().ok()) {
                Some(vs_n) if vs_n > 0 => Some(format!("{}.{}.{}", en_book, ch_n, vs_n)),
                _ => Some(format!("{}.{}", en_book, ch_n)),
            }
        }
    }
}

struct SefariaHit {
    content: String,
    he_ref: String,
    book_title: String,
    url: String,
}

fn flatten_he(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::String(s) => {
            if !s.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                flatten_he(item, out);
            }
        }
        _ => {}
    }
}

async fn query_ref_sefaria(client: &reqwest::Client, reference: &str) -> Option<SefariaHit> {
    let spath = ref_to_sefaria_path(reference)?;
    let url = format!(
        "https://www.sefaria.org/api/texts/{}?lang=he&context=0",
        urlencode(&spath)
    );
    let resp = client
        .get(url.as_str())
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let mut raw = String::new();
    flatten_he(data.get("he").unwrap_or(&serde_json::Value::Null), &mut raw);
    if raw.is_empty() {
        flatten_he(data.get("text").unwrap_or(&serde_json::Value::Null), &mut raw);
    }
    let content = strip_tags(&raw);
    if content.is_empty() {
        return None;
    }
    let content: String = content.chars().take(600).collect();
    let he_ref = data
        .get("ref")
        .and_then(|v| v.as_str())
        .unwrap_or(&spath)
        .to_string();
    let book_title = data
        .get("book")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| spath.split('.').next().unwrap_or(&spath))
        .to_string();
    Some(SefariaHit {
        content,
        he_ref,
        book_title,
        url: format!("https://www.sefaria.org/{}", spath),
    })
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ── מטמון מקומי לתוצאות Sefaria ────────────────────────────────────────────
// נשמר כקובץ JSON בתיקיית הנתונים של האפליקציה (app_data_dir), כך שהרצות
// חוזרות — גם על מסמכים שונים שמצטטים את אותם מקורות — לא צריכות לפנות
// לרשת שוב על אותה הפניה. המפתח הוא נתיב ה-Sefaria המנורמל (לא הטקסט הגולמי
// של ההפניה), כדי שכמה ניסוחים שונים של אותה הפניה ישתפו את אותה רשומה.
#[derive(Serialize, Deserialize, Clone)]
struct CachedSefariaHit {
    content: String,
    he_ref: String,
    book_title: String,
    url: String,
    fetched_at: i64,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sefaria_cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sefaria_cache.json"))
}

fn load_sefaria_cache(app: &AppHandle) -> HashMap<String, CachedSefariaHit> {
    let Some(path) = sefaria_cache_path(app) else {
        return HashMap::new();
    };
    let Ok(data) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    // קובץ מטמון פגום/לא תקין לא אמור להפיל את ההשוואה — פשוט מתחילים מריק.
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_sefaria_cache(app: &AppHandle, cache: &HashMap<String, CachedSefariaHit>) {
    let Some(path) = sefaria_cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(&path, json);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  8. סריקה מקומית (סינכרונית) + בניית תוצאות
// ════════════════════════════════════════════════════════════════════════════

struct ScanOut {
    // אינדקס i תמיד תואם להפניה refs[i] המקורית; None רק אם ההשוואה הופסקה
    // (abort) לפני שאותה הפניה ספציפית עובדה על ידי אחד מה-workers.
    results: Vec<Option<ResultOut>>,
    not_found: Vec<usize>,
    found_count: i64,
    not_found_count: i64,
    aborted: bool,
}

/// עיבוד נתח (chunk) אחד של הפניות, על חיבור SQLite פרטי משלו (read-only).
/// רץ בתוך thread עבודה ייעודי שנפתח על ידי local_scan_parallel.
/// chunk_start הוא האינדקס הגלובלי (ב-refs המלא) של הפריט הראשון בנתח,
/// כך שכל תוצאה משודרת/מוחזרת עם ה-idx המקורי שלה (לא יחסי לנתח).
/// שיפורי מהירות לעומת גרסה קודמת:
///   • variants מחושבים מראש (ב-get_references_with_context) — אין חישוב כפול
///   • שאילתת batch IN לכל הוריאנטים בפעם אחת (table scan יחיד ב-SQLite)
///   • early-exit מיידי עם כל תוצאה ראשונה (exact/prefix) ללא המתנה לשאר
///   • prepare_cached במקום prepare — חוסך compile overhead לאותה שאילתה
#[allow(clippy::too_many_arguments)]
fn scan_chunk(
    db_path: &str,
    chunk_start: usize,
    chunk: &[RefCtx],
    fuzzy: bool,
    min_char_count: i64,
    abort: &Arc<AtomicBool>,
    app: &AppHandle,
    job_id: &str,
    total: usize,
    processed_counter: &AtomicUsize,
    found_counter: &AtomicI64,
    not_found_counter: &AtomicI64,
) -> Result<(Vec<(usize, ResultOut)>, Vec<usize>, bool), String> {
    let opendb = open_db(db_path)?;
    let s = &opendb.schema;
    let base = select_prefix(s);

    // תנאי סינון charCount — מתווסף לשאילתות רק כאשר העמודה קיימת והסף > 0.
    // כך שורות קצרות מדי (כותרות, סימני פרשה, שורות ריקות) לא מחזירות התאמה.
    let cc_filter = if min_char_count > 0 && !s.char_count.is_empty() {
        format!("AND l.{} >= {} ", s.char_count, min_char_count)
    } else {
        String::new()
    };

    // שאילתות עם ESCAPE '\' למניעת ג'וקרים לא מכוונים
    let prefix_sql = format!("{base}l.{hr} LIKE ? ESCAPE '\\' COLLATE NOCASE {cc}LIMIT ?", hr = s.he_ref, cc = cc_filter);
    let fts_sql = format!(
        "SELECT l.id AS lineId, l.{li} AS lineIndex, l.{hr} AS heRef, l.{ct} AS content, \
         b.{ti} AS bookTitle, {fp} AS bookPath, b.id AS bookId, NULL AS tocEntryId, NULL AS charCount \
         FROM line_fts f JOIN line l ON l.id = f.rowid JOIN book b ON l.{bid}=b.id \
         WHERE line_fts MATCH ? {cc}LIMIT ?",
        li  = s.line_index, hr = s.he_ref, ct = s.content, ti = s.title,
        fp  = if s.file_path.is_empty() { "NULL".to_string() } else { format!("b.{}", s.file_path) },
        bid = s.book_id,
        cc  = cc_filter,
    );
    let like_sql = format!("{base}l.{hr} LIKE ? ESCAPE '\\' COLLATE NOCASE {cc}LIMIT ?", hr = s.he_ref, cc = cc_filter);

    // הכנת שאילתות prefix/fuzzy פעם אחת לכל thread — prepare_cached חוסך
    // את עלות ה-compile החוזרת בכל קריאה (חשוב כשיש מאות הפניות).
    let mut stmt_prefix = opendb.conn.prepare(&prefix_sql).map_err(|e| e.to_string())?;
    let mut stmt_fuzzy = opendb
        .conn
        .prepare(if opendb.fts { &fts_sql } else { &like_sql })
        .map_err(|e| e.to_string())?;

    let mut local_out: Vec<(usize, ResultOut)> = Vec::with_capacity(chunk.len());
    let mut local_not_found: Vec<usize> = Vec::new();
    let mut aborted = false;

    for (i, rc) in chunk.iter().enumerate() {
        let idx = chunk_start + i;
        if abort.load(Ordering::Relaxed) {
            aborted = true;
            break;
        }

        // וריאנטים מחושבים מראש — אין צורך לחשב שוב בכל thread
        let variants = &rc.variants;
        let mut out: Vec<RowOut> = Vec::new();
        let mut seen: HashSet<i64> = HashSet::new();
        let mut has_exact = false;
        let mut has_prefix = false;

        // ── שלב 1: Tantivy (אם index קיים) אחרת batch exact ──────────────
        let used_tantivy = if tantivy_index_exists(db_path) {
            let mut found_any = false;
            for v in variants {
                let ids = tantivy_search(db_path, v, MAX_RESULTS_PER_REF as usize, false);
                for id in ids {
                    if seen.insert(id) {
                        let row_sql = format!("{base}l.id = ? LIMIT ?");
                        if let Ok(mut st) = opendb.conn.prepare(&row_sql) {
                            let rows = st.query_map(params![id, 1i64], map_raw).ok();
                            if let Some(rows) = rows {
                                for row in rows.flatten() {
                                    out.push(RowOut {
                                        he_ref:       row.he_ref,
                                        book_title:   row.book_title,
                                        file_path:    row.book_path,
                                        line_index:   Some(row.line_index),
                                        line_id:      Some(row.line_id),
                                        content:      strip_tags(&row.content),
                                        match_type:   "exact".to_string(),
                                        sefaria_url:  None,
                                        book_id:      Some(row.book_id),
                                        toc_entry_id: row.toc_entry_id,
                                        char_count:   row.char_count,
                                    });
                                }
                            }
                        }
                        found_any = true;
                        has_exact = true;
                    }
                }
                if has_exact { break; }
            }
            found_any
        } else { false };

        if !used_tantivy && !variants.is_empty() {
            let batch_sql = build_batch_exact_sql(&base, &s.he_ref, variants.len());
            let _ = collect_batch(&opendb.conn, &batch_sql, variants, "exact", &mut seen, &mut out);
            if !out.is_empty() {
                has_exact = true;
            }
        }

        // ── שלב 2: prefix per-variant — רק אם אין exact ─────────────────
        if !has_exact {
            'variants: for v in variants {
                let rows_before = out.len();
                let _ = collect_single_stmt(
                    &mut stmt_prefix,
                    &format!("{}%", escape_like(v)),
                    "prefix",
                    &mut seen,
                    &mut out,
                );
                if out.len() > rows_before {
                    has_prefix = true;
                    // early-exit מיידי — תוצאת prefix ראשונה מספיקה
                    // (וריאנטים נוספים כנראה יתנו את אותן שורות)
                    break 'variants;
                }
                // fuzzy — רק אם אין prefix בכלל ואורך וריאנט מינימלי
                if !has_prefix && fuzzy && v.chars().count() >= 4 {
                    if opendb.fts {
                        let _ = collect_single_stmt(&mut stmt_fuzzy, &fts_query(v), "fuzzy", &mut seen, &mut out);
                    } else {
                        let _ = collect_single_stmt(
                            &mut stmt_fuzzy,
                            &format!("%{}%", escape_like(v)),
                            "fuzzy",
                            &mut seen,
                            &mut out,
                        );
                    }
                }
            }
        }

        out.truncate(MAX_RESULTS_PER_REF as usize);

        let best = if has_exact {
            "exact"
        } else if has_prefix {
            "prefix"
        } else if !out.is_empty() {
            "fuzzy"
        } else {
            "none"
        };

        let row = out.first().cloned();
        let has_rows = !out.is_empty();
        let result = ResultOut {
            reference: rc.reference.clone(),
            match_type: best.to_string(),
            variants_tried: variants.clone(),
            rows: out,
            row,
            source: "local".to_string(),
            sentence: rc.sentence.clone(),
            quote_before: rc.quote_before.clone(),
            is_bavli: detect_bavli(&rc.reference).is_some(),
        };

        // עדכון אטומי של המונים המשותפים (כל ה-threads כותבים לאותם מונים).
        let processed = processed_counter.fetch_add(1, Ordering::Relaxed) + 1;
        if has_rows {
            found_counter.fetch_add(1, Ordering::Relaxed);
        } else {
            not_found_counter.fetch_add(1, Ordering::Relaxed);
            local_not_found.push(idx);
        }

        // שידור התוצאה בזמן אמת (כמו קודם — רק שעכשיו ממספר threads).
        let env = ResultEnvelope {
            job_id,
            idx,
            result: &result,
            progress: Progress {
                total,
                processed,
                found_count: found_counter.load(Ordering::Relaxed),
                not_found_count: not_found_counter.load(Ordering::Relaxed),
                sefaria_update: false,
            },
        };
        let _ = app.emit("compare-result", &env);

        local_out.push((idx, result));
    }

    Ok((local_out, local_not_found, aborted))
}

/// סריקה מקומית מקבילית: מחלקת את ההפניות ל-MAX_SCAN_WORKERS נתחים רציפים,
/// כל אחד עם חיבור SQLite read-only פרטי משלו (קוראים מקביליים תקינים
/// ובטוחים ב-SQLite), וממזגת את התוצאות בחזרה לפי האינדקס המקורי כך שסדר
/// הפלט הסופי זהה לחלוטין לגרסה הסדרתית הקודמת. נבדק בנפרד מול הרצת בדיקה
/// עצמאית (ללא rusqlite/tauri) שמוודאת: שימור סדר, ספירות found/not_found
/// תקינות, ועקביות גם כשמופעל abort באמצע.
#[allow(clippy::too_many_arguments)]
fn local_scan_parallel(
    db_path: &str,
    refs: &[RefCtx],
    fuzzy: bool,
    min_char_count: i64,
    abort: &Arc<AtomicBool>,
    app: &AppHandle,
    job_id: &str,
) -> Result<ScanOut, String> {
    let total = refs.len();
    if total == 0 {
        return Ok(ScanOut {
            results: Vec::new(),
            not_found: Vec::new(),
            found_count: 0,
            not_found_count: 0,
            aborted: false,
        });
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, MAX_SCAN_WORKERS)
        .min(total);
    let chunk_size = total.div_ceil(num_workers);

    let processed_counter = AtomicUsize::new(0);
    let found_counter = AtomicI64::new(0);
    let not_found_counter = AtomicI64::new(0);
    let any_aborted = AtomicBool::new(false);

    let mut merged: Vec<Option<ResultOut>> = (0..total).map(|_| None).collect();
    let mut not_found: Vec<usize> = Vec::new();
    let mut worker_err: Option<String> = None;

    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        // &AtomicUsize / &AtomicI64 מממשים Copy — כל closure מקבל עותק של
        // ה-reference (לא move של הערך עצמו), מה שמאפשר לשתף את אותם
        // מונים בין כל ה-threads מבלי להעביר בעלות שאינה ניתנת להעתקה.
        let p_ref: &AtomicUsize = &processed_counter;
        let f_ref: &AtomicI64 = &found_counter;
        let nf_ref: &AtomicI64 = &not_found_counter;
        for w in 0..num_workers {
            let start = w * chunk_size;
            if start >= total {
                break;
            }
            let end = (start + chunk_size).min(total);
            let chunk = &refs[start..end];
            handles.push(scope.spawn(move || {
                scan_chunk(
                    db_path,
                    start,
                    chunk,
                    fuzzy,
                    min_char_count,
                    abort,
                    app,
                    job_id,
                    total,
                    p_ref,
                    f_ref,
                    nf_ref,
                )
            }));
        }
        for h in handles {
            match h.join() {
                Ok(Ok((local_out, local_not_found, aborted))) => {
                    for (idx, r) in local_out {
                        merged[idx] = Some(r);
                    }
                    not_found.extend(local_not_found);
                    if aborted {
                        any_aborted.store(true, Ordering::Relaxed);
                    }
                }
                Ok(Err(e)) => {
                    worker_err.get_or_insert(e);
                }
                Err(_) => {
                    worker_err.get_or_insert_with(|| "שרשור עיבוד קרס באופן בלתי צפוי".to_string());
                }
            }
        }
    });

    if let Some(e) = worker_err {
        return Err(e);
    }

    not_found.sort_unstable();

    Ok(ScanOut {
        results: merged,
        not_found,
        found_count: found_counter.load(Ordering::Relaxed),
        not_found_count: not_found_counter.load(Ordering::Relaxed),
        aborted: any_aborted.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed),
    })
}

// ════════════════════════════════════════════════════════════════════════════
//  9. State + פקודות Tauri
// ════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
struct DbState(Arc<Mutex<Option<OpenDb>>>);
#[derive(Clone)]
struct Jobs(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Options {
    #[serde(default)]
    brackets: Option<String>,
    #[serde(default = "default_true")]
    fuzzy: bool,
    #[serde(default = "default_true")]
    sefaria: bool,
    /// סינון שורות קצרות מדי (כותרות, שורות ריקות וכד') לפי charCount.
    /// 0 = ללא סינון (ברירת מחדל לתאימות לאחור עם סכמה ישנה).
    #[serde(default)]
    min_char_count: i64,
}
fn default_true() -> bool {
    true
}

fn emit_done(app: &AppHandle, job_id: &str, summary: Summary) {
    let _ = app.emit(
        "compare-done",
        &DoneEnvelope {
            job_id: job_id.to_string(),
            summary,
        },
    );
}

/// פקודת הליבה — מריצה השוואה אסינכרונית ומשדרת אירועים. מחזירה מיד.
#[tauri::command]
fn compare_start(
    app: AppHandle,
    db: State<'_, DbState>,
    jobs: State<'_, Jobs>,
    job_id: String,
    input_file: Option<String>,
    input_text: Option<String>,
    db_path: Option<String>,
    options: Options,
) -> Result<(), String> {
    let abort = Arc::new(AtomicBool::new(false));
    jobs.0.lock().unwrap().insert(job_id.clone(), abort.clone());

    let db_arc = db.0.clone();
    let jobs_arc = jobs.0.clone();
    let brackets = options.brackets.clone().unwrap_or_else(|| "curly".to_string());
    let fuzzy = options.fuzzy;
    let use_sefaria = options.sefaria;
    let min_char_count = options.min_char_count;

    tauri::async_runtime::spawn(async move {
        let cleanup = |jobs_arc: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>| {
            jobs_arc.lock().unwrap().remove(&job_id);
        };

        let resolved_db = db_path
            .as_deref()
            .map(|p| p.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| DEFAULT_DB_PATH.to_string());

        // תמיכה בטקסט מודבק (input_text) במקום קובץ (input_file)
        let raw_text: Option<String> = if let Some(txt) = input_text {
            if !txt.trim().is_empty() { Some(txt) } else { None }
        } else { None };

        let input = input_file
            .as_deref()
            .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .unwrap_or_default();

        // אם אין טקסט מודבק — חייב קובץ
        if raw_text.is_none() {
            if input.is_empty() {
                emit_done(&app, &job_id, err_summary("לא סופק קובץ או טקסט לבדיקה".to_string()));
                cleanup(&jobs_arc);
                return;
            }
            if !Path::new(&input).exists() {
                emit_done(&app, &job_id, err_summary(format!("קובץ לא נמצא: {input}")));
                cleanup(&jobs_arc);
                return;
            }
        }
        if !Path::new(&resolved_db).exists() {
            emit_done(&app, &job_id, err_summary(format!("מסד הנתונים לא נמצא: {resolved_db}")));
            cleanup(&jobs_arc);
            return;
        }

        // חילוץ טקסט — מטקסט מודבק או מקובץ
        let text = if let Some(pasted) = raw_text {
            pasted
        } else {
            let input_for_extract = input.clone();
            match tokio::task::spawn_blocking(move || extract_text(&input_for_extract)).await {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => {
                    emit_done(&app, &job_id, err_summary(format!("שגיאה בקריאת הקובץ: {e}")));
                    cleanup(&jobs_arc);
                    return;
                }
                Err(e) => {
                    emit_done(&app, &job_id, err_summary(format!("שגיאה פנימית: {e}")));
                    cleanup(&jobs_arc);
                    return;
                }
            }
        };

        // חילוץ הפניות + דה-דופליקציה גלובלית
        let all_refs = get_references_with_context(&text, &brackets);
        let mut seen: HashSet<String> = HashSet::new();
        let unique: Vec<RefCtx> = all_refs
            .into_iter()
            .filter(|r| seen.insert(r.reference.clone()))
            .collect();

        if unique.is_empty() {
            emit_done(
                &app,
                &job_id,
                Summary {
                    total_refs: 0,
                    found_count: 0,
                    not_found_count: 0,
                    sefaria_found_count: 0,
                    aborted: false,
                    error: None,
                },
            );
            cleanup(&jobs_arc);
            return;
        }

        let total = unique.len();

        // ── סריקה מקומית (blocking, מקבילית על מספר חיבורי קריאה-בלבד) ───────
        let scan_app = app.clone();
        let scan_job = job_id.clone();
        let scan_abort = abort.clone();
        let scan_db = db_arc.clone();
        let scan_db_path = resolved_db.clone();
        let scan = tokio::task::spawn_blocking(move || -> Result<ScanOut, String> {
            // מוודאים שהנתיב תקין ושומרים על ה-cache המשותף חם (גם עבור
            // expand_page בהמשך) — אך הסריקה עצמה משתמשת בחיבורים נפרדים
            // ומקביליים, ולא בחיבור היחיד תחת ה-Mutex (ראו local_scan_parallel).
            {
                let mut guard = scan_db.lock().unwrap();
                ensure_db(&mut guard, &scan_db_path)?;
            }
            local_scan_parallel(&scan_db_path, &unique, fuzzy, min_char_count, &scan_abort, &scan_app, &scan_job)
        })
        .await;

        let mut scan = match scan {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                emit_done(&app, &job_id, err_summary(e));
                cleanup(&jobs_arc);
                return;
            }
            Err(e) => {
                emit_done(&app, &job_id, err_summary(format!("שגיאה פנימית: {e}")));
                cleanup(&jobs_arc);
                return;
            }
        };

        let mut found_count = scan.found_count;
        let mut not_found_count = scan.not_found_count;
        let mut sefaria_found = 0i64;

        // ── נפילה ל-Sefaria (אסינכרוני, batch בסוף, concurrency מוגבל) ────────
        if use_sefaria && !scan.aborted && !abort.load(Ordering::Relaxed) {
            let to_check: Vec<(usize, String)> = scan
                .not_found
                .iter()
                .filter_map(|&i| scan.results[i].as_ref().map(|r| (i, r.reference.clone())))
                .collect();

            if !to_check.is_empty() {
                let mut sefaria_cache = load_sefaria_cache(&app);
                let now = now_unix();

                // הפרדה בין הפניות שכבר יש להן תוצאה תקפה במטמון (תשובה
                // מיידית, בלי רשת בכלל) לבין כאלה שצריך לשלוף בפועל מ-Sefaria.
                let mut from_cache: Vec<(usize, CachedSefariaHit)> = Vec::new();
                let mut to_fetch: Vec<(usize, String, String)> = Vec::new(); // (idx, reference, spath)

                for (idx, refstr) in to_check {
                    match ref_to_sefaria_path(&refstr) {
                        Some(spath) => match sefaria_cache.get(&spath) {
                            Some(hit) if now - hit.fetched_at < SEFARIA_CACHE_TTL_SECS => {
                                from_cache.push((idx, hit.clone()));
                            }
                            _ => to_fetch.push((idx, refstr, spath)),
                        },
                        None => {} // לא ניתן למיפוי ל-Sefaria כלל — לא רלוונטי לרשת/מטמון
                    }
                }

                // יישום מיידי של פגיעות מטמון, בלי להמתין לשום קריאת רשת.
                for (idx, hit) in from_cache {
                    let row = RowOut {
                        he_ref:       hit.he_ref.clone(),
                        book_title:   hit.book_title.clone(),
                        file_path:    None,
                        line_index:   None,
                        line_id:      None,
                        content:      hit.content.clone(),
                        match_type:   "sefaria".to_string(),
                        sefaria_url:  Some(hit.url.clone()),
                        book_id:      None,
                        toc_entry_id: None, // לא רלוונטי לתוצאות Sefaria
                        char_count:   None,
                    };
                    if let Some(r) = scan.results[idx].as_mut() {
                        r.source = "sefaria".to_string();
                        r.match_type = "sefaria".to_string();
                        r.rows = vec![row.clone()];
                        r.row = Some(row);
                    }
                    found_count += 1;
                    not_found_count -= 1;
                    sefaria_found += 1;

                    if let Some(result_ref) = scan.results[idx].as_ref() {
                        let env = ResultEnvelope {
                            job_id: &job_id,
                            idx,
                            result: result_ref,
                            progress: Progress {
                                total,
                                processed: total,
                                found_count,
                                not_found_count,
                                sefaria_update: true,
                            },
                        };
                        let _ = app.emit("compare-result", &env);
                    }
                }

                if !to_fetch.is_empty() && !abort.load(Ordering::Relaxed) {
                    let client = reqwest::Client::new();
                    let sem = Arc::new(Semaphore::new(SEFARIA_CONCURRENCY));
                    let mut set: JoinSet<(usize, String, Option<SefariaHit>)> = JoinSet::new();

                    for (idx, refstr, spath) in to_fetch {
                        if abort.load(Ordering::Relaxed) {
                            break;
                        }
                        let client = client.clone();
                        let sem = sem.clone();
                        set.spawn(async move {
                            let _permit = sem.acquire_owned().await.unwrap();
                            let hit = query_ref_sefaria(&client, &refstr).await;
                            (idx, spath, hit)
                        });
                    }

                    while let Some(joined) = set.join_next().await {
                        if let Ok((idx, spath, Some(hit))) = joined {
                            sefaria_cache.insert(
                                spath,
                                CachedSefariaHit {
                                    content: hit.content.clone(),
                                    he_ref: hit.he_ref.clone(),
                                    book_title: hit.book_title.clone(),
                                    url: hit.url.clone(),
                                    fetched_at: now,
                                },
                            );

                            let row = RowOut {
                                he_ref:       hit.he_ref.clone(),
                                book_title:   hit.book_title.clone(),
                                file_path:    None,
                                line_index:   None,
                                line_id:      None,
                                content:      hit.content.clone(),
                                match_type:   "sefaria".to_string(),
                                sefaria_url:  Some(hit.url.clone()),
                                book_id:      None,
                                toc_entry_id: None, // לא רלוונטי לתוצאות Sefaria
                                char_count:   None,
                            };
                            if let Some(r) = scan.results[idx].as_mut() {
                                r.source = "sefaria".to_string();
                                r.match_type = "sefaria".to_string();
                                r.rows = vec![row.clone()];
                                r.row = Some(row);
                            }
                            found_count += 1;
                            not_found_count -= 1;
                            sefaria_found += 1;

                            if let Some(result_ref) = scan.results[idx].as_ref() {
                                let env = ResultEnvelope {
                                    job_id: &job_id,
                                    idx,
                                    result: result_ref,
                                    progress: Progress {
                                        total,
                                        processed: total,
                                        found_count,
                                        not_found_count,
                                        sefaria_update: true,
                                    },
                                };
                                let _ = app.emit("compare-result", &env);
                            }
                        }
                    }
                }

                save_sefaria_cache(&app, &sefaria_cache);
            }
        }

        emit_done(
            &app,
            &job_id,
            Summary {
                total_refs: total,
                found_count,
                not_found_count,
                sefaria_found_count: sefaria_found,
                aborted: scan.aborted || abort.load(Ordering::Relaxed),
                error: None,
            },
        );
        cleanup(&jobs_arc);
    });

    Ok(())
}

fn err_summary(msg: String) -> Summary {
    Summary {
        total_refs: 0,
        found_count: 0,
        not_found_count: 0,
        sefaria_found_count: 0,
        aborted: false,
        error: Some(msg),
    }
}

#[tauri::command]
fn compare_abort(jobs: State<'_, Jobs>, job_id: String) {
    if let Some(flag) = jobs.0.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// הרחבת דף גמרא — ±radius שורות לפי bookId/lineIndex.
#[tauri::command]
fn expand_page(
    db: State<'_, DbState>,
    line_id: i64,
    db_path: Option<String>,
) -> Result<Vec<LineRowOut>, String> {
    let resolved_db = db_path
        .as_deref()
        .map(|p| p.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| DEFAULT_DB_PATH.to_string());

    let mut guard = db.0.lock().unwrap();
    ensure_db(&mut guard, &resolved_db)?;
    let opendb = guard.as_ref().unwrap();
    let s = &opendb.schema;

    let (book_id, line_index): (i64, i64) = opendb
        .conn
        .query_row(
            &format!(
                "SELECT {bid}, {li} FROM line WHERE id=?",
                bid = s.book_id,
                li = s.line_index
            ),
            params![line_id],
            |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )
        .map_err(|e| e.to_string())?;

    let radius = 40i64;
    // עמודות חדשות — NULL fallback לסכמה ישנה (אינדקסים 4 ו-5)
    let toc_expr = if s.toc_entry_id.is_empty() { "NULL".to_string() } else { format!("l.{}", s.toc_entry_id) };
    let cc_expr  = if s.char_count.is_empty()   { "NULL".to_string() } else { format!("l.{}", s.char_count)   };
    let sql = format!(
        "SELECT l.id, l.{li} AS lineIndex, l.{hr} AS heRef, l.{ct} AS content, \
         {toc} AS tocEntryId, {cc} AS charCount \
         FROM line l WHERE l.{bid}=? AND l.{li} BETWEEN ? AND ? ORDER BY l.{li}",
        li  = s.line_index,
        hr  = s.he_ref,
        ct  = s.content,
        bid = s.book_id,
        toc = toc_expr,
        cc  = cc_expr,
    );
    let mut stmt = opendb.conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![book_id, (line_index - radius).max(0), line_index + radius],
            |r| {
                let id: i64 = r.get::<_, Option<i64>>(0)?.unwrap_or(0);
                Ok(LineRowOut {
                    line_id:      id,
                    line_index:   r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    he_ref:       r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    content:      strip_tags(&r.get::<_, Option<String>>(3)?.unwrap_or_default()),
                    is_focus:     id == line_id,
                    toc_entry_id: r.get::<_, Option<i64>>(4).unwrap_or(None),
                    char_count:   r.get::<_, Option<i64>>(5).unwrap_or(None),
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// דיאלוג בחירת קובץ native (txt/docx/pdf או db).
#[tauri::command]
fn pick_file(app: AppHandle, filter: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if filter == "db" {
        builder = builder.add_filter("מסד נתונים", &["db", "sqlite", "sqlite3"]);
    } else {
        builder = builder.add_filter("מסמכים", &["txt", "docx", "doc", "pdf"]);
    }
    builder
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

#[tauri::command]
fn build_ref_index(db_path: String, app: AppHandle) -> Result<(), String> {
    let path = if db_path.is_empty() { DEFAULT_DB_PATH.to_string() } else { db_path };
    std::thread::spawn(move || {
        let _ = app.emit("index-progress", "מתחיל...");
        match build_tantivy_index(&path) {
            Ok(_)  => { let _ = app.emit("index-progress", "הושלם"); }
            Err(e) => { let _ = app.emit("index-progress", format!("שגיאה: {e}")); }
        }
    });
    Ok(())
}

#[tauri::command]
fn check_ref_index(db_path: String) -> bool {
    let path = if db_path.is_empty() { DEFAULT_DB_PATH.to_string() } else { db_path };
    tantivy_index_exists(&path)
}

// ════════════════════════════════════════════════════════════════════════════
//  10. פתיחת תוצאה ישירות באוצריא
// ════════════════════════════════════════════════════════════════════════════

/// פותח את אוצריא ישירות על ספר ושורה מסוימת.
///
/// הלוגיקה:
///   1. מוצא את קובץ tabs.json של אוצריא (ב-AppData\Roaming\com.otzaria.otzaria)
///   2. כותב tab חדש עם הספר והאינדקס המבוקש
///   3. מפעיל את אוצריא (אם לא פועלת כבר) — Windows מביא את החלון קדמה אוטומטית
///      כי אוצריא בנויה כ-single-instance
///
/// book_title — שם הספר בדיוק כפי שמופיע בטור `title` של טבלת `book` ב-DB
/// line_index — מספר השורה שאוצריא תגלול אליה
#[tauri::command]
fn open_in_otzaria(
    book_title: String,
    line_index: i64,
    book_id: Option<i64>,
    db_path: Option<String>,
) -> Result<(), String> {
    // שלב 1: book_id מגיע ישירות מהתוצאה (מאותו JOIN שכבר מצא את הספר).
    // רק אם הוא לא סופק (תאימות לאחור) — ניפול לחיפוש לפי שם בתור fallback.
    let resolved_id: Option<i64> = book_id.filter(|id| *id > 0).or_else(|| {
        let db = db_path.unwrap_or_else(|| DEFAULT_DB_PATH.to_string());
        Connection::open_with_flags(
            &db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ).ok().and_then(|conn| {
            let cols = book_columns(&conn);
            let has = |name: &str| cols.iter().any(|c| c == name);
            let title_col = if has("title") { "title" } else { "name" };
            let sql = format!("SELECT id FROM book WHERE {0} = ?1 LIMIT 1", title_col);
            conn.query_row(&sql, rusqlite::params![&book_title], |r| r.get(0)).ok()
        })
    });

    // שלב 2: בנה deep link — פורמט מאומת: otzaria://open/book/{id}?index={line_index}
    let url = match resolved_id {
        Some(id) => format!("otzaria://open/book/{}?index={}", id, line_index),
        None => return Err(format!(
            "לא נמצא מזהה ספר עבור \"{}\" — לא ניתן לפתוח באוצריא במיקום המדויק",
            book_title
        )),
    };

    // שלב 3: פתח את ה-deep link — ללא חלון CMD גלוי
    // CREATE_NO_WINDOW (0x08000000) מונע את פתיחת חלון שורת הפקודה
    {
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "start", "", &url]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn().map_err(|e| format!("שגיאה בפתיחת אוצריא: {e}"))?;
    }

    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════
//  11. כניסת התוכנית — Tray + הסתרת חלון בסגירה
// ════════════════════════════════════════════════════════════════════════════

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DbState(Arc::new(Mutex::new(None))))
        .manage(Jobs(Arc::new(Mutex::new(HashMap::new()))))
        .invoke_handler(tauri::generate_handler![
            compare_start,
            compare_abort,
            expand_page,
            pick_file,
            open_in_otzaria,
            build_ref_index,
            check_ref_index
        ])
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let open_i = MenuItem::with_id(app, "open", "📖 פתח בודק מקורות", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "✕ סגור", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("בודק מקורות")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            // סגירת חלון → יציאה מלאה מהאפליקציה (ללא הסתרה לטריי)
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        app_handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running בודק מקורות");
}
