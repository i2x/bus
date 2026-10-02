// สร้างตารางจาก schema.sql (รันซ้ำได้)
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"))
  .then(() => { console.log("schema ok"); return pool.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
