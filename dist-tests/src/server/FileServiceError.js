import { XError } from "@xpell/core";
export class FileServiceError extends XError {
    constructor(code, message, meta = {}) {
        super(code, message, {
            _level: code === "E_INTERNAL" ? "error" : "warn",
            _meta: meta
        });
    }
}
