const sqlite3 = require('sqlite3').verbose();
const patterns = [
  '%דברים כד, י%',
  '%רש"י בראשית כח%',
  '%עפ\'י ישעיהו נז%',
  '%בבא בתרא קעג%',
  '%תהלים עט, א%',
  '%איכה רבה ד, יד%',
  '%עפ\'י שבת לג%',
  '%על פי גיטין מח ע\"ב%'
];
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) throw err;
  let idx = 0;
  function next() {
    if (idx >= patterns.length) {
      db.close();
      return;
    }
    const pattern = patterns[idx++];
    db.all(`SELECT DISTINCT l.heRef FROM line l WHERE l.heRef LIKE ? LIMIT 20`, [pattern], (err, rows) => {
      console.log('PATTERN', pattern, 'count', rows.length);
      rows.forEach(r => console.log('  ', r.heRef));
      next();
    });
  }
  next();
});
