import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ConflictError } from "../db/kitRepository.js";
import { KitOpError } from "../domain/kitOps.js";

/** Every API error reaches the client as { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  let apiError: ApiError;
  if (err instanceof ApiError) apiError = err;
  else if (err instanceof ZodError) {
    apiError = new ApiError(400, "VALIDATION_FAILED", "Some fields are invalid.", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  } else if (err instanceof KitOpError) apiError = new ApiError(422, "INVALID_EDIT", err.message);
  else if (err instanceof ConflictError) apiError = new ApiError(409, "CONFLICT", err.message);
  else if ((err as { type?: string })?.type === "entity.too.large") apiError = new ApiError(413, "TOO_LARGE", "Request body is too large.");
  else if ((err as { type?: string })?.type === "entity.parse.failed") apiError = new ApiError(400, "BAD_JSON", "Request body is not valid JSON.");
  else {
    console.error(err);
    apiError = new ApiError(500, "INTERNAL_ERROR", "Something went wrong on our side. Please try again.");
  }
  res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message, ...(apiError.details ? { details: apiError.details } : {}) } });
}
