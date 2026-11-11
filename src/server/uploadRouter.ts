import express from "express";
import type { Express, Router } from "express";
import { FileServiceError } from "./FileServiceError.js";
import type { FileServiceModule } from "./FileServiceModule.js";

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

type MultipartFilePart = {
  _filename: string;
  _mime_type: string;
  _bytes: Buffer;
};

export type FileServiceUploadRouterOptions = {
  _route_base_path?: string;
};

export function createFileServiceUploadRouter(
  file_service: FileServiceModule,
  options: FileServiceUploadRouterOptions = {}
): Router {
  const route_base_path = options._route_base_path ?? file_service._upload_route_base_path;
  const router = express.Router();

  router.post(`${route_base_path}/:upload_id`, async (req, res) => {
    try {
      const upload_id = readRouteParam(req.params.upload_id, "_upload_id");
      const token = readUploadToken(req);
      const slot = file_service.getUploadSlot(upload_id);
      if (!slot) {
        throw new FileServiceError("E_UPLOAD_SLOT_NOT_FOUND", "Upload slot not found", { _upload_id: upload_id });
      }

      const body = await readRequestBody(req, Math.min(slot._max_size_bytes, slot._size_bytes) + MULTIPART_OVERHEAD_BYTES);
      const part = parseMultipartFile(body, readContentType(req));
      const file_ref = await file_service.acceptMultipartUpload({
        _upload_id: upload_id,
        _token: token,
        _filename: part._filename,
        _mime_type: part._mime_type,
        _bytes: part._bytes
      });

      res
        .status(201)
        .setHeader("Cache-Control", "no-store")
        .json({
          _ok: true,
          _result: {
            file_ref
          }
        });
    } catch (error) {
      const normalized = normalizeUploadHttpError(error);
      res
        .status(normalized._status)
        .setHeader("Cache-Control", "no-store")
        .json({
          _ok: false,
          _result: {
            _code: normalized._code,
            _message: normalized._message,
            ...(normalized._details ? { _details: normalized._details } : {})
          }
        });
    }
  });

  return router;
}

export function mountFileServiceUploadRoutes(
  app: Express,
  file_service: FileServiceModule,
  options: FileServiceUploadRouterOptions = {}
) {
  app.use(createFileServiceUploadRouter(file_service, options));
}

function readRouteParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FileServiceError("E_INVALID_PARAMS", `${field} is required`);
  }
  return value.trim();
}

function readContentType(req: express.Request): string {
  const value = req.headers["content-type"];
  return typeof value === "string" ? value : "";
}

function readUploadToken(req: express.Request): string {
  const header = req.headers["x-xpell-upload-token"];
  const bearer = req.headers.authorization;
  const token =
    typeof header === "string" && header.trim()
      ? header.trim()
      : typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice(7).trim()
        : "";

  if (!token) {
    throw new FileServiceError("E_UPLOAD_AUTH_REQUIRED", "Upload token is required");
  }

  return token;
}

async function readRequestBody(req: express.Request, max_bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > max_bytes) {
      throw new FileServiceError("E_FILE_TOO_LARGE", "Multipart upload exceeds upload slot size", {
        _max_body_bytes: max_bytes
      });
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

function parseMultipartFile(bytes: Buffer, content_type: string): MultipartFilePart {
  const boundary_match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(content_type);
  const boundary = (boundary_match?.[1] ?? boundary_match?.[2] ?? "").trim();
  if (!content_type.toLowerCase().includes("multipart/form-data") || !boundary) {
    throw new FileServiceError("E_UPLOAD_INVALID_MULTIPART", "Expected multipart/form-data upload");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const delimiter_with_crlf = Buffer.from(`\r\n--${boundary}`);
  let cursor = bytes.indexOf(delimiter);
  if (cursor < 0) {
    throw new FileServiceError("E_UPLOAD_INVALID_MULTIPART", "Multipart boundary not found");
  }
  cursor += delimiter.length;

  while (cursor < bytes.length) {
    if (bytes.subarray(cursor, cursor + 2).toString("ascii") === "--") break;
    if (bytes.subarray(cursor, cursor + 2).toString("ascii") === "\r\n") cursor += 2;

    const header_end = bytes.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (header_end < 0) {
      throw new FileServiceError("E_UPLOAD_INVALID_MULTIPART", "Malformed multipart headers");
    }

    const headers = parseHeaders(bytes.subarray(cursor, header_end).toString("utf8"));
    const data_start = header_end + 4;
    const next_delimiter = bytes.indexOf(delimiter_with_crlf, data_start);
    const final_delimiter = bytes.indexOf(Buffer.from(`\r\n--${boundary}--`), data_start);
    const data_end = next_delimiter >= 0
      ? next_delimiter
      : final_delimiter >= 0
        ? final_delimiter
        : -1;
    if (data_end < 0) {
      throw new FileServiceError("E_UPLOAD_INVALID_MULTIPART", "Multipart closing boundary not found");
    }

    const disposition = headers["content-disposition"] ?? "";
    const name = readDispositionValue(disposition, "name");
    const filename = readDispositionValue(disposition, "filename");
    if ((name === "file" || filename) && filename) {
      return {
        _filename: filename,
        _mime_type: headers["content-type"] ?? "",
        _bytes: bytes.subarray(data_start, data_end)
      };
    }

    cursor = data_end + delimiter_with_crlf.length;
  }

  throw new FileServiceError("E_UPLOAD_INVALID_MULTIPART", "Multipart upload did not include a file part");
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function readDispositionValue(disposition: string, key: string): string {
  const pattern = new RegExp(`${key}="([^"]*)"`, "i");
  const quoted = pattern.exec(disposition);
  if (quoted) return quoted[1] ?? "";

  const unquoted = new RegExp(`${key}=([^;]+)`, "i").exec(disposition);
  return unquoted?.[1]?.trim() ?? "";
}

function normalizeUploadHttpError(error: unknown): {
  _status: number;
  _code: string;
  _message: string;
  _details?: Record<string, unknown>;
} {
  const code = typeof (error as any)?._code === "string" ? (error as any)._code : "E_INTERNAL";
  const message = error instanceof Error ? error.message : "Upload failed";
  const details = typeof (error as any)?._meta === "object" && (error as any)._meta !== null
    ? (error as any)._meta as Record<string, unknown>
    : undefined;

  const status =
    code === "E_UPLOAD_AUTH_REQUIRED" || code === "E_UPLOAD_TOKEN_INVALID" ? 401 :
      code === "E_PERMISSION_DENIED" ? 403 :
        code === "E_UPLOAD_SLOT_NOT_FOUND" || code === "E_NOT_FOUND" ? 404 :
          code === "E_UPLOAD_SLOT_EXPIRED" ? 410 :
            code === "E_FILE_TOO_LARGE" ? 413 :
              code === "E_INTERNAL" ? 500 :
                400;

  return {
    _status: status,
    _code: code,
    _message: message,
    ...(details ? { _details: details } : {})
  };
}
