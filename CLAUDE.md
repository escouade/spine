# SpineJS — Claude instructions

## After any implementation or fix

Run lint, typecheck, and tests before declaring done:

```bash
yarn lint:all
yarn typecheck:all
yarn test:all
```

Format if needed:

```bash
yarn format:write
```

## Flux git

`main` impose un historique linéaire : GitHub merge en **squash/rebase** et **réécrit les SHA** des commits. Conséquence : une branche réutilisée après un merge garde ses anciens commits (déjà sur `main` sous d'autres SHA) et toute nouvelle PR sur cette base part en conflit.

- **Une branche neuve par PR.** Nom unique à chaque fois (ex. `docs/xxx-2026-06-30`). Ne jamais recycler une branche déjà mergée.
- Ne jamais committer/pousser directement sur `main`, ni rejouer les commits d'une branche à la main (cherry-pick, refaire le travail) : intégrer **uniquement via merge de PR** (`gh pr merge <n> --squash`).
- Avant d'ouvrir ou mettre à jour une PR, rebaser sur `main` à jour : `git fetch origin && git rebase origin/main`, puis `git push --force-with-lease`.

## Docs

Toute modif de l'interface publique du framework (API, decorators, types exportés, options) ou tout ajout de feature doit être répercutée dans la doc Docusaurus, EN **et** FR (`apps/docs-site/docs/**/*.md` + `apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/**/*.md`, et `apps/docs-site/src/pages/index.tsx` + `apps/docs-site/i18n/fr/code.json` pour la home).

### Style de documentation pédagogique

Toute doc (pages Docusaurus **et** READMEs) suit le modèle **Diátaxis léger : apprendre → faire → référence**. Règle centrale : **montrer d'abord ce que l'utilisateur écrit, ensuite comment ça marche derrière.** Jamais l'inverse (pas de signature de classe / constructeur / zoo de types en ouverture).

Structure d'une page/section :

1. **Apprendre** — 1-2 phrases sur ce que fait la chose, puis un exemple minimal _runnable_ du code que l'utilisateur tape. Pour un guide de bout en bout, suivre l'**ordre naturel de développement** : `main.ts → app.module → controller → service` (point d'entrée d'abord, puis on descend vers les feuilles). Chaque bloc de code porte son chemin de fichier en commentaire (`// src/modules/user/user.controller.ts`) et l'arbo réelle est montrée quand il y a plusieurs fichiers.
2. **Faire** — les variantes et cas courants (options, personnalisation, wiring) après le cas nominal.
3. **Référence** — signatures de classes, constructeurs, tables de types/options **en bas**, sous un titre `## Reference` / `## Référence`.

Autres règles :

- Pyramide inversée : le contenu le plus utile en premier, les détails d'implémentation ensuite.
- Préférer l'exemple au paragraphe abstrait. Un port/une interface se montre via son usage avant sa définition.
- Pas de cadrage « process Node au long cours » / « long-lived » ; dire simplement « process Node ».
- Renvoyer vers `Getting Started` pour le parcours complet ; les autres pages restent la référence de leur sujet.
- Répercuter EN **et** FR (voir ci-dessus). Après édition : `cd apps/docs-site && yarn build` (valide liens/ancres) + `npx prettier --write` sur les fichiers touchés.
