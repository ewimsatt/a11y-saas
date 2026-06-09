import { ZodError } from 'zod';

/** Human-readable message for request validation/runtime errors (no stack leakage). */
export function errorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((i) => i.message).join('; ') || 'Invalid input';
  }
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}

export function isValidationError(e: unknown): boolean {
  return e instanceof ZodError;
}
