---
sidebar_position: 1
---

# Introduction

**SpineJS** est un micro-framework léger, d'inspiration NestJS, pour structurer les process Node. Il apporte les patterns que vous connaissez de NestJS — modules, injection de dépendances, hooks de cycle de vie — sans le poids du runtime NestJS complet ni ses hypothèses centrées sur le HTTP.

Il fonctionne aussi bien dans des workers d'arrière-plan, des démons CLI, des services, ou tout programme Node qui dépasse un `index.ts` plat.

L'écosystème est organisé en couches que vous composez à la carte — voir l'[aperçu des packages](#aperçu-des-packages) ci-dessous.

## Pourquoi SpineJS ?

Les process Node grossissent vite. Ce qui commence comme un script plat a bientôt besoin d'un chargeur de config, de logging, de plusieurs services coopérants et d'un chemin d'arrêt propre. NestJS résout ces problèmes, mais il tire reflect-metadata, une stack HTTP complète et plusieurs centaines de kilo-octets de runtime dont vous n'avez peut-être pas besoin.

SpineJS répond aux mêmes questions d'architecture pour une fraction du poids :

- **Pas de reflect-metadata.** Les décorateurs stockent leurs métadonnées dans de simples symboles de propriété directe, sûrs sous esbuild/swc sans polyfill global.
- **Pas de verrouillage au transport.** L'abstraction `Gateway` sépare vos contrôleurs métier de la couche de transport qui achemine les données — IPC, HTTP, WebSocket, ou rien du tout.
- **Cycle de vie structuré.** Chaque module participe à `init → start → stop`. L'arrêt propre, la gestion des signaux et la propagation des erreurs sont pris en charge pour vous.

## Un aperçu

La plus petite app SpineJS est un module avec un hook de cycle de vie, démarré par `App` :

```typescript
import { App, Module, OnInit } from "@spinejs/core";

@Module({ inject: [] })
export class GreeterModule implements OnInit {
  async onInit() {
    console.log("Hello from GreeterModule");
  }
}

const app = new App([GreeterModule]);
await app.init();
await app.start();
```

`SIGINT`/`SIGTERM` sont gérés pour vous : `onStop()` s'exécute dans l'ordre d'init inverse, le logger vide ses tampons, puis le process se termine — vous n'appelez jamais `process.exit()` vous-même.

:::tip Prêt à construire quelque chose de réel ?
Le guide [**Prise en main**](getting-started) vous mène d'un dossier vide à une API HTTP en direct — service, controller, validation et serveur qui tourne — en cinq courtes étapes.
:::

## Concepts clés

| Concept          | Rôle                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Module**       | Unité structurelle déclarée avec `@Module({ inject: [...] })` ; participe au cycle de vie `init → start → stop`.                                              |
| **Conteneur DI** | Résout les dépendances de constructeur entre modules via des `InjectionToken` — pas de décorateurs partout, pas de reflect-metadata.                          |
| **`App`**        | Orchestre le graphe de modules : le construit, exécute les hooks de cycle de vie dans l'ordre, et gère les signaux du process.                                |
| **Gateway**      | Pipeline de requête optionnel et indépendant du transport (guards → validation → handler → enveloppe) pour les process qui doivent exposer une surface d'API. |

## Où aller ensuite

| Section                              | Couvre                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| [Prise en main](getting-started)     | Construire une API HTTP de bout en bout en cinq étapes   |
| [SpineJS Core](core/overview)        | `App`, modules, DI, cycle de vie, logger intégré         |
| [Gateway](gateway/overview)          | Contrôleurs, handlers, guards, validation, intercepteurs |
| [Extensions](extensions/config)      | Chargement de config typé, logger Winston                |
| [Electron](electron/electron-module) | Intégration du cycle de vie Electron et transport IPC    |

## Aperçu des packages

| Package                         | Rôle                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@spinejs/core`                 | Système de modules, conteneur DI, orchestrateur `App`, hooks de cycle de vie, logger intégré                                           |
| `@spinejs/gateway-core`         | Briques pour construire une gateway de transport : `DispatchPipeline`, ports, `@Controller`, routes en champ, `@UseGuards`, `Envelope` |
| `@spinejs/electron-ipc-gateway` | Transport IPC Electron — compose le pipeline sur `ipcMain.handle`                                                                      |
| `@spinejs/http-gateway`         | Transport HTTP sur Hono — compose le pipeline sur des routes HTTP                                                                      |
| `@spinejs/electron`             | `ElectronModule` (fenêtre + cycle de vie) et `WindowService`                                                                           |
| `@spinejs/config`               | Chargement de configuration typé et asynchrone                                                                                         |
| `@spinejs/winston-logger`       | Implémentation de `Logger` clé en main basée sur Winston                                                                               |
