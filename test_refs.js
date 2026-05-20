const sqlite3 = require('sqlite3').verbose();
const refs = [
  'עפ"י ישעיהו נז, א; ומגילה טו.',
  'רש"י בראשית כח, י',
  'עפ"י דברים כד, י',
  'עפ"י שבת לג:',
  'בבא בתרא קעג:',
  'איכה רבה ד, יד',
  'תהלים עט, א',
  'איכה רבה, פתיחתא כד',
  'על פי גיטין מח ע"ב',
  'גיטין שם'
];
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) throw err;
  const sql = `SELECT l.heRef, b.title AS bookTitle, l.lineIndex FROM line l JOIN book b ON l.bookId = b.id WHERE l.heRef = ? LIMIT 1`;
  let idx = 0;
  function next() {
    if (idx >= refs.length) {
      db.close();
      return;
    }
    const ref = refs[idx++];
    db.get(sql, [ref], (err, row) => {
      if (err) { console.error('error', ref, err); next(); return; }
      console.log('REF', ref, '=>', row ? `${row.heRef} [${row.bookTitle}]` : 'NOT FOUND');
      next();
    });
  }
  next();
});
