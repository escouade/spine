---
sidebar_position: 4
---

# MikroORM (persistance)

`@spinejs/mikro-orm` donne à chaque requête son propre `EntityManager` / unité de travail
transactionnel, porté par le [CLS](./cls) de spine. Vous configurez la connexion **une seule fois**,
vous enregistrez **un** interceptor, et vos services persistent les changements du domaine à la fin de
la requête — **sans faire passer de manager dans les signatures** et **sans `.save()`**. Un service
charge une entité, la modifie, et le changement est commité quand la requête réussit ou annulé quand
elle lève une exception.

## Installation

```bash
yarn add @spinejs/mikro-orm @mikro-orm/core @mikro-orm/better-sqlite
```

`@mikro-orm/core` et un driver (ici `@mikro-orm/better-sqlite`) sont des peers — choisissez le driver
de votre base. Le package s'appuie sur [`@spinejs/cls`](./cls) pour la portée par requête, donc
`ClsModule` et son `ClsInterceptor` sont câblés à ses côtés (voir plus bas). Épinglez MikroORM en
**v6** (core **et** driver) : les drivers sqlite ne publient pas encore la v7.

## Une application minimale

On construit une ressource `User` de bout en bout : modéliser les données, configurer la connexion,
enregistrer le repository, l'utiliser dans un service. Nouveau sur SpineJS ? Suivez d'abord
[Getting Started](../getting-started) pour le parcours `main.ts` → gateway → controller ; cette page
reprend au niveau de la persistance.

```
src/
  user.entity.ts
  modules/
    app.module.ts
    user/
      user.module.ts
      user.service.ts
```

### 1. L'entité et son repository — `user.entity.ts`

Définissez l'entité avec **`EntitySchema`** (sans décorateurs) et, optionnellement, une sous-classe de
repository comme foyer des requêtes personnalisées. Le schéma relie les deux avec
`repository: () => UserRepository` — c'est ce lien qui permet à `register([UserRepository])` (étape 3)
de retrouver l'entité.

```typescript
// src/user.entity.ts
import { EntitySchema, EntityRepository } from "@spinejs/mikro-orm";

export class User {
  id!: number;
  email!: string;
  name!: string;
}

// Le foyer des requêtes personnalisées — injecté plus tard par son token de classe.
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}

export const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository, // REQUIS pour que register([UserRepository]) résolve l'entité
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    email: { type: "string" },
    name: { type: "string" },
  },
});
```

:::warning ⚠️ Définissez les entités avec `EntitySchema`, pas avec des décorateurs
Sous le build de spine (esbuild / décorateurs stage-3, **sans** `emitDecoratorMetadata`), les
décorateurs d'entité de MikroORM **v6** (`@Entity`, `@Property`, …) sont **legacy uniquement** — ils
exigent `experimentalDecorators` et ne fonctionnent **pas** avec les décorateurs stage-3 que spine
cible. **`EntitySchema` (sans décorateurs) est le style portable et recommandé** — il ne nécessite
aucun `reflect-metadata` et fonctionne partout.

Si vous devez utiliser des entités à décorateurs (mode legacy uniquement), vous perdez aussi
`emitDecoratorMetadata`, donc chaque propriété a besoin d'un `type` explicite :
`@Property({ type: "string" })`, jamais un `@Property()` nu. MikroORM **v7** ajoute les décorateurs
stage-3 via `@mikro-orm/decorators/es` (toujours sans `reflect-metadata`) — utilisable une fois que le
package passera en v7.
:::

### 2. Configurer la connexion une seule fois — `modules/app.module.ts`

`MikroOrmModule.configure(options)` enregistre une connexion unique au niveau de l'app. L'instance
`MikroORM` est construite au build du module, **connectée au démarrage** (avec retry) et **fermée à
l'arrêt** — le module possède le cycle de vie, vous n'appelez jamais `connect()`/`close()` vous-même.
Importez `ClsModule` à ses côtés : la portée par requête roule sur CLS.

