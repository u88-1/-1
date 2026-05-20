const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const DB_PATH = 'C:/ProgramData/otzaria/books/seforim.db';
const TEXT_PATH = 'C:/Users/admin/Desktop/ספר שכר תורה הרב שם טוב גבאי/ערוך/חיי שרה מעודכן.txt';
const text = fs.readFileSync(TEXT_PATH, 'utf8');
const regex = /\{([^}]+)\}/g;
const refs = [];
let m;
while ((m = regex.exec(text)) !== null) {
  refs.push(m[1].trim());
}
const unique = [...new Set(refs)];
console.log('refs', refs.length, 'unique', unique.length);
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  console.log('db opened');
});
function queryReference(db, ref) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT l.id AS lineId, l.lineIndex, l.heRef, l.content, b.id AS bookId, b.title AS bookTitle, b.filePath AS bookPath FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef = ? COLLATE NOCASE LIMIT 1`;
    db.get(sql, [ref], (err, row) => {
      if (err) return reject(err);
      if (row) return resolve({ ref, row });
      const looseSql = `SELECT l.id AS lineId, l.lineIndex, l.heRef, l.content, b.id AS bookId, b.title AS bookTitle, b.filePath AS bookPath FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef LIKE ? COLLATE NOCASE LIMIT 1`;
      db.get(looseSql, [`%${ref}%`], (err2, row2) => {
        if (err2) return reject(err2);
        resolve({ ref, row: row2 || null });
      });
    });
  });
}
(async () => {
  for (const ref of unique) {
    console.log('querying', ref);
    const res = await queryReference(db, ref);
    console.log('result', ref, res.row ? res.row.heRef : 'NOT FOUND');
  }
  db.close();
})();
