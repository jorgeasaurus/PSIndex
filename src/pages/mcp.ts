import type { APIRoute } from 'astro';
import { handleMcp } from '../server/mcp';

export const prerender = false;

// The rest of the site is static. This route is the one Vercel function.
const route: APIRoute = ({ request }) => handleMcp(request);
export const GET = route;
export const POST = route;
export const DELETE = route;
export const OPTIONS = route;