```typescript
// src/modules/app.module.ts
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule } from "@spinejs/mikro-orm";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { UserSchema } from "../user.entity";
import { UserModule } from "./user/user.module";

@Module({
  imports: [
    ClsModule,
    MikroOrmModule.configure({
      driver: BetterSqliteDriver,
      dbName: "app.sqlite",
      entities: [UserSchema],
      // retry de démarrage optionnel (défauts : 5 tentatives, 200ms, backoff ×2)
      retry: { attempts: 10, delayMs: 500, backoff: 2 },
    }),
    UserModule,
  ],
})
export class AppModule {}
```

### 3. Exposer le repository — `modules/user/user.module.ts`

`MikroOrmModule.register([...])` rend les repositories d'un module injectables **par token de
classe**. Il fusionne dans la même connexion au niveau de l'app — `configure()` l'ouvre, chaque
`register()` en expose une part.

```typescript
// src/modules/user/user.module.ts
import { Module } from "@spinejs/core";
import { MikroOrmModule } from "@spinejs/mikro-orm";
import { UserRepository } from "../../user.entity";
import { UserService } from "./user.service";

@Module({
  imports: [MikroOrmModule.register([UserRepository])],
  providers: [UserService],
})
export class UserModule {}
```

### 4. L'utiliser — `modules/user/user.service.ts`

Injectez le repository par son token de classe (`inject:` typé, [style ADR 0008](../core/dependency-injection)).
Chargez une entité, modifiez-la, et **arrêtez-vous** — le changement est suivi (dirty-tracking) et
commité à la fin de la requête. Pas de `.save()`, pas d'argument `EntityManager`, aucune gestion de
transaction.

```typescript
// src/modules/user/user.service.ts
import { Injectable } from "@spinejs/core";
import { UserRepository } from "../../user.entity";

@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}

  async rename(id: number, name: string) {
    const user = await this.users.findOneOrFail({ id });
    user.name = name; // dirty-tracké ; commité à la fin de la requête. Pas de .save().
  }
}
```

Il reste une pièce : l'interceptor qui ouvre la transaction par requête. C'est lui qui fait
fonctionner l'étape 4, et il se câble sur le transport — voir juste après.

## Câbler l'interceptor transactionnel

`MikroOrmInterceptor` est ce qui transforme l'étape 4 en transaction commitée. Enregistrez-le dans le
`configure({ interceptors })` de votre transport, **après** `ClsInterceptor` — il fork l'`EntityManager`
de la requête dans la portée CLS, il doit donc s'exécuter **à l'intérieur** de la portée qu'ouvre
`ClsInterceptor`. (Voir [Interceptors](../gateway/interceptors) pour l'adaptateur `interceptors` — une
`value` ou une `factory` DI.)

```typescript
// là où vous configurez le transport (HTTP, IPC, …)
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import { MikroOrmInterceptor } from "@spinejs/mikro-orm";
import type { HttpBaseContext } from "@spinejs/http-gateway";

HttpGatewayModule.configure({
  imports: [ClsModule], // ClsService pour le ClsInterceptor
  contextFactory: {
    /* … */
  },
  interceptors: {
    inject: [ClsService, MikroOrmInterceptor],
    factory: (cls: ClsService, orm: MikroOrmInterceptor) => [
      new ClsInterceptor<HttpBaseContext>(cls), // 1. le plus externe : ouvre la portée CLS
      // 2. dans la portée : fork l'EM + flush en fin de requête. MikroOrmInterceptor est
      // transport-agnostique, donc il entre tel quel dans le slot — sans cast.
      orm,
    ],
  },
});
```

