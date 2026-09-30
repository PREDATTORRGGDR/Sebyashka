import { createDb, migrate } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL не задан");
  process.exit(1);
}
const sql = createDb(url, { max: 1 });
await migrate(sql, (m) => console.log(m));
await sql.end();
console.log("миграции применены");
