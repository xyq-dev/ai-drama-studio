/**
 * M1-A keeps the domain package buildable without modeling production entities.
 * Job state, review, and STALE rules are intentionally absent.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
