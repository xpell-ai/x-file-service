import { XError } from "@xpell/core";

export class FileServiceError extends XError {
  constructor(code: string, message: string, meta: Record<string, unknown> = {}) {
    super(code, message, {
      _level: code === "E_INTERNAL" ? "error" : "warn",
      _meta: meta
    });
  }
}
