# בניית "בודק מקורות" (Tauri) על Windows — צעד אחר צעד

האפליקציה בנויה ב-**Tauri 2** (ליבת Rust + WebView מערכתי). התוצר הסופי הוא
installer בודד וקטן (~5–15MB), לעומת 150MB+ ב-Electron.

> **מבנה הפרויקט**
> ```
> src/                  ← Frontend סטטי (index.html, main.js, style.css)
> src-tauri/            ← ליבת Rust
>   ├── Cargo.toml
>   ├── tauri.conf.json
>   ├── build.rs
>   ├── capabilities/default.json
>   ├── icons/icon.ico
>   └── src/main.rs     ← כל לוגיקת הליבה (חילוץ, נרמול, התאמה, FTS5, Sefaria)
> package.json          ← אופציונלי (להרצה דרך npm)
> ```

---

## 1. דרישות מקדימות (פעם אחת)

### א. Rust toolchain
התקן מ-<https://rustup.rs> (או הרץ `winget install Rustlang.Rustup`).
ודא:
```powershell
rustc --version
cargo --version
```

### ב. Microsoft C++ Build Tools
Tauri מקמפל קוד native ולכן צריך MSVC:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```
בהתקנה סמן את **"Desktop development with C++"** (כולל Windows 10/11 SDK).

### ג. WebView2 Runtime
מותקן כברירת מחדל ב-Windows 11. אם חסר — הורד מ:
<https://developer.microsoft.com/microsoft-edge/webview2/>

### ד. Tauri CLI
שתי דרכים — בחר אחת:

**דרך A — cargo (ללא Node, מומלץ):**
```powershell
cargo install tauri-cli --version "^2"
```
(הפקודות בהמשך ירוצו כ-`cargo tauri ...`)

**דרך B — npm:**
```powershell
npm install        # מתקין @tauri-apps/cli מ-package.json
```
(הפקודות בהמשך ירוצו כ-`npm run tauri -- ...`)

---

## 2. (אופציונלי אך מומלץ) יצירת סט אייקונים מלא
קיים כבר `src-tauri/icons/icon.ico`. כדי לייצר את כל הגדלים/פורמטים (כולל איכות
תצוגה טובה יותר) הרץ פעם אחת:
```powershell
cd src-tauri
cargo tauri icon icons/icon_source.png
cd ..
```
אם תעשה זאת — אפשר להחזיר ל-`tauri.conf.json` את רשימת האייקונים המלאה
(`32x32.png`, `128x128.png`, וכו'). ללא צעד זה, הבנייה עובדת עם ה-`.ico` בלבד.

---

## 3. הרצה במצב פיתוח (Hot-run)
```powershell
cargo tauri dev
```
(או `npm run dev`)

הפעם הראשונה מקמפלת את כל ה-crates ולכן אורכת מספר דקות; לאחר מכן ההרצה מהירה.

---

## 4. בניית installer לשחרור (release)
```powershell
cargo tauri build
```
(או `npm run build`)

הפלט נוצר תחת:
```
src-tauri/target/release/                         ← bodek-mekorot.exe (הבינארי)
src-tauri/target/release/bundle/nsis/             ← *_setup.exe (ה-installer להפצה)
```

---

## 5. הרצה
- את ה-**installer** (`...setup.exe`) מפיצים למשתמשים.
- את ה-**exe** הבודד אפשר להריץ ישירות (דורש WebView2 מותקן).
- בסגירת החלון האפליקציה ממוזערת ל-**מגש המערכת (Tray)** וממשיכה לרוץ;
  יציאה מלאה — לחיצה ימנית על אייקון המגש → "סגור".

---

## 6. מסד הנתונים (`seforim.db`)
האפליקציה פותחת את ה-DB ב-**READ-ONLY**. נתיב ברירת המחדל הקשיח:
```
C:/ProgramData/otzaria/books/seforim.db
```
ניתן לבחור נתיב אחר בשדה "מסד נתונים" בדף הראשי או בהגדרות.

**סכמה נתמכת:** הקוד מזהה אוטומטית את שמות העמודות —
גם הסכמה הקיימת של אוצריא (`heRef`, `bookId`, `lineIndex`) וגם סכמת snake_case
(`he_ref`, `book_id`, `line_index`).

**FTS5 (חיפוש מטושטש מהיר):** אם קיימת במאגר טבלת `line_fts` (FTS5), החיפוש
המטושטש משתמש ב-`MATCH` (מילישניות בודדות). אם לא — נופלים אוטומטית ל-`LIKE`.
ליצירת הטבלה פעם אחת על עותק *כתיב* של ה-DB:
```sql
CREATE VIRTUAL TABLE line_fts USING fts5(he_ref, content, content='line', content_rowid='id');
INSERT INTO line_fts(rowid, he_ref, content) SELECT id, heRef, content FROM line;
```
(התאם את שמות העמודות לסכמה שבמאגר שלך.)

---

## 7. פתרון תקלות

| תקלה | פתרון |
|------|-------|
| `link.exe not found` / שגיאות linker | לא הותקנו C++ Build Tools (סעיף 1ב). |
| בנייה נכשלת על שם המוצר העברי ב-NSIS | ב-`tauri.conf.json` החלף זמנית `"productName": "בודק מקורות"` ל-`"BodekMekorot"` (כותרת החלון נשארת עברית דרך `app.windows[0].title`). |
| `pdf-extract` נכשל בקומפילציה | ודא Build Tools מעודכן; אם נחוץ, ניתן להסיר זמנית את התלות ולהשבית תמיכת PDF. |
| חלון לבן / `__TAURI__ is undefined` | ודא ש-`app.withGlobalTauri = true` ב-`tauri.conf.json`. |
| הבנייה הראשונה איטית מאוד | תקין — קימפול ראשוני של כל ה-crates. הרצות הבאות משתמשות ב-cache. |

---

## 8. מה הוסר מהגרסה הקודמת (Electron)
- `main.js` (Electron), `server.js` (+מנגנון `mshta.exe`), `run_gui.bat`.
- `compare_sources.js` — הליבה מומשה מחדש במלואה ב-Rust (`src-tauri/src/main.rs`).
- סקריפטי דיבוג: `check_db.js`, `inspect*.js`, `explain_query.js`,
  `search_patterns*.js`, `test_*.js`, `argtest.js`, `dbtest.js`,
  `compare_sources_debug.js`.
