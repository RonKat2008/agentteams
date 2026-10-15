import { z } from 'zod';

export type ErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new DomainError('invalid', z.prettifyError(result.error));
  return result.data;
}
