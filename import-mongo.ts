import { importMongo } from "./src/mongo-target";

importMongo(process.argv.slice(2))
  .then((games) => console.log(JSON.stringify({ brand: "3 OAKS", imported: games.length }, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
