import path from "node:path";
import { DEFAULT_MAX_IMAGE_BYTES, XPELL_FILE_REF_TYPE, XPELL_FILE_REF_VERSION, XPELL_FILE_MIME_TYPES_V1 } from "../shared/contract.js";
import { FileServiceError } from "./FileServiceError.js";
const FILE_ID_PATTERN = /^file_[a-f0-9]{32}$/;
export function normalize_scope_segment(value, field) {
    if (typeof value !== "string") {
        throw new FileServiceError("E_INVALID_PARAMS", `${field} must be a non-empty string`, { [field]: value });
    }
    const normalized = value.normalize("NFKC").trim();
    if (!normalized || normalized.startsWith("$")) {
        throw new FileServiceError("E_INVALID_PARAMS", `${field} must be a non-empty string`, { [field]: value });
    }
    return normalized;
}
export function normalize_env(value) {
    return normalize_scope_segment(value, "_env").toLowerCase();
}
export function normalize_scope(value) {
    const scope = String(value ?? "").normalize("NFKC").trim().toLowerCase();
    if (scope === "temp" || scope === "app")
        return scope;
    throw new FileServiceError("E_INVALID_PARAMS", "Unsupported file scope", { _scope: value });
}
export function normalize_scope_context(input) {
    return {
        _app_id: normalize_scope_segment(input._app_id, "_app_id"),
        _env: normalize_env(input._env)
    };
}
export function encode_scope_segment(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
export function sanitize_filename(value) {
    const raw = typeof value === "string" ? value : "file";
    const without_separators = raw.replaceAll("\\", "/");
    const base = path.basename(without_separators).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    const safe = base.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").slice(0, 160).trim();
    return safe || "file";
}
export function assert_file_id(id) {
    if (typeof id !== "string" || !FILE_ID_PATTERN.test(id)) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Invalid file ref id", { _id: id });
    }
    return id;
}
export function normalize_mime_type(value) {
    const mime = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
    if (XPELL_FILE_MIME_TYPES_V1.includes(mime)) {
        return mime;
    }
    throw new FileServiceError("E_UNSUPPORTED_MIME_TYPE", "Unsupported file MIME type", { _mime_type: value });
}
export function allowed_extensions_for_mime(mime_type) {
    if (mime_type === "image/jpeg")
        return [".jpg", ".jpeg"];
    if (mime_type === "image/png")
        return [".png"];
    if (mime_type === "image/webp")
        return [".webp"];
    if (mime_type === "application/pdf")
        return [".pdf"];
    if (mime_type === "text/csv" || mime_type === "application/csv" || mime_type === "application/vnd.ms-excel")
        return [".csv"];
    return [];
}
export function validate_filename_for_mime(filename, mime_type) {
    const ext = path.extname(filename).toLowerCase();
    const allowed = allowed_extensions_for_mime(mime_type);
    if (!allowed.includes(ext)) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_EXTENSION", "File extension does not match declared MIME type", {
            _filename: filename,
            _mime_type: mime_type,
            _allowed_extensions: allowed
        });
    }
}
export function validate_file_bytes(bytes, mime_type, max_bytes = DEFAULT_MAX_IMAGE_BYTES) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new FileServiceError("E_FILE_INVALID_BYTES", "File bytes are required");
    }
    if (bytes.length > max_bytes) {
        throw new FileServiceError("E_FILE_TOO_LARGE", "File exceeds maximum allowed size", {
            _size_bytes: bytes.length,
            _max_size_bytes: max_bytes
        });
    }
    if (mime_type === "application/pdf") {
        if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF")
            return;
        throw new FileServiceError("E_FILE_INVALID_BYTES", "File bytes do not match declared MIME type", {
            _mime_type: mime_type
        });
    }
    if (mime_type === "text/csv" || mime_type === "application/csv" || mime_type === "application/vnd.ms-excel") {
        validate_csv_bytes(bytes, mime_type);
        return;
    }
    if (mime_type === "image/jpeg") {
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
            return;
    }
    else if (mime_type === "image/png") {
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        if (bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature))
            return;
    }
    else if (mime_type === "image/webp") {
        if (bytes.length >= 12 &&
            bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP") {
            return;
        }
    }
    throw new FileServiceError("E_FILE_INVALID_BYTES", "File bytes do not match declared MIME type", {
        _mime_type: mime_type
    });
}
export function validate_image_bytes(bytes, mime_type, max_bytes = DEFAULT_MAX_IMAGE_BYTES) {
    validate_file_bytes(bytes, mime_type, max_bytes);
}
function validate_csv_bytes(bytes, mime_type) {
    const normalized_bytes = bytes.includes(0x00)
        ? normalized_legacy_csv_padding_bytes(bytes, mime_type)
        : bytes;
    const head = normalized_bytes.subarray(0, Math.min(normalized_bytes.length, 64)).toString("latin1").trimStart().toLowerCase();
    if (head.startsWith("mz") ||
        head.startsWith("#!") ||
        head.startsWith("<script") ||
        head.startsWith("<?php") ||
        head.startsWith("pk\u0003\u0004") ||
        head.startsWith("%pdf")) {
        throw new FileServiceError("E_FILE_INVALID_BYTES", "CSV upload bytes do not match declared MIME type", {
            _mime_type: mime_type
        });
    }
    for (const byte of normalized_bytes) {
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            throw new FileServiceError("E_FILE_INVALID_BYTES", "CSV upload contains unsupported control bytes", {
                _mime_type: mime_type
            });
        }
    }
}
function normalized_legacy_csv_padding_bytes(bytes, mime_type) {
    const nul_runs = csv_nul_runs(bytes);
    const nul_count = nul_runs.reduce((sum, run) => sum + run.length, 0);
    const csv_like_ratio = (bytes.length - nul_count) / bytes.length;
    if (nul_runs.length === 0)
        return bytes;
    const allowed = csv_like_ratio >= 0.95 && nul_runs.every((run) => {
        const prev = bytes[run.start - 1];
        const next = bytes[run.start + run.length];
        const next2 = bytes[run.start + run.length + 1];
        const after_delimiter = prev === 0x2c || prev === 0x3b;
        const before_newline = next === 0x0a || (next === 0x0d && next2 === 0x0a);
        return run.length === 10 && after_delimiter && before_newline;
    });
    if (!allowed) {
        throw new FileServiceError("E_FILE_INVALID_BYTES", "CSV upload contains binary null bytes", {
            _mime_type: mime_type,
            _nul_count: nul_count
        });
    }
    const normalized = Buffer.from(bytes.filter((byte) => byte !== 0x00));
    const text = normalized.toString("utf8");
    const replacement_count = (text.match(/\uFFFD/gu) ?? []).length;
    const first_line = text.split(/\r?\n/u).find((line) => line.trim()) ?? "";
    const delimiter_count = Math.max(count_unquoted(first_line, ","), count_unquoted(first_line, ";"));
    const line_count = text.split(/\r?\n/u).filter((line) => line.trim()).length;
    if (replacement_count > 0 || delimiter_count < 2 || line_count < 2) {
        throw new FileServiceError("E_FILE_INVALID_BYTES", "CSV upload contains invalid legacy CSV padding", {
            _mime_type: mime_type,
            _nul_count: nul_count
        });
    }
    return normalized;
}
function csv_nul_runs(bytes) {
    const runs = [];
    for (let index = 0; index < bytes.length;) {
        if (bytes[index] !== 0x00) {
            index += 1;
            continue;
        }
        const start = index;
        while (index < bytes.length && bytes[index] === 0x00)
            index += 1;
        runs.push({ start, length: index - start });
    }
    return runs;
}
function count_unquoted(line, delimiter) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const ch = line[index];
        if (ch === "\"")
            quoted = !quoted;
        else if (!quoted && ch === delimiter)
            count += 1;
    }
    return count;
}
export function assert_file_ref(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "file_ref must be an object");
    }
    const raw = value;
    if (raw._type !== XPELL_FILE_REF_TYPE || raw._version !== XPELL_FILE_REF_VERSION) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Unsupported file ref type or version", {
            _type: raw._type,
            _version: raw._version
        });
    }
    const scope = normalize_scope(raw._scope);
    const context = normalize_scope_context({ _app_id: raw._app_id, _env: raw._env });
    const id = assert_file_id(raw._id);
    const filename = sanitize_filename(raw._filename);
    const mime_type = normalize_mime_type(raw._mime_type);
    validate_filename_for_mime(filename, mime_type);
    if (typeof raw._size_bytes !== "number" || !Number.isSafeInteger(raw._size_bytes) || raw._size_bytes < 0) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Invalid file ref size", {
            _size_bytes: raw._size_bytes
        });
    }
    if (typeof raw._created_at !== "string" || Number.isNaN(Date.parse(raw._created_at))) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Invalid file ref creation timestamp", {
            _created_at: raw._created_at
        });
    }
    if (raw._expires_at !== undefined && (typeof raw._expires_at !== "string" || Number.isNaN(Date.parse(raw._expires_at)))) {
        throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Invalid file ref expiry timestamp", {
            _expires_at: raw._expires_at
        });
    }
    return {
        _type: XPELL_FILE_REF_TYPE,
        _version: XPELL_FILE_REF_VERSION,
        _id: id,
        _scope: scope,
        _app_id: context._app_id,
        _env: context._env,
        _filename: filename,
        _mime_type: mime_type,
        _size_bytes: raw._size_bytes,
        ...(typeof raw._sha256 === "string" && raw._sha256 ? { _sha256: raw._sha256 } : {}),
        _created_at: raw._created_at,
        ...(typeof raw._expires_at === "string" ? { _expires_at: raw._expires_at } : {})
    };
}
export function assert_scope_matches_ref(ref, context) {
    if (ref._app_id !== context._app_id || ref._env !== context._env) {
        throw new FileServiceError("E_PERMISSION_DENIED", "File ref does not belong to the requested app/env scope", {
            _ref_app_id: ref._app_id,
            _ref_env: ref._env,
            _app_id: context._app_id,
            _env: context._env
        });
    }
}
