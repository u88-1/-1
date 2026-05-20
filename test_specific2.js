const sqlite3 = require('sqlite3').verbose();
const ref = 'רש"י בראשית כח, י';
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  console.time('exact');
  db.get(`SELECT l.id AS lineId, l.heRef FROM line l WHERE l.heRef = ? COLLATE NOCASE LIMIT 1`, [ref], (err, row) => {
    console.timeEnd('exact');
    if (err) {
      console.error('err', err);
    } else {
      console.log('row', row);
    }
    db.close();
  });
});
