import { XError, XModule, XResponseError, XResponseOK, _xd } from "@xpell/core";
import { FILE_SERVICE_MODULE_ID, FILE_SERVICE_PACKAGE_NAME, FILE_SERVICE_VERSION, XPELL_FILE_MIME_TYPES_V1, XPELL_FILE_REF_TYPE, XPELL_FILE_REF_VERSION, XPELL_FILE_SCOPES_V1, XPELL_IMAGE_MIME_TYPES_V1 } from "../shared/contract.js";
export const FILE_CLIENT_MODULE_ID = "file-client";
export const FILE_CLIENT_OPS = {
    upload: {
        _id: "upload",
        _name: "upload",
        _scope: "app",
        _description: "Upload a browser-selected file through the canonical Xpell File Service and return an xpell-file-ref.",
        _params: {
            _app_id: "Owning app id.",
            _env: "Owning app environment.",
            _scope: "temp or app.",
            _file_handle: "Opaque browser-local file handle returned by file-client.registerFile(file).",
            _output: "Optional XData key to write the successful result."
        },
        _input_schema: {
            type: "object",
            required: ["_app_id", "_env", "_scope", "_file_handle"],
            properties: {
                _app_id: { type: "string" },
                _env: { type: "string" },
                _scope: { enum: XPELL_FILE_SCOPES_V1 },
                _file_handle: { type: "string" },
                _output: { type: "string" }
            }
        },
        _output_schema: {
            type: "object",
            required: ["file_ref"],
            properties: {
                file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
            }
        },
        _errors: [
            "E_FILE_CLIENT_INVALID_FILE",
            "E_FILE_CLIENT_FILE_HANDLE_NOT_FOUND",
            "E_FILE_CLIENT_UNSUPPORTED_MIME",
            "E_FILE_CLIENT_CREATE_UPLOAD_FAILED",
            "E_FILE_CLIENT_NETWORK_FAILED",
            "E_FILE_CLIENT_MULTIPART_FAILED",
            "E_FILE_CLIENT_MALFORMED_RESPONSE"
        ],
        _permissions: ["file_client:upload"],
        _examples: [
            {
                _module: FILE_CLIENT_MODULE_ID,
                _op: "upload",
                _params: {
                    _app_id: "pc-10",
                    _env: "default",
                    _scope: "temp",
                    _file_handle: "fileh_00000000000000000000000000000000"
                }
            }
        ],
        _side_effects: "create-upload-slot http-upload-file"
    }
};
export const FILE_CLIENT_SKILL = {
    _id: FILE_CLIENT_MODULE_ID,
    _title: "Xpell File Client",
    _version: FILE_SERVICE_VERSION,
    _active: true,
    _type: "client-module-api",
    _requires: ["xmodule", "wormholes", FILE_SERVICE_MODULE_ID],
    _package: FILE_SERVICE_PACKAGE_NAME,
    _runtime: {
        _target: "client",
        _hosts: ["xui"],
        _xpell_core: ">=2.0.0",
        _xpell_ui: ">=2.0.0"
    },
    _ops: FILE_CLIENT_OPS,
    _config: [],
    _secrets: [],
    _permissions: ["file_client:upload"],
    _readiness: {
        _status: "ready",
        _checks: ["send_xcmd", "fetch", "form_data"]
    },
    _description: "Browser-side File Service client that uploads selected files through file-service.create-upload and multipart HTTP.",
    _exports: {
        _modules: [
            {
                _name: FILE_CLIENT_MODULE_ID,
                _scope: "client",
                _description: "Browser-side upload orchestration for canonical xpell-file-ref V1.",
                _ops: Object.values(FILE_CLIENT_OPS)
            }
        ]
    },
    _capabilities: {
        _accepted_mime_types: XPELL_FILE_MIME_TYPES_V1,
        _accepted_image_mime_types: XPELL_IMAGE_MIME_TYPES_V1,
        _scopes: XPELL_FILE_SCOPES_V1,
        _output_type: XPELL_FILE_REF_TYPE,
        _server_dependency: FILE_SERVICE_MODULE_ID,
        _download_urls: false,
        _raw_bytes_in_x_execute: false
    },
    _core_rules: [
        "Use file-client to upload browser-selected files into canonical Xpell File Service storage.",
        "Use uploadFile(...) for direct browser File objects.",
        "Use _x.execute with _file_handle for a JSON-safe command surface.",
        "Do not put browser File objects, upload tokens, or raw bytes into server commands.",
        "Do not reconstruct upload routes; use the server returned upload URL as opaque."
    ],
    _canonical_examples: [
        {
            _module: FILE_CLIENT_MODULE_ID,
            _op: "upload",
            _params: {
                _app_id: "pc-10",
                _env: "default",
                _scope: "temp",
                _file_handle: "fileh_00000000000000000000000000000000"
            }
        }
    ]
};
class FileClientError extends XError {
    constructor(code, message, meta = {}) {
        super(code, message, {
            _level: "warn",
            _meta: meta
        });
    }
}
export class FileClientModule extends XModule {
    static _name = FILE_CLIENT_MODULE_ID;
    static _ops = FILE_CLIENT_OPS;
    static _skill = FILE_CLIENT_SKILL;
    send_xcmd;
    fetch_impl;
    resolve_upload_url;
    file_handles = new Map();
    upload_status = {
        _state: "idle",
        _updated_at: new Date(0).toISOString()
    };
    constructor(options) {
        super({ _name: FILE_CLIENT_MODULE_ID });
        this.send_xcmd = options._send_xcmd;
        this.fetch_impl = options._fetch ?? this.readGlobalFetch();
        this.resolve_upload_url = options._resolve_upload_url ?? ((url) => url);
    }
    get_readiness() {
        const has_fetch = typeof this.fetch_impl === "function";
        const has_form_data = typeof FormData !== "undefined";
        return {
            _ready: typeof this.send_xcmd === "function" && has_fetch && has_form_data,
            _status: typeof this.send_xcmd === "function" && has_fetch && has_form_data ? "ready" : "not_ready",
            _checks: {
                _send_xcmd: typeof this.send_xcmd === "function",
                _fetch: has_fetch,
                _form_data: has_form_data
            }
        };
    }
    registerFile(file) {
        const browser_file = this.readBrowserFile(file);
        const handle = `fileh_${this.randomId()}`;
        this.file_handles.set(handle, browser_file);
        return handle;
    }
    clearFileHandle(handle) {
        return this.file_handles.delete(handle);
    }
    getStatus() {
        return {
            ...this.upload_status,
            _error: this.upload_status._error ? { ...this.upload_status._error } : undefined
        };
    }
    async uploadFile(input) {
        const handle = this.registerFile(input._file);
        try {
            return await this._upload({
                _module: FILE_CLIENT_MODULE_ID,
                _op: "upload",
                _params: {
                    _app_id: input._app_id,
                    _env: input._env,
                    _scope: input._scope,
                    _file_handle: handle,
                    ...(input._output ? { _output: input._output } : {})
                }
            });
        }
        finally {
            this.clearFileHandle(handle);
        }
    }
    async _upload(xcmd) {
        try {
            const params = this.readParams(xcmd);
            if ("_file" in params) {
                throw new FileClientError("E_FILE_CLIENT_INVALID_FILE", "Browser File objects are not valid JSON command params. Use uploadFile(...) or registerFile(file) with _file_handle.");
            }
            const app_id = this.readString(params._app_id, "_app_id");
            const env = this.readString(params._env, "_env");
            const scope = this.readScope(params._scope);
            const file_handle = this.readString(params._file_handle, "_file_handle");
            const file = this.file_handles.get(file_handle);
            if (!file) {
                throw new FileClientError("E_FILE_CLIENT_FILE_HANDLE_NOT_FOUND", "File handle was not found", {
                    _file_handle: file_handle
                });
            }
            const filename = this.readString(file.name, "file.name");
            const mime_type = this.readMimeType(file.type, filename);
            const size_bytes = this.readSizeBytes(file.size);
            const upload = await this.createUpload({
                _app_id: app_id,
                _env: env,
                _scope: scope,
                _filename: filename,
                _mime_type: mime_type,
                _size_bytes: size_bytes
            });
            this.setStatus("uploading", {
                _file_handle: file_handle,
                _filename: filename,
                _mime_type: mime_type,
                _size_bytes: size_bytes
            });
            const file_ref = await this.postMultipart(upload, file);
            this.assertFileRef(file_ref);
            const result = { file_ref };
            const output_key = typeof params._output === "string" && params._output.trim()
                ? params._output.trim()
                : "";
            if (output_key) {
                _xd.set(output_key, result, { source: FILE_CLIENT_MODULE_ID });
            }
            this.setStatus("completed", {
                _file_handle: file_handle,
                _filename: filename,
                _mime_type: mime_type,
                _size_bytes: size_bytes
            });
            return new XResponseOK(result).toXData();
        }
        catch (error) {
            const normalized = this.normalizeError(error);
            this.setStatus("failed", {
                _error: {
                    _code: normalized._code,
                    _message: normalized._message
                }
            });
            return new XResponseError(new FileClientError(normalized._code, normalized._message, normalized._meta)).toXData();
        }
    }
    async createUpload(input) {
        let raw;
        try {
            raw = await this.send_xcmd({
                _module: FILE_SERVICE_MODULE_ID,
                _op: "create-upload",
                _params: {
                    _app_id: input._app_id,
                    _env: input._env,
                    _scope: input._scope,
                    _filename: input._filename,
                    _mime_type: input._mime_type,
                    _size_bytes: input._size_bytes
                }
            });
        }
        catch (error) {
            const normalized = this.normalizeError(error);
            throw new FileClientError("E_FILE_CLIENT_CREATE_UPLOAD_FAILED", normalized._message, {
                _server_error: normalized
            });
        }
        const payload = this.unwrapResponse(raw);
        const upload = payload?.upload;
        this.assertUploadSlot(upload);
        return upload;
    }
    async postMultipart(upload, file) {
        const form = new FormData();
        form.append(upload._field, file, file.name);
        let response;
        try {
            response = await this.fetch_impl(this.resolve_upload_url(upload._url), {
                _xpell_opaque_upload_url: true,
                method: upload._method,
                headers: {
                    "X-Xpell-Upload-Token": upload._headers["X-Xpell-Upload-Token"]
                },
                body: form,
                credentials: "same-origin"
            });
        }
        catch (error) {
            const normalized = this.normalizeError(error);
            throw new FileClientError("E_FILE_CLIENT_NETWORK_FAILED", normalized._message, {
                _cause: normalized
            });
        }
        let body;
        try {
            body = await response.json();
        }
        catch (error) {
            const fallback = typeof response.text === "function" ? await response.text().catch(() => "") : "";
            throw new FileClientError("E_FILE_CLIENT_MALFORMED_RESPONSE", "Upload response was not valid JSON", {
                _status: response.status,
                _response_text: fallback,
                _cause: this.normalizeError(error)
            });
        }
        if (!response.ok || body?._ok !== true) {
            const server_error = body?._result ?? body;
            throw new FileClientError("E_FILE_CLIENT_MULTIPART_FAILED", this.messageFromUnknown(server_error, "Multipart upload failed"), {
                _status: response.status,
                _server_error: server_error
            });
        }
        const file_ref = body?._result?.file_ref;
        this.assertFileRef(file_ref);
        return file_ref;
    }
    readGlobalFetch() {
        const fetch_impl = globalThis.fetch;
        if (typeof fetch_impl !== "function") {
            return async () => {
                throw new FileClientError("E_FILE_CLIENT_NETWORK_FAILED", "fetch is not available in this browser runtime");
            };
        }
        return fetch_impl.bind(globalThis);
    }
    readParams(xcmd) {
        const params = xcmd?._params;
        if (!params || typeof params !== "object" || Array.isArray(params)) {
            throw new FileClientError("E_INVALID_PARAMS", "Command _params must be an object");
        }
        return params;
    }
    readBrowserFile(file) {
        if (!file || typeof file !== "object") {
            throw new FileClientError("E_FILE_CLIENT_INVALID_FILE", "A browser File is required");
        }
        const candidate = file;
        if (typeof candidate.name !== "string" || !candidate.name.trim()) {
            throw new FileClientError("E_FILE_CLIENT_INVALID_FILE", "File name is required");
        }
        if (typeof file.arrayBuffer !== "function") {
            throw new FileClientError("E_FILE_CLIENT_INVALID_FILE", "A browser File or Blob-compatible object is required");
        }
        this.readSizeBytes(candidate.size);
        return file;
    }
    readString(value, field) {
        if (typeof value !== "string" || !value.trim()) {
            throw new FileClientError("E_INVALID_PARAMS", `${field} is required`);
        }
        return value.trim();
    }
    readScope(value) {
        if (value === "temp" || value === "app")
            return value;
        throw new FileClientError("E_INVALID_PARAMS", "_scope must be temp or app", {
            _scope: value
        });
    }
    readMimeType(value, filename) {
        const mime_type = typeof value === "string" ? value.toLowerCase().trim() : "";
        if (XPELL_FILE_MIME_TYPES_V1.includes(mime_type)) {
            return mime_type;
        }
        const inferred = this.inferMimeFromFilename(filename);
        if (!mime_type && inferred)
            return inferred;
        throw new FileClientError("E_FILE_CLIENT_UNSUPPORTED_MIME", "Unsupported file MIME type", {
            _mime_type: value,
            _accepted_mime_types: XPELL_FILE_MIME_TYPES_V1
        });
    }
    inferMimeFromFilename(filename) {
        const normalized = filename.toLowerCase().trim();
        if (normalized.endsWith(".csv"))
            return "text/csv";
        if (normalized.endsWith(".pdf"))
            return "application/pdf";
        if (normalized.endsWith(".png"))
            return "image/png";
        if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg"))
            return "image/jpeg";
        if (normalized.endsWith(".webp"))
            return "image/webp";
        return null;
    }
    readSizeBytes(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
            throw new FileClientError("E_FILE_CLIENT_INVALID_FILE", "File size must be a positive safe integer", {
                _size_bytes: value
            });
        }
        return value;
    }
    unwrapResponse(value) {
        if (value && typeof value === "object" && "_ok" in value) {
            const response = value;
            if (response._ok === false) {
                throw new FileClientError("E_FILE_CLIENT_CREATE_UPLOAD_FAILED", this.messageFromUnknown(response._result, "create-upload failed"), { _server_error: response._result });
            }
            if (response._ok === true)
                return response._result;
        }
        return value;
    }
    assertUploadSlot(value) {
        if (!value || typeof value !== "object") {
            throw new FileClientError("E_FILE_CLIENT_MALFORMED_RESPONSE", "create-upload did not return an upload descriptor");
        }
        const upload = value;
        const token = upload._headers?.["X-Xpell-Upload-Token"];
        if (upload._type !== "xpell-file-upload-slot" ||
            upload._version !== 1 ||
            typeof upload._upload_id !== "string" ||
            typeof upload._url !== "string" ||
            upload._method !== "POST" ||
            upload._field !== "file" ||
            typeof token !== "string" ||
            !token.trim()) {
            throw new FileClientError("E_FILE_CLIENT_MALFORMED_RESPONSE", "Malformed upload descriptor");
        }
    }
    assertFileRef(value) {
        if (!value || typeof value !== "object") {
            throw new FileClientError("E_FILE_CLIENT_MALFORMED_RESPONSE", "Upload response did not include file_ref");
        }
        const file_ref = value;
        const scope_ok = file_ref._scope === "temp" || file_ref._scope === "app";
        const mime_ok = XPELL_FILE_MIME_TYPES_V1.includes(file_ref._mime_type);
        if (file_ref._type !== XPELL_FILE_REF_TYPE ||
            file_ref._version !== XPELL_FILE_REF_VERSION ||
            typeof file_ref._id !== "string" ||
            !scope_ok ||
            typeof file_ref._app_id !== "string" ||
            typeof file_ref._env !== "string" ||
            typeof file_ref._filename !== "string" ||
            !mime_ok ||
            typeof file_ref._size_bytes !== "number" ||
            typeof file_ref._created_at !== "string" ||
            "_path" in file_ref ||
            "_absolute_path" in file_ref) {
            throw new FileClientError("E_FILE_CLIENT_MALFORMED_RESPONSE", "Malformed xpell-file-ref response");
        }
    }
    normalizeError(error) {
        const code = typeof error?._code === "string" ? error._code :
            typeof error?._error?._code === "string" ? error._error._code :
                typeof error?._result?._code === "string" ? error._result._code :
                    "E_INTERNAL";
        return {
            _code: code,
            _message: this.messageFromUnknown(error, "File upload failed"),
            _meta: typeof error?._meta === "object" && error._meta !== null
                ? error._meta
                : {}
        };
    }
    messageFromUnknown(value, fallback) {
        if (value instanceof Error && value.message)
            return value.message;
        if (typeof value === "string" && value.trim())
            return value.trim();
        for (const key of ["_message", "message"]) {
            const message = value?.[key];
            if (typeof message === "string" && message.trim())
                return message.trim();
        }
        const nested = value?._error ?? value?._result;
        if (nested && nested !== value)
            return this.messageFromUnknown(nested, fallback);
        return fallback;
    }
    setStatus(state, patch = {}) {
        this.upload_status = {
            _state: state,
            _updated_at: new Date().toISOString(),
            ...patch
        };
    }
    randomId() {
        const crypto = globalThis.crypto;
        if (crypto && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID().replaceAll("-", "");
        }
        if (crypto && typeof crypto.getRandomValues === "function") {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        }
        return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, "0").slice(0, 32);
    }
}
export function createFileClientModule(options) {
    return new FileClientModule(options);
}
