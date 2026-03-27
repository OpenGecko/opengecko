import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) {
      return;
    }

    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.filter((segment) => segment !== undefined && segment !== null).join('.');
      const fieldLabel = path ? `${path} ` : '';
      const message = issue?.message
        ? `${fieldLabel}${issue.message}`.trim()
        : 'Invalid request parameters.';

      return reply.status(400).send({
        error: 'invalid_parameter',
        message,
      });
    }

    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }

    app.log.error(error);

    return reply.status(500).send({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
    });
  });
}
