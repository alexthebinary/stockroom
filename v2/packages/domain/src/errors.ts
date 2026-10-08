/**
 * A business rule said no. The API maps `status` straight onto the HTTP
 * response, so the code that knows WHY something is refused also decides how
 * the refusal is reported: 400 for a request that can never succeed, 409 for
 * one that lost to a state change and is worth retrying or re-reading.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const refuse = (message: string) => new DomainError(message, 400);
export const conflict = (message: string) => new DomainError(message, 409);
