// @ts-nocheck
import { z } from 'zod';

export const RequestSchema = z.object({
  id: z.string(),
  command: z.string(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export type Request = z.infer<typeof RequestSchema>;

export const SuccessResponseSchema = z.object({
  id: z.string(),
  status: z.literal('success'),
  result: z.unknown(),
});

export const ErrorResponseSchema = z.object({
  id: z.string(),
  status: z.literal('error'),
  error: z.object({
    code: z.string(),
    message: z.string(),
    // SEE-1356 batch-2 ride-along (Atlas-ruled): optional failure-classification
    // field (e.g. CAPTURE_FAILED detail: empty_viewport / unsupported_format /
    // empty_buffer_after_convert). Optional, so pre-batch-2 addons validate
    // unchanged; the field is kept (not stripped) so the code+message surface
    // can render it end-to-end.
    detail: z.string().optional(),
  }),
});

export const ResponseSchema = z.union([SuccessResponseSchema, ErrorResponseSchema]);

export type Response = z.infer<typeof ResponseSchema>;
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function createRequest(command: string, params: Record<string, unknown> = {}): Request {
  return {
    id: crypto.randomUUID(),
    command,
    params,
  };
}

export function isSuccessResponse(response: Response): response is SuccessResponse {
  return response.status === 'success';
}

export function isErrorResponse(response: Response): response is ErrorResponse {
  return response.status === 'error';
}
