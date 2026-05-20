const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const text = fs.readFileSync('C:/Users/admin/Desktop/ספר שכר תורה הרב שם טוב גבאי/ערוך/חיי שרה מעודכן.txt', 'utf8');
const refs = []; const regex = /\{([^}]+)\}/g; let match;
while ((match = regex.exec(text)) !== null) {
  refs.push(match[1].replace(/\s+/g,' ').replace(/^(עפ(?:['"\u2018\u2019\u201C\u201D]י|י)\s+|על פי\s+)/i, '').replace(/[.,;:]+$/g,'').trim());
}
const unique = [...new Set(refs)];
const db = new sqlite3.Database('C:/ProgramData/otzaria/books/seforim.db', sqlite3.OPEN_READONLY, err=>{ if(err) throw err; run();});
function run(){
  let i=0;
  function next(){
    if(i>=unique.length){ db.close(); return; }
    const ref = unique[i++];
    const start = Date.now();
    db.get('SELECT heRef FROM line WHERE heRef = ? COLLATE NOCASE LIMIT 1', [ref], (err,row)=>{
      console.log(i, ref, 'time', Date.now()-start, 'row', row?row.heRef:'NOT FOUND');
      next();
    });
  }
  next();
}
