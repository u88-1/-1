const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY);
db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, r) => {
    if (e) { console.log('שגיאה:', e.message); return; }
    console.log('טבלאות:', r.map(x => x.name));
    let done = 0;
    r.forEach(t => {
        db.all('PRAGMA table_info(' + t.name + ')', (e2, cols) => {
            console.log('\n--- ' + t.name + ' ---');
            if (cols) cols.forEach(c => console.log('  ' + c.name + ' (' + c.type + ')'));
            if (++done === r.length) db.close();
        });
    });
});
