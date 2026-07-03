---
sidebar_position: 1
---

# Aperçu Gateway

`@spinejs/gateway-core` fournit un pipeline de données entrantes indépendant du protocole, placé entre votre logique applicative et la couche de communication (IPC, HTTP, WebSocket, ou tout transport personnalisé). Il définit un contrat message/réponse cohérent, sans dépendre d'un runtime particulier.

## Ce que vous écrivez

Vous écrivez de simples controllers avec des champs de route typés — aucun détail de transport ne s'y infiltre :

```typescript
@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // Champ de route — get/post HTTP ici ; en IPC on déclare la même logique avec handle("channel", …).
  list = get("/users", {}, () => this.users.list());
}
```

La gateway prend chaque appel entrant et le fait passer par un pipeline fixe — enrichir le contexte → vérifier les guards → valider l'input → invoquer votre handler → emballer le résultat dans une enveloppe — puis rend l'enveloppe au transport. Vous déclarez le handler ; le pipeline fait le reste.

Nouveau ici ? Suivez le guide [Prise en main](../getting-started) pour une app HTTP exécutable, puis revenez pour les détails de conception ci-dessous.

:::info `@spinejs/gateway-core` fournit des briques, pas une classe de base
Ce package ne s'instancie ni ne s'étend pas directement. Il fournit les **briques** pour construire une gateway : le `DispatchPipeline` (guards → validation → invoke → enveloppe), les ports (`Validator`, `ContextFactory`, `ErrorMapper`), le loader de routes DI (`@Controller`, markers de routes en champ, `@UseGuards`) et le sucre feature-module. Une **gateway concrète** — `HttpGateway`, `ElectronIpcGateway` — compose ces briques et possède son propre bind/register. Voir l'ADR 0005 (`docs/adr/0005-gateway-composition-http-transport.md`).
:::

## Comment circule une requête

Une erreur fréquente est d'écrire des handlers de transport qui appellent directement les services applicatifs, dispersent la logique de guard dans chaque handler et passent des objets bruts propres au transport (un event IPC, une requête HTTP, un message socket) au code métier. La gateway élimine ce couplage en établissant un pipeline clair aux responsabilités explicites.

```
Appel de transport brut
  │
  ▼
ContextFactory.create(raw)        ← enrichit l'appel avec le contexte app (session, utilisateur, …)
  │
  ▼
Guards: canActivate(ctx)?         ← contrôles d'autorisation (résolus par DI, composables)
  │
  ▼
Validator.validate(schema, input) ← restriction de l'entrée (zod, ou tout schéma compatible parse())
  │
  ▼
Invocation du handler de route    ← votre route en champ du contrôleur, reçoit (input, ctx)
  │
  ▼
Envelope<T, Code>                 ← { ok: true, data } | { ok: false, code }
  │
  ▼
Le transport renvoie l'enveloppe
```

La méthode partagée `DispatchPipeline.dispatch()` implémente ce pipeline. Elle **ne lève jamais d'exception** : toute erreur — rejet de guard, échec de validation, exception de handler — est rattrapée et mappée vers un code d'erreur stable via `ErrorMapper`. L'appelant reçoit toujours une `Envelope`.

:::info Pourquoi une enveloppe, et non une exception levée ?
Les frontières de transport (IPC, HTTP) sérialisent mal les exceptions levées et laissent fuiter les stack traces. Retourner une `Envelope` discriminée garde le contrat explicite et la surface d'erreur stable pour chaque consommateur.
:::

## `Envelope<T, Code>`

Chaque handler retourne son résultat encapsulé dans une `Envelope` :

```typescript
type Envelope<T, Code extends string = string> =
  | { ok: true; data: T }
  | { ok: false; code: Code };
```

Côté renderer (ou tout consommateur du transport), vous discriminez sur `ok` :

```typescript
const result = await ipcRenderer.invoke("users:list");
if (result.ok) {
  console.log(result.data); // User[]
} else {
  console.error(result.code); // ex. 'UNAUTHORIZED', 'SERVER', 'INVALID_INPUT'
}
```

Les codes d'erreur sont des chaînes définies par l'application — le cœur de la gateway ne laisse jamais fuiter de messages d'erreur bruts ni de stack traces vers le consommateur du transport.

## Conception indépendante du transport

Le pipeline est un **helper composable**, pas une classe de base. `DispatchPipeline<Ctx, Code>` détient le cœur indépendant du transport (guards → validation → invoke → enveloppe) et la chaîne d'interceptors. Un transport **détient** un pipeline et appelle `dispatch()` depuis son propre écouteur :

```typescript
class HttpGateway<Ctx, Code> {
  private readonly pipeline = new DispatchPipeline<Ctx, Code>(
    validator,
    errorMapper,
    interceptors
  );

  register(routes: LoadedRoute<Ctx>[]) {
    for (const route of routes) this.bind(route); // attache un écouteur de transport par route
  }
}
```

Chaque transport gère l'extraction d'adresse, la construction du contexte et l'émission de l'enveloppe ; seul `dispatch()` est partagé. Les **services, guards et la structure** d'un controller se réutilisent tels quels d'un transport à l'autre — mais ses **routes sont spécifiques au transport** : HTTP utilise `get`/`post` par chemin avec une entrée `{ params, query, body }`, tandis que l'IPC Electron utilise `handle` par canal avec un payload unique. Vous redéclarez les routes dans le vocabulaire du transport cible ; la logique métier qu'elles appellent ne change pas.

## Ports

Trois interfaces définissent les points d'extension de la gateway. Votre module de transport fournit des implémentations concrètes :

| Port                       | Responsabilité                                                                  |
| -------------------------- | ------------------------------------------------------------------------------- |
| `ContextFactory<Raw, Ctx>` | Construit un contexte typé à partir des données d'appel brutes du transport.    |
| `Validator`                | Valide l'entrée brute contre un schéma ; lève `ValidationError` en cas d'échec. |
| `ErrorMapper<Code>`        | Mappe toute erreur levée vers une chaîne de code d'erreur stable.               |

Le module de transport câble ces implémentations dans la gateway via des factory providers DI. Le code des contrôleurs et des modules de fonctionnalité ne touche jamais directement aux ports.

## Types d'erreur

Deux classes d'erreur font partie de l'API publique de la gateway :

| Classe              | Quand la lever                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| `ValidationError`   | Levée par le `Validator` quand le parsing du schéma échoue.                 |
| `UnauthorizedError` | Levée par le pipeline quand le `canActivate()` d'un guard retourne `false`. |

Le code applicatif peut lever ses propres types d'erreur ; l'`ErrorMapper` les rattrape tous et les mappe vers des codes.
