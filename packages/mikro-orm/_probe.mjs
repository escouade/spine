import { MikroORM, EntitySchema } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";

class User { }
const UserSchema = new EntitySchema({
  class: User,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
  },
});

let cur; // pretend CLS fork holder
// Try WITHOUT allowGlobalContext
const orm = MikroORM.initSync({
  driver: BetterSqliteDriver,
  dbName: ":memory:",
  entities: [UserSchema],
  context: () => cur,
});
console.log("initSync ok; connected before connect?", await orm.isConnected());
await orm.connect();
console.log("connected after connect?", await orm.isConnected());
await orm.schema.createSchema();
try {
  const f = orm.em.fork();
  console.log("fork() WITHOUT allowGlobalContext OK");
  cur = f;
  await f.begin();
  const u = f.create(User, { name: "x" });
  f.persist(u);
  await f.commit();
  console.log("persist+commit via fork OK, id=", u.id);
} catch (e) {
  console.log("fork/persist threw:", e.message.split("\n")[0]);
}
await orm.close(true);
console.log("closed; connected?", await orm.isConnected());
