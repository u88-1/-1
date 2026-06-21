# build.ps1 — בניית "בודק מקורות" ל-EXE/installer, בלחיצה אחת
#
# שימוש: לחץ קליק ימני על קובץ זה → "Run with PowerShell".
# (אם Windows חוסם הרצת סקריפטים, פתח PowerShell בתיקייה הזו והרץ קודם:
#  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass )

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

# ── שלב 1: Rust ───────────────────────────────────────────────────────
Section "שלב 1/4 — בדיקת Rust"
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "Rust לא מותקן על המחשב הזה." -ForegroundColor Yellow
    Write-Host "פותח את עמוד ההתקנה הרשמי (rustup.rs)..." -ForegroundColor Yellow
    Start-Process "https://rustup.rs"
    Write-Host ""
    Write-Host "אחרי ההתקנה: סגור את החלון הזה, פתח PowerShell חדש בתיקייה הזו, והרץ את build.ps1 שוב." -ForegroundColor Red
    Read-Host "לחץ Enter ליציאה"
    exit 1
}
cargo --version
rustc --version

# ── שלב 2: Tauri CLI ──────────────────────────────────────────────────
Section "שלב 2/4 — בדיקת Tauri CLI"
$tauriOk = $true
try { cargo tauri --version | Out-Null } catch { $tauriOk = $false }
if (-not $tauriOk) {
    Write-Host "מתקין Tauri CLI (פעם אחת, כמה דקות)..." -ForegroundColor Yellow
    cargo install tauri-cli --version "^2" --locked
} else {
    Write-Host "Tauri CLI כבר מותקן." -ForegroundColor Green
}

# ── שלב 3: בנייה ──────────────────────────────────────────────────────
Section "שלב 3/4 — בנייה (בפעם הראשונה זה יכול לקחת כמה דקות)"
Push-Location (Join-Path $root "src-tauri")
$buildFailed = $false
try {
    cargo tauri build
} catch {
    $buildFailed = $true
}
Pop-Location

if ($buildFailed) {
    Write-Host ""
    Write-Host "הבנייה נכשלה." -ForegroundColor Red
    Write-Host "הסיבה הנפוצה ביותר: חסרים כלי הבנייה של C++ (MSVC)." -ForegroundColor Yellow
    Write-Host "פתרון: התקן 'Desktop development with C++' מ-Visual Studio Build Tools:" -ForegroundColor Yellow
    Write-Host "  winget install Microsoft.VisualStudio.2022.BuildTools" -ForegroundColor White
    Write-Host "(ראה גם טבלת פתרון תקלות בקובץ BUILD.md, סעיף 7)" -ForegroundColor Yellow
    Read-Host "`nלחץ Enter ליציאה"
    exit 1
}

# ── שלב 4: איתור הקובץ המוגמר ─────────────────────────────────────────
Section "שלב 4/4 — סיום"
$bundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
if (Test-Path $bundleDir) {
    $setup = Get-ChildItem $bundleDir -Filter "*.exe" | Select-Object -First 1
    if ($setup) {
        Write-Host "הבנייה הצליחה! קובץ ההתקנה מוכן:" -ForegroundColor Green
        Write-Host "  $($setup.FullName)" -ForegroundColor White
        Write-Host ""
        Write-Host "הרץ אותו כדי להתקין את 'בודק מקורות' כתוכנה רגילה על המחשב." -ForegroundColor Green
        Invoke-Item $bundleDir
    } else {
        Write-Host "התיקייה נמצאה אך לא נמצא בה קובץ .exe — בדוק הודעות שגיאה למעלה." -ForegroundColor Yellow
    }
} else {
    Write-Host "הבנייה רצה אך תיקיית ה-bundle לא נמצאה בנתיב הצפוי. בדוק הודעות שגיאה למעלה." -ForegroundColor Yellow
}

Read-Host "`nלחץ Enter לסגירה"
