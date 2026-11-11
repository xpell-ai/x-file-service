export const FILE_SERVICE_MODULE_ID = "file-service";
export const FILE_SERVICE_PACKAGE_NAME = "@xpell/file-service";
export const FILE_SERVICE_VERSION = "0.1.0";
export const XPELL_FILE_REF_TYPE = "xpell-file-ref";
export const XPELL_FILE_REF_VERSION = 1;
export const XPELL_FILE_SCOPES_V1 = ["temp", "app"];
export const XPELL_IMAGE_MIME_TYPES_V1 = [
    "image/jpeg",
    "image/png",
    "image/webp"
];
export const XPELL_FILE_MIME_TYPES_V1 = [
    ...XPELL_IMAGE_MIME_TYPES_V1,
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "application/pdf"
];
export const XPELL_FILE_EXTENSIONS_V1 = [
    ".csv",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp"
];
export const DEFAULT_TEMP_FILE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_UPLOAD_SLOT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_MAX_IMAGE_BYTES;
export const FILE_SERVICE_ERROR_CODES = [
    "E_INVALID_PARAMS",
    "E_NOT_READY",
    "E_PERMISSION_DENIED",
    "E_NOT_FOUND",
    "E_UNSUPPORTED_FILE_REF",
    "E_UNSUPPORTED_MIME_TYPE",
    "E_FILE_TOO_LARGE",
    "E_FILE_INVALID_BYTES",
    "E_UNSUPPORTED_FILE_EXTENSION",
    "E_FILE_EXPIRED",
    "E_UPLOAD_AUTH_REQUIRED",
    "E_UPLOAD_SLOT_NOT_FOUND",
    "E_UPLOAD_SLOT_EXPIRED",
    "E_UPLOAD_TOKEN_INVALID",
    "E_UPLOAD_INVALID_MULTIPART",
    "E_FILE_CLIENT_INVALID_FILE",
    "E_FILE_CLIENT_FILE_HANDLE_NOT_FOUND",
    "E_FILE_CLIENT_UNSUPPORTED_MIME",
    "E_FILE_CLIENT_CREATE_UPLOAD_FAILED",
    "E_FILE_CLIENT_NETWORK_FAILED",
    "E_FILE_CLIENT_MULTIPART_FAILED",
    "E_FILE_CLIENT_MALFORMED_RESPONSE",
    "E_INTERNAL"
];
