/** Application error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in to continue') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'validation_failed', message, details);
