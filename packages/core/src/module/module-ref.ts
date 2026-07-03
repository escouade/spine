import { Container, Token } from "../container";
import { Logger } from "../logger";
import { ModuleNode } from "./module-node";

export class ModuleRef {
  readonly container: Container;
  readonly imports: ModuleRef[] = [];
  readonly exports = new Set<Token>();
  instance!: object;

  constructor(
    logger: Logger,
    readonly node: ModuleNode,
    globalContainer: Container
  ) {
    this.container = new Container(
      logger,
      `Container.${this.node.module.name}`,
      globalContainer
    );
  }

  resolve<T>(token: Token<T>): T {
    return this.container.get<T>(token);
  }
}
