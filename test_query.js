const sqlite3 = require('sqlite3').verbose();
const ref = `עפ"י ישעיהו נז, א; ומגילה טו.`;
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  console.log('db opened');
  const sql = `SELECT l.id AS lineId, l.lineIndex, l.heRef, l.content, b.title AS bookTitle, b.filePath AS bookPath FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef LIKE ? COLLATE NOCASE LIMIT 5`;
  db.all(sql, [`${ref}%`], (err2, rows) => {
    if (err2) {
      console.error('query err', err2);
      process.exit(1);
    }
    console.log('rows', rows.length);
    rows.forEach(r => console.log(r.heRef));
    db.close();
  });
});