`MikroOrmInterceptor` est exporté par `MikroOrmModule.configure()` (enregistré au niveau de l'app à
l'étape 2), donc la factory d'interceptors le résout par token. L'ordre compte : `ClsInterceptor`
d'abord (il ouvre la portée), `MikroOrmInterceptor` ensuite (il écrit le fork dans cette portée).

`MikroOrmInterceptor` est transport-agnostique (il ne lit jamais le `ctx` ni la route), donc son type
est le `GatewayInterceptor<GatewayContext, …>` de base. Vous l'ajoutez au tableau `interceptors`
**tel quel** — sans cast ni enveloppe : le slot `interceptors` d'un transport est un `ChainInterceptor`,
dont l'union admet explicitement un interceptor de base transport-agnostique à côté d'un interceptor
spécifique au transport.

## Comment fonctionne la transaction

L'interceptor est tout le différenciateur, et il est petit :

```typescript
const em = this.orm.em.fork(); // identity map + unité de travail neuves pour CETTE requête
this.cls.set(EM, em); // tout repository/EntityManager injecté résout désormais vers lui
const res = await next(); // vos handlers + services s'exécutent ici
// Le pipeline ne throw jamais : les erreurs métier reviennent en { ok: false }. On flush uniquement
// une unité de travail réussie — MikroORM enveloppe les changements dans UNE transaction (atomique,
// pas de .save()). Une requête qui n'a rien écrit ne flush rien (aucune transaction) ; une enveloppe
// d'erreur ne persiste rien.
if (res.ok) {
  await em.flush();
}
return res;
```

Pourquoi il n'y a pas de `.save()` : MikroORM a une **unité de travail** et une **identity map**.
Quand vous chargez une entité via l'`EntityManager` de la requête, l'ORM la suit ; modifier un champ
la marque comme sale ; le `flush()` de fin de requête écrit tous les changements suivis dans une seule
transaction — et une requête qui n'a rien changé n'ouvre aucune transaction.
`fork()` donne à chaque requête sa propre identity map, donc deux requêtes concurrentes ne voient
jamais les écritures en attente l'une de l'autre — le fork est lié au contexte asynchrone (CLS), pas
au singleton injecté.

`orm.em` — le getter que vous injectez comme `EntityManager` — est toujours le manager **racine** ;
chaque opération qu'il expose (`find`, `persist`, …) délègue au fork de la requête courante via
`getContext()`. Un `EntityManager` ou un repository injecté résout donc le fork de façon transparente.
Comparez les identités sur `orm.em.getContext()`, jamais sur `orm.em`.

:::note Une portée doit être active
En dehors d'une requête (aucune portée CLS avec un fork positionné), il n'y a pas de fork à résoudre.
Chaque point d'entrée qui touche la base doit s'exécuter dans la portée de l'interceptor. Pour du
travail hors requête (une tâche CLI, un script de seed), ouvrez une portée vous-même et faites
`orm.em.fork()` manuellement.
:::

## Entités sans repository personnalisé

Une sous-classe de repository est optionnelle. Pour une entité qui n'a pas besoin de requêtes
personnalisées, enregistrez la **classe d'entité** et injectez son repository par défaut via
`repositoryOf(Entity)` — un `InjectionToken<EntityRepository<Entity>>` typé :

```typescript
// user.module.ts — enregistrer la classe d'entité au lieu d'un repository
@Module({ imports: [MikroOrmModule.register([User])] })
export class UserModule {}
```

```typescript
// user.service.ts — injecter le repository par défaut par token
import { Injectable } from "@spinejs/core";
import { EntityRepository, repositoryOf } from "@spinejs/mikro-orm";
import { User } from "../../user.entity";

@Injectable({ inject: [repositoryOf(User)] })
export class UserService {
  constructor(private readonly users: EntityRepository<User>) {}
  find(id: number) {
    return this.users.findOne({ id });
  }
}
```

`repositoryOf(User) === repositoryOf(User)` — le token est stable par entité, donc le même appel le
fournit et l'injecte. Un mauvais type de token dans un tableau `inject:` échoue à la **compilation**,
pas à l'exécution.

## Retry au démarrage

Une base transitoire (un conteneur encore en train de démarrer, un bref incident réseau) ne devrait
pas faire échouer toute l'app à la première tentative de connexion. `configure({ retry })` réessaie la
connexion **initiale** avec un backoff ; ce n'est qu'une fois le budget épuisé que le démarrage lève —
ce qui interrompt le boot proprement plutôt que de démarrer à moitié connecté.

```typescript
MikroOrmModule.configure({
  driver: BetterSqliteDriver,
  dbName: "app.sqlite",
  entities: [UserSchema],
  retry: { attempts: 10, delayMs: 500, backoff: 2 }, // 500 → 1000 → 2000ms …
});
```

Omettez `retry` pour utiliser la politique par défaut : **5 tentatives, 200ms, backoff ×2**
(200 → 400 → 800 → 1600ms). Perdre la connexion _pendant l'exécution_ est un autre problème, géré par
le pool de connexions du driver (exposez ses options via les mêmes `Options` MikroORM) ; le package ne
réessaie que la connexion initiale.

## Journalisation

Le module fait passer la sortie propre de MikroORM (requêtes sous `debug`, événements de connexion)
vers le [logger](../core/logging) de spine — **un seul puits**, pas un second flux — et journalise son
propre cycle de vie de connexion (connexion, connecté, tentative _N_, échec final, fermeture). Un
`logger` que vous passez dans les options de `configure()` l'emporte ; si aucun logger spine n'est
disponible, le pont se dégrade en no-op et ne lève jamais.

## Connexions multiples

La plupart des apps n'ont qu'une base. Quand il en faut plusieurs — un replica de lecture, un store
d'analytics ou d'audit séparé — donnez un `name` à chaque connexion **additionnelle**. La connexion par
défaut (sans `name`) garde les tokens classe `MikroORM` / `EntityManager` et tout ce qui précède,
inchangé ; une connexion nommée s'injecte via `mikroOrmRef(name)` / `entityManagerRef(name)` et apporte
son **propre** cycle de vie connexion/fermeture et son retry.

```typescript
// modules/app.module.ts
import { MikroOrmModule } from "@spinejs/mikro-orm";

// La connexion par défaut — tokens classe, exactement comme avant.
const primary = MikroOrmModule.configure({
  driver: BetterSqliteDriver,
  dbName: "app.sqlite",
  entities: [UserSchema],
});

// Une connexion nommée — son propre cycle de vie, injectée par ref.
const audit = MikroOrmModule.configure({
  name: "audit",
  driver: BetterSqliteDriver,
  dbName: "audit.sqlite",
  entities: [AuditLogSchema],
});
```

Chaque connexion a son **propre** interceptor. Empilez sur le transport chacun de ceux que vous
utilisez, après `ClsInterceptor` — chacun fork son propre `EntityManager` de requête dans son propre
emplacement, si bien que les connexions ne croisent jamais leurs forks de requête :

```typescript
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import {
  MikroOrmInterceptor,
  mikroOrmInterceptorRef,
} from "@spinejs/mikro-orm";

HttpGatewayModule.configure({
  imports: [ClsModule, primary, audit],
  contextFactory: {
    /* … */
  },
  interceptors: {
    // `MikroOrmInterceptor` (token classe) est celui de la connexion par défaut ;
    // `mikroOrmInterceptorRef("audit")` celui de la connexion nommée. Tous deux transport-agnostiques —
    // ils entrent dans le tableau tels quels, sans cast.
    inject: [ClsService, MikroOrmInterceptor, mikroOrmInterceptorRef("audit")],
    factory: (cls, primaryTx, auditTx) => [
      new ClsInterceptor(cls), // 1. ouvre la portée CLS
      primaryTx, // 2. encadre l'unité de travail de la connexion par défaut
      auditTx, // 3. encadre l'unité de travail de la connexion "audit"
    ],
  },
});
```

Liez les repositories d'une feature à une connexion avec `register(..., { connection })`, et atteignez
le repository par défaut d'une entité sur une connexion avec `repositoryOf(Entity, connection)` :

```typescript
// modules/audit/audit.module.ts
@Module({
  imports: [MikroOrmModule.register([AuditLog], { connection: "audit" })],
})
export class AuditModule {} // injecter repositoryOf(AuditLog, "audit")
```

Une **classe repository custom** est injectée par son propre token de classe, qui ne porte aucune
connexion — elle est donc liée à une seule connexion. Pour exposer une entité sur plus d'une connexion,
utilisez la forme **classe d'entité** : `repositoryOf(Entity, connection)` namespace le token par
connexion.

### Écrire plus d'une connexion dans une requête

On ne peut pas écrire deux bases de façon atomique — MikroORM n'a pas de commit à deux phases, et une
transaction validée ne peut pas être annulée. Donc par défaut une requête écrit **au plus une**
connexion : si l'unité de travail d'une seconde connexion est aussi modifiée, l'interceptor **lève** —
rendant l'écriture cross-base non sûre **bruyante** au lieu de la laisser passer en silence. Ce n'est
**pas** un rollback : les interceptors se déroulent du plus interne au plus externe, donc la connexion
flushée en premier peut déjà être validée ; la levée refuse la _seconde_ écriture.

Quand vous acceptez ce compromis — par exemple une écriture principale plus une ligne d'audit
best-effort — activez `multiWrite` sur **chaque** connexion participante (un seul manquant déclenche le
garde) :

```typescript
MikroOrmModule.configure({ name: "audit", multiWrite: true /* … */ });
```

Leurs unités de travail sont alors flushées **séquentiellement, best-effort** : si le second flush
échoue, le premier est déjà validé. Il n'y a **aucune atomicité cross-base** — passez par un pattern
saga / outbox quand vous en avez besoin. L'ordre de flush est l'**inverse** du tableau d'interceptors
(ils se déroulent du plus interne au plus externe) : la connexion empilée en **dernier** flushe en
**premier**. L'opt-in est vérifié indépendamment de l'ordre, donc cela décide seulement quel commit
atterrit en premier sous `multiWrite`, jamais si le garde se déclenche.

:::note
Le `EntityManager` d'une connexion nommée touché dans une requête dont l'interceptor n'a **pas** été
empilé lève un diagnostic de câblage — il refuse de retomber sur un manager partagé hors-portée (une
fuite inter-requêtes). Empilez l'interceptor de chaque connexion que vous utilisez.
:::

## Le câblage à la main (la factory) {#by-hand}

`configure()` n'a rien de magique — c'est une petite composition DI inspectable : un provider de valeur
pour les options, un factory provider pour `MikroORM` (`mikroOrmProvider`), le provider
d'`EntityManager` (`entityManagerProvider`), l'interceptor, et les tokens de repository. Tout cela est
de la DI spine ordinaire, vous pouvez donc écrire le même câblage à la main quand vous voulez un
contrôle total sur `MikroORM.initSync(...)`. Le package exporte les briques de base —
`mikroOrmProvider`, `entityManagerProvider` et `connectWithRetry` — précisément pour ça.

Voici l'équivalent de `configure()`, explicité. Il réutilise `entityManagerProvider` et
`connectWithRetry` exportés, et écrit à la main la factory `MikroORM` et l'interceptor pour que vous
voyiez les deux lignes porteuses : le hook `context` du CLS et le `fork()` par requête.

```typescript
// src/modules/db.module.ts
import {
  Module,
  loggerToken,
  type DynamicModule,
  type FactoryProvider,
  type Logger,
  type OnStart,
  type OnStop,
} from "@spinejs/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import {
  MikroORM,
  EntityManager,
  connectWithRetry,
  entityManagerProvider,
} from "@spinejs/mikro-orm";
import { UserSchema } from "../user.entity";

// La clé CLS unique que la factory lit et que l'interceptor écrit — le contrat entre les deux.
const EM = "app:orm-em";

// 1. Construire (pas connecter) MikroORM au build ; pointer son hook `context` sur le CLS de spine.
const ormProvider: FactoryProvider<MikroORM> = {
  provide: MikroORM,
  inject: [ClsService, loggerToken],
  factory: (cls: ClsService, log?: Logger): MikroORM =>
    MikroORM.initSync({
      driver: BetterSqliteDriver,
      dbName: "app.sqlite",
      entities: [UserSchema],
      context: () => cls.get(EM) as EntityManager | undefined, // ← un seul ALS, celui de spine
      logger: (msg) => log?.debug(msg, "Db"), // pont vers le logger de spine
    }),
};

// 2. Fork + flush de l'unité de travail par dispatch (ce que fait MikroOrmInterceptor).
export class TransactionInterceptor implements GatewayInterceptor {
  constructor(
    private readonly orm: MikroORM,
    private readonly cls: ClsService
  ) {}
  async intercept(
    _target: DispatchTarget<GatewayContext>,
    _ctx: GatewayContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    const em = this.orm.em.fork();
    this.cls.set(EM, em);
    const res = await next();
    // Le pipeline ne throw jamais : les erreurs métier sont { ok: false }. On flush uniquement un
    // succès — atomique, sans .save() ; une requête sans écriture n'ouvre aucune transaction.
    if (res.ok) {
      await em.flush();
    }
    return res;
  }
}

// 3. Posséder le cycle de vie de la connexion ; réessayer la connexion initiale via le helper exporté.
@Module({ inject: [MikroORM, loggerToken] })
export class DbModule implements OnStart, OnStop {
  constructor(private readonly orm: MikroORM, private readonly log: Logger) {}
  onStart(): Promise<void> {
    return connectWithRetry(
      this.orm,
      { attempts: 5, delayMs: 200, backoff: 2 },
      this.log
    );
  }
  async onStop(): Promise<void> {
    await this.orm.close(true);
  }
  static provide(): DynamicModule {
    return {
      module: DbModule,
      imports: [ClsModule],
      // entityManagerProvider est réutilisé tel quel — il expose `orm.em` sous le token EntityManager.
      providers: [ormProvider, entityManagerProvider],
      exports: [MikroORM, EntityManager],
    };
  }
}
```

Importez `DbModule.provide()` dans votre `AppModule`, et câblez `new TransactionInterceptor(orm, cls)`
dans la factory `interceptors` du transport exactement comme le `MikroOrmInterceptor` clé en main
ci-dessus. Le module est le chemin pratique ; cette factory est l'échappatoire et la transparence —
rien de `configure()` n'est caché.

## Limitations

- **Aucune atomicité cross-base.** Les connexions multiples sont supportées (voir _Connexions
  multiples_), mais une requête écrit **au plus une** connexion sauf si vous activez `multiWrite` — et
  même là les écritures sont séquentielles best-effort, pas atomiques (MikroORM n'a pas de commit à deux
  phases). Passez par un pattern saga / outbox quand il vous faut une vraie transaction cross-base.
- **Épinglez `@mikro-orm/core` et son driver sur le même major.** La résolution des repositories repose
  sur `instanceof EntityRepository` et une table de tokens par entité, toutes deux sensibles à
  l'identité. Une copie **dupliquée** de `@mikro-orm/core` dans l'arbre (un driver sur un autre major,
  un écart de version) crée une seconde classe `EntityRepository` et casse `register([...])`. Gardez
  `@mikro-orm/core` et le driver `@mikro-orm/*` sur un seul major (v6 aujourd'hui) — une seule copie
  dans l'arbre de dépendances.
- **L'interceptor exige une portée CLS active.** Enregistrez `MikroOrmInterceptor` **après**
  `ClsInterceptor` (voir _Câbler l'interceptor transactionnel_ plus haut). Hors d'une portée, il échoue
  immédiatement avec un diagnostic explicite nommant le correctif, plutôt qu'une erreur opaque.

## Référence

### `MikroOrmModule.configure(options)`

Enregistre une connexion : construit `MikroORM` au build du module, connecte sur `onStart` (avec
retry), ferme sur `onStop`. Sans `name` c'est la connexion **par défaut** (tokens classe `MikroORM` /
`EntityManager`) ; avec un `name` c'est une connexion additionnelle (`mikroOrmRef(name)` etc.) avec son
propre cycle de vie (voir _Connexions multiples_). `options` est le `Options` de MikroORM (tout —
`driver`, `dbName`, `entities`, `pool`, `logger`, `debug`, …) plus des champs ajoutés par spine :

| Option       | Type                   | Défaut          | Signification                                                                                |
| ------------ | ---------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `retry`      | `Partial<RetryPolicy>` | `DEFAULT_RETRY` | Politique de retry au démarrage (ci-dessous).                                                |
| `name`       | `string`               | _(par défaut)_  | Enregistre une connexion nommée, injectée via `mikroOrmRef(name)` / `entityManagerRef`.      |
| `multiWrite` | `boolean`              | `false`         | Autorise l'écriture de cette connexion aux côtés d'une autre dans une requête (best-effort). |
| _(reste)_    | `Options` MikroORM     | —               | Driver, `dbName`, `entities`, pool, logs.                                                    |

`RetryPolicy` et ses défauts (`DEFAULT_RETRY`) :

| Champ      | Type     | Défaut | Signification                                                         |
| ---------- | -------- | ------ | --------------------------------------------------------------------- |
| `attempts` | `number` | `5`    | Nombre total de tentatives, la première incluse (`>= 1`).             |
| `delayMs`  | `number` | `200`  | Délai avant le premier retry, en ms.                                  |
| `backoff`  | `number` | `2`    | Multiplicateur appliqué au délai après chaque échec (`1` = constant). |

Tout champ omis de `retry` retombe sur sa valeur `DEFAULT_RETRY`.

### `MikroOrmModule.register([...])`

Expose les repositories d'un module, chacun injectable par token. Chaque entrée est soit :

- une **classe de repository personnalisée** (une sous-classe d'`EntityRepository<Entity>`) — injectée
  par son token de classe ; l'entité est relue depuis le lien `repository: () => …` du schéma, qui
  **doit** donc le déclarer ; soit
- une **classe d'entité** — expose l'`EntityRepository<Entity>` par défaut sous `repositoryOf(Entity)`.

Appelez-le dans chaque module de feature qui a besoin d'accéder aux données. Passez `{ connection }`
(le second argument) pour lier les repositories à une connexion **nommée** ; omis, ils se lient à la
connexion par défaut.

### `repositoryOf(entity, connection?)`

Retourne un `InjectionToken<EntityRepository<E>>` stable et typé pour une entité qui n'a pas besoin de
classe de repository personnalisée. `repositoryOf(User) === repositoryOf(User)` — le même token le
fournit et l'injecte. À combiner avec `register([User])`. `connection` namespace le token par nom de
connexion (l'identité est `(entity, connection)`) ; omis (ou `"default"`) donne le token de la
connexion par défaut.

### `MikroOrmInterceptor`

L'interceptor d'unité de travail par requête. Fork un `EntityManager` neuf dans la portée CLS et le
`flush()` une fois à la fin, uniquement sur une enveloppe réussie (pas de `begin()` en amont ; une
requête sans écriture n'ouvre aucune transaction). Enregistrez-le dans le `configure({ interceptors })`
du transport **après** `ClsInterceptor` — il doit s'exécuter à l'intérieur de la portée CLS. Il est
transport-agnostique : ajoutez-le au tableau `interceptors` **tel quel** — le slot est un
`ChainInterceptor` dont l'union admet un interceptor de base, donc aucun cast ni enveloppe n'est requis.

### Tokens de connexion nommée

`mikroOrmRef(name)`, `entityManagerRef(name)` et `mikroOrmInterceptorRef(name)` sont des tokens
d'injection stables et typés pour le `MikroORM`, l'`EntityManager` de requête et l'interceptor d'une
connexion nommée. Chacun mémoïse par nom — `mikroOrmRef("audit") === mikroOrmRef("audit")` — donc un
provider et un site `inject:` partagent l'identité. `mikroOrmRef("default")` (le `DEFAULT_CONNECTION`
exporté) résout la même instance que le token classe `MikroORM`.

### Ré-exports et briques de la factory

Le package ré-exporte les primitives MikroORM dont vous avez besoin, pour que les entités et
l'injection dépendent de `@spinejs/mikro-orm` seul : **`MikroORM`**, **`EntityManager`**,
**`EntitySchema`**, **`EntityRepository`**, et le type **`Options`**. Pour le câblage à la main il
exporte aussi **`mikroOrmProvider`**, **`entityManagerProvider`** et **`connectWithRetry`** (voir
[Le câblage à la main](#by-hand)), plus **`DEFAULT_RETRY`** et **`DEFAULT_CONNECTION`**.
