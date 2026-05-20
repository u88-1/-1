const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('open err', err);
    process.exit(1);
  }
  db.all("PRAGMA index_list('line')", (err, rows) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log('index_list line', rows);
    const idxs = rows.filter(r => r.name).map(r => r.name);
    let pending = idxs.length;
    if (!pending) {
      db.close();
      return;
    }
    idxs.forEach(name => {
      db.all(`PRAGMA index_info('${name}')`, (err2, info) => {
        if (err2) {
          console.error(err2);
          process.exit(1);
        }
        console.log('index_info', name, info);
        if (!--pending) db.close();
      });
    });
  });
});
