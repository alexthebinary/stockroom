/** Error the API layer knows how to turn into a clean JSON response. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, details);
export const notFound = (message: string) => new ApiError(404, message);
/** A 409 may carry `details` so the UI can offer the way out it names. */
export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, message, details);
