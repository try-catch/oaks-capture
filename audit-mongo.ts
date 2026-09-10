import { auditMongo } from "./src/mongo-target";

auditMongo(process.argv.slice(2))
  .then((games) => console.log(JSON.stringify({ brand: "3 OAKS", audited: games.length, valid: true }, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
