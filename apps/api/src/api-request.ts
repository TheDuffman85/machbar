import type { FastifyRequest } from 'fastify';

export function isApiRequest(request: FastifyRequest): boolean {
  // Use the matched route as well as the request path: the router accepts
  // encoded paths and absolute request URLs, which must share API protections.
  if (request.routeOptions.url?.startsWith('/api/')) return true;
  try {
    const path = decodeURI(new URL(request.url, 'http://localhost').pathname);
    return path === '/api' || path.startsWith('/api/');
  } catch {
    return false;
  }
}
