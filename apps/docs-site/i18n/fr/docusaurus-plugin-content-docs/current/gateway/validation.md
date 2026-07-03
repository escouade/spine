---
sidebar_position: 4
---

# Validation

Vous validez l'input d'un handler en attachant un schéma à une route. Le pipeline l'exécute avant votre handler, et l'`input` du callback est **inféré** depuis ce schéma — une seule source de vérité, vérifiée à la compilation et à l'exécution. En interne cela passe par un port `Validator` pluggable (voir [comment ça marche](#comment-ça-marche) plus bas), mais au quotidien vous ne touchez qu'aux schémas.

## Utiliser des schémas dans les routes

Passez un schéma dans les options de route (`{ input }` pour IPC, `{ params }`/`{ query }`/`{ body }` pour HTTP). Si la validation échoue, le handler n'est **jamais appelé** — la réponse est une enveloppe d'erreur.

```typescript
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

@Controller({ inject: [AuthService] })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // `input` est inféré comme { email: string; password: string } et déjà validé.
  login = handle("auth:login", { input: loginSchema }, (input) =>
    this.authService.login(input.email, input.password)
  );
}
```

Si l'appelant envoie `{ email: 'not-an-email', password: '123' }`, le handler n'est jamais appelé. La réponse est `{ ok: false, code: 'INVALID_INPUT' }` (le code que votre `ErrorMapper` assigne à une `ValidationError`).

## Routes sans schéma

Omettez le schéma et l'input brut du transport passe tel quel :

```typescript
ping = handle("ping", {}, () => "pong");
```

Parfait pour les routes qui ne prennent aucune entrée, ou quand vous voulez gérer l'input brut vous-même.

## Comment ça marche

La validation passe par le port `Validator`, si bien que le cœur de la gateway ne porte aucune dépendance à l'exécution envers une bibliothèque de validation — vous câblez l'adaptateur de votre choix (zod, joi, class-validator…) au niveau de la couche de transport.

### Le port `Validator`

```typescript
interface Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T;
}
```

- **`schema`** — tout objet doté d'une méthode `parse(input: unknown): T` (le type structurel `ParseableSchema<T>`).
- **`input`** — l'input brut du transport.

Elle retourne le `T` parsé et typé en cas de succès, ou **lève `ValidationError`** en cas d'échec.

### `ParseableSchema<T>`

```typescript
interface ParseableSchema<T> {
  parse(input: unknown): T;
}
```

Toute bibliothèque de schéma exposant une méthode `parse` satisfait cette interface structurelle — notamment **zod**. Parce qu'elle est structurelle (duck typing), vos controllers importent directement les schémas zod tandis que la bibliothèque gateway ne dépend jamais de zod.

### L'adaptateur Zod

Le `ZodValidator` de référence normalise une `ZodError` en `ValidationError` :

```typescript
import { ZodError } from "zod";
import {
  ParseableSchema,
  ValidationError,
  Validator,
} from "@spinejs/gateway-core";

export class ZodValidator implements Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
          )
          .join("; ");
        throw new ValidationError(detail);
      }
      throw err;
    }
  }
}
```

Le pipeline de la gateway rattrape la `ValidationError` et l'`ErrorMapper` la convertit vers le code d'erreur du transport (par ex. `'INVALID_INPUT'`).

### Câbler le validateur

Le validateur est injecté dans la gateway via un factory provider dans le module de transport. `HttpGatewayModule` et `ElectronIpcGatewayModule` utilisent tous deux `ZodValidator` par défaut, vous ne le câblez donc à la main que si vous construisez la gateway vous-même :

```typescript
import { InjectionToken, Module } from "@spinejs/core";
import { Validator } from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ZodValidator } from "./zod.validator";

const validatorToken = new InjectionToken<Validator>("validator");

@Module({
  providers: [
    { provide: validatorToken, factory: () => new ZodValidator() },
    {
      provide: ElectronIpcGateway,
      inject: [validatorToken /* errorMapper, contextFactory, logger */],
      factory: (validator, errorMapper, contextFactory, logger) =>
        new ElectronIpcGateway(validator, errorMapper, contextFactory, logger),
    },
  ],
  exports: [ElectronIpcGateway],
})
export class ElectronIpcGatewayModule {}
```

## `ValidationError`

`ValidationError` est ré-exportée depuis `@spinejs/gateway-core`. Importez-la dans votre implémentation de `Validator` et dans votre `ErrorMapper` :

```typescript
import { ValidationError } from "@spinejs/gateway-core";

// Dans ErrorMapper.toCode() :
if (err instanceof ValidationError) return "INVALID_INPUT";
```

Le message porté par `ValidationError` n'est pas transmis au consommateur du transport (l'`ErrorMapper` ne retourne que la chaîne de code). Journalisez-le côté serveur si vous avez besoin du détail.
