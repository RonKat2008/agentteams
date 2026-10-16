import { createVercelHandler } from '@agentteams/hub/vercel';

const handler = createVercelHandler();

export const config = { runtime: 'nodejs' };
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
