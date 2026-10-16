/** Strips Postgres connection strings (which carry credentials) from text bound for logs or error responses. */
export const redact = (message: string): string => message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***');
