---
sidebar_position: 4
---

# Scheduler (tâches périodiques)

`@spinejs/scheduler` exécute des **tâches de fond périodiques**. Chaque tick s'exécute dans sa propre
portée [CLS](./cls) — une _requête synthétique_ — pour que les services d'une tâche résolvent un état
scopé à la requête (comme un UnitOfWork MikroORM par tick) exactement comme le fait un handler HTTP,
**sans faire circuler de manager**. Cette symétrie est toute la raison d'ordonnancer le travail _dans_
SpineJS.

## Enregistrer une tâche

Enregistrez les tâches à la configuration du module. Une tâche déclare sa fréquence, ce qu'elle injecte,
et le travail à faire. Les modules qui **exportent** les tokens injectés arrivent via `imports` :

```typescript
// app.module.ts
import { Module } from "@spinejs/core";
import { SchedulerModule } from "@spinejs/scheduler";
import { mikroOrmUnitOfWork } from "@spinejs/mikro-orm"; // UnitOfWork par tick (un hook `around`)
import { JobsModule } from "./jobs.module";
import { Projector } from "./projector";
import { Leases } from "./leases";

@Module({
  imports: [
    SchedulerModule.configure({
      imports: [JobsModule], // exporte Projector, Leases
      tasks: [
        {
          name: "outbox-projector",
          everyMs: 2_000,
          inject: [Projector],
          run: (p: Projector) => p.pollAndCreateJobs(),
          around: [mikroOrmUnitOfWork], // tick = UnitOfWork scopé à la requête
        },
        {
          name: "lease-sweep",
          everyMs: 5_000,
          inject: [Leases],
          run: (l: Leases) => l.requeueExpired(),
          around: [mikroOrmUnitOfWork],
        },
      ],
    }),
  ],
})
export class AppModule {}
```

Le service de la tâche lit et écrit à travers l'`EntityManager` scopé à la requête — sans faire circuler
de manager, sans `.save()` explicite, identique à un handler HTTP :

```typescript
// projector.ts
import { EntityManager } from "@mikro-orm/core";

export class Projector {
  static inject = [EntityManager] as const; // résout le fork de CE tick, via CLS
  constructor(private readonly em: EntityManager) {}

  async pollAndCreateJobs() {
    const events = await this.em.find(OutboxCursor, {});
    for (const e of events) this.em.create(Job, project(e)); // flushé quand le tick commit
  }
}
```

:::info `mikroOrmUnitOfWork` est fourni par `@spinejs/mikro-orm`
Le scheduler lui-même n'a **aucune** dépendance ORM. `mikroOrmUnitOfWork` est juste un hook `around`
fourni par la batterie ORM ; n'importe quel `around` (tracing, métriques, votre propre unit-of-work) se
compose de la même façon — voir [`around` personnalisé](#around-personnalisé) ci-dessous.
:::

## Faire

### Chevauchement (overlap)

Par défaut, un tick qui se déclenche pendant que le précédent tourne encore est **ignoré** — une boucle de
polling ne s'empile jamais. Utilisez `overlap: "queue"` pour sérialiser à la place (la file est bornée en
profondeur ; voir la référence) :

```typescript
{ name: "report", everyMs: 60_000, overlap: "queue", run: () => report() }
```

### Sans dépendances

Omettez `inject` (et `imports`) pour une tâche autonome :

```typescript
{ name: "heartbeat", everyMs: 10_000, run: () => console.log("alive") }
```

### `around` personnalisé

Un hook `around` enveloppe le run **à l'intérieur** de la portée CLS — composez tracing, métriques, ou
votre propre unit-of-work. Il prend la fonction suivante et renvoie la version enveloppée :

```typescript
import type { TickAround } from "@spinejs/scheduler";

const timed: TickAround = (next) => async () => {
  const start = performance.now();
  try {
    await next();
  } finally {
    console.log(`took ${performance.now() - start}ms`);
  }
};
```

### Initialiser la portée

`seed()` fournit le store CLS initial de la portée du tick — l'équivalent, pour un tick, du contexte
initialisé d'une requête HTTP :

```typescript
{ name: "audited", everyMs: 30_000, seed: () => ({ actor: "scheduler" }), run: () => … }
```

### Arrêt

À `onStop` le scheduler efface chaque timer et attend le tick en cours, pour qu'un projector en train de
tourner finisse son lot. Le [délai d'arrêt](../core/lifecycle) de l'app (défaut 5 s) est le garde-fou
ultime.

### Multi-instance

Le scheduler est volontairement naïf : `setInterval` tourne **par instance**. Si vous lancez plusieurs
réplicas, chaque réplica tick. La correction pour un travail partagé appartient à votre **schéma** (par
ex. un `dedup_key` unique + `SELECT … FOR UPDATE SKIP LOCKED`), **pas** à une élection de leader ici. Cela
garde la batterie petite et sans surface systèmes-distribués.

## Référence

`SchedulerModule.configure(options): DynamicModule`

| Option    | Type              | Notes                                                    |
| --------- | ----------------- | -------------------------------------------------------- |
| `tasks`   | `ScheduledTask[]` | Les tâches périodiques.                                  |
| `imports` | `ModuleEntry[]`   | Modules exportant les tokens utilisés dans les `inject`. |

`ScheduledTask`

| Champ     | Type                   | Défaut | Notes                                                |
| --------- | ---------------------- | ------ | ---------------------------------------------------- |
| `name`    | `string`               | —      | Unique ; sert au log et à la détection de doublons.  |
| `everyMs` | `number`               | —      | Délai fixe entre ticks (ms) ; doit être positif.     |
| `run`     | `(...deps) => unknown` | —      | Le travail ; reçoit les instances `inject` résolues. |
| `inject`  | `Token[]`              | `[]`   | Résolus par la DI, passés à `run` dans l'ordre.      |
| `overlap` | `"skip" \| "queue"`    | `skip` | Comportement quand un tick tourne encore.            |
| `seed`    | `() => ClsStore`       | `{}`   | Seed de la portée CLS de ce tick.                    |
| `around`  | `TickAround[]`         | `[]`   | Wrappers appliqués à l'intérieur de la portée CLS.   |

`TickAround` — `(next: () => Promise<void>) => () => Promise<void>`. Appliqué du plus externe au plus
interne.

**`overlap: "queue"`** sérialise les ticks ; la chaîne en attente est bornée (défaut `1000`). Une tâche
durablement plus lente que son intervalle jette des ticks (drop-oldest + un avertissement) plutôt que de
faire croître la mémoire.

Les expressions cron sont hors périmètre pour l'instant (intervalle seulement) — les cas projector /
sweep n'ont besoin que d'un intervalle simple. Le raisonnement de conception est consigné dans l'ADR 0018
(`docs/adr/0018-cls-scoped-scheduling.md`).
