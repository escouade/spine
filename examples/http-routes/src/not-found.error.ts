/** Thrown by a controller when a resource doesn't exist. Mapped to HTTP 404 by `AppErrorMapper`. */
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
