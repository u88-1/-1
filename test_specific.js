const sqlite3 = require('sqlite3').verbose();
const ref = "רש\"י בראשית כח, י";
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  console.log('db opened');
  const sql1 = `SELECT l.id AS lineId, l.lineIndex, l.heRef, l.content, b.title AS bookTitle FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef = ? COLLATE NOCASE LIMIT 1`;
  console.time('exact');
  db.get(sql1, [ref], (err, row) => {
    console.timeEnd('exact');
    if (err) {
      console.error('exact err', err);
    } else if (row) {
      console.log('exact row', row.heRef);
    } else {
      console.log('exact none');
      const cleaned = ref.replace(/[.,;:]+$/g, '').trim();
      const sql2 = `SELECT l.id AS lineId, l.lineIndex, l.heRef, l.content, b.title AS bookTitle FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef LIKE ? COLLATE NOCASE LIMIT 1`;
      console.time('prefix');
      db.get(sql2, [`${cleaned}%`], (err2, row2) => {
        console.timeEnd('prefix');
        if (err2) {
          console.error('prefix err', err2);
        } else if (row2) {
          console.log('prefix row', row2.heRef);
        } else {
          console.log('prefix none');
        }
        db.close();
      });
    }
  });
});
