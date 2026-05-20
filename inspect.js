const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = "C:/ProgramData/otzaria/books/seforim.db";
console.log("exists", fs.existsSync(path));
const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, err => {
  if (err) { console.error("open error", err.message); process.exit(1); }
  db.serialize(() => {
    db.all("SELECT name, type, sql FROM sqlite_master WHERE type='table' ORDER BY name", (err, rows) => {
      if (err) { console.error("schema error", err.message); process.exit(1); }
      console.log('TABLES', rows.length);
      rows.forEach(r => console.log(JSON.stringify(r)));
      console.log('--- sample book rows ---');
      db.all("SELECT id, title, heShortDesc, filePath, fileType FROM book LIMIT 5", (err, books) => {
        if (err) { console.error('book query error', err.message); process.exit(1); }
        books.forEach(b => console.log(JSON.stringify(b)));
        console.log('--- sample line rows ---');
        db.all("SELECT id, bookId, lineIndex, heRef, content FROM line WHERE heRef IS NOT NULL LIMIT 20", (err, lines) => {
          if (err) { console.error('line query error', err.message); process.exit(1); }
          lines.forEach(l => console.log(JSON.stringify(l)));
          db.close();
        });
      });
    });
  });
});
