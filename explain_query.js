const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  const ref = "עפ\"י דברים כד, י";
  const queries = [
    { name: 'exact', sql: `EXPLAIN QUERY PLAN SELECT * FROM line WHERE heRef = ? LIMIT 1`, params: [ref] },
    { name: 'exact_no_limit', sql: `EXPLAIN QUERY PLAN SELECT * FROM line WHERE heRef = ?`, params: [ref] },
    { name: 'prefix', sql: `EXPLAIN QUERY PLAN SELECT * FROM line WHERE heRef LIKE ? LIMIT 1`, params: [`${ref}%`] },
    { name: 'like_any', sql: `EXPLAIN QUERY PLAN SELECT * FROM line WHERE heRef LIKE ? LIMIT 1`, params: [`%דברים כד, י%`] },
  ];
  let idx = 0;
  function next() {
    if (idx >= queries.length) {
      db.close();
      return;
    }
    const q = queries[idx++];
    db.all(q.sql, q.params, (err2, rows) => {
      if (err2) {
        console.error(q.name, 'err', err2);
        process.exit(1);
      }
      console.log('===', q.name, '===');
      console.log(rows);
      next();
    });
  }
  next();
});
