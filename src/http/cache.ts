import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

export type CacheControlPolicy = {
  scope?: 'public' | 'private';
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds?: number;
};

function serializeCacheControl(policy: CacheControlPolicy) {
  const directives = [
    policy.scope ?? 'public',
    `max-age=${Math.max(policy.maxAgeSeconds, 0)}`,
  ];

  if (policy.staleWhileRevalidateSeconds !== undefined) {
    directives.push(`stale-while-revalidate=${Math.max(policy.staleWhileRevalidateSeconds, 0)}`);
  }

  return directives.join(', ');
}

export function createJsonEtag(payload: unknown) {
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('base64url');

  return `W/"${hash}"`;
}

function requestMatchesEtag(request: FastifyRequest, etag: string) {
  const ifNoneMatch = request.headers['if-none-match'];

  if (typeof ifNoneMatch !== 'string') {
    return false;
  }

  return ifNoneMatch
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}

export function sendCacheableJson(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  policy: CacheControlPolicy,
) {
  const etag = createJsonEtag(payload);
  reply.header('cache-control', serializeCacheControl(policy));
  reply.header('etag', etag);

  if (requestMatchesEtag(request, etag)) {
    reply.code(304);
    return reply.send();
  }

  return reply.send(payload);
}
