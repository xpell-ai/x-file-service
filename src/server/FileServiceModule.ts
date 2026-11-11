import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  XModule,
  XResponseError,
  XResponseOK,
  type XCommand,
  type XpellSkill,
  type XpellSkillCommand
} from "@xpell/core";
import {
  DEFAULT_UPLOAD_SLOT_TTL_MS,
  FILE_SERVICE_MODULE_ID,
  FILE_SERVICE_PACKAGE_NAME,
  FILE_SERVICE_VERSION,
  XPELL_FILE_MIME_TYPES_V1,
  XPELL_FILE_REF_TYPE,
  XPELL_FILE_REF_VERSION,
  XPELL_FILE_SCOPES_V1,
  XPELL_IMAGE_MIME_TYPES_V1
} from "../shared/contract.js";
import type {
  XpellFileMimeTypeV1,
  XpellFileRefV1,
  XpellFileResolveRequirements,
  XpellFileScopeContext,
  XpellFileServiceReadiness,
  XpellFileUploadSlotV1
} from "../shared/types.js";
import { FileServiceError } from "./FileServiceError.js";
import { XpellFileStore, type XpellFileStoreOptions } from "./FileStore.js";
import {
  normalize_mime_type,
  normalize_scope,
  normalize_scope_context,
  sanitize_filename,
  validate_filename_for_mime
} from "./validation.js";

export type FileServiceModuleOptions = XpellFileStoreOptions & {
  _upload_route_base_path?: string;
  _upload_slot_ttl_ms?: number;
  _require_upload_auth?: boolean;
};

type FileServiceAuthContext = {
  _authenticated: boolean;
  _clearance_level?: number;
  _user_id?: string;
  _account_id?: string;
  _agent_id?: string;
  _auth_type?: string;
};

type InternalUploadSlot = Omit<XpellFileUploadSlotV1, "_headers"> & {
  _token_hash: string;
  _auth: FileServiceAuthContext;
};

export type FileServiceMultipartUploadInput = {
  _upload_id: string;
  _token: string;
  _filename?: string;
  _mime_type?: string;
  _bytes: Buffer;
};

type FileServiceOpMetadata = XpellSkillCommand & Record<string, unknown>;

export const FILE_SERVICE_OPS: Record<string, FileServiceOpMetadata> = {
  "get-capabilities": {
    _id: "get-capabilities",
    _name: "get-capabilities",
    _scope: "server",
    _description: "Return File Service V1 supported scopes, MIME types, limits, and Phase 2A transport status.",
    _input_schema: {
      type: "object",
      additionalProperties: true
    },
    _output_schema: {
      type: "object",
      required: ["_type", "_version", "_scopes", "_mime_types"],
      properties: {
        _type: { const: "xpell-file-service-capabilities" },
        _version: { const: 1 },
        _scopes: { type: "array", items: { enum: XPELL_FILE_SCOPES_V1 } },
        _mime_types: { type: "array", items: { enum: XPELL_FILE_MIME_TYPES_V1 } }
      }
    },
    _errors: [],
    _permissions: [],
    _examples: [
      {
        _module: FILE_SERVICE_MODULE_ID,
        _op: "get-capabilities",
        _params: {}
      }
    ],
    _side_effects: "none"
  },
  "create-upload": {
    _id: "create-upload",
    _name: "create-upload",
    _scope: "app",
    _description: "Create a short-lived authenticated multipart upload slot for one allowed file.",
    _params: {
      _app_id: "Owning app id.",
      _env: "Owning app environment.",
      _scope: "temp or app.",
      _filename: "Original filename metadata.",
      _mime_type: "Expected allowed MIME type.",
      _size_bytes: "Expected byte size."
    },
    _input_schema: {
      type: "object",
      required: ["_app_id", "_env", "_scope", "_filename", "_mime_type", "_size_bytes"],
      properties: {
        _app_id: { type: "string" },
        _env: { type: "string" },
        _scope: { enum: XPELL_FILE_SCOPES_V1 },
        _filename: { type: "string" },
        _mime_type: { enum: XPELL_FILE_MIME_TYPES_V1 },
        _size_bytes: { type: "integer", minimum: 1 }
      }
    },
    _output_schema: {
      type: "object",
      required: ["upload"],
      properties: {
        upload: {
          type: "object",
          required: ["_type", "_version", "_upload_id", "_url", "_method", "_field", "_headers", "_expires_at"],
          properties: {
            _type: { const: "xpell-file-upload-slot" },
            _version: { const: 1 },
            _upload_id: { type: "string" },
            _url: { type: "string" },
            _method: { const: "POST" },
            _field: { const: "file" },
            _headers: { type: "object" },
            _expires_at: { type: "string" }
          }
        }
      }
    },
    _errors: ["E_INVALID_PARAMS", "E_UPLOAD_AUTH_REQUIRED", "E_UNSUPPORTED_MIME_TYPE", "E_UNSUPPORTED_FILE_EXTENSION", "E_FILE_TOO_LARGE"],
    _permissions: ["file_service:create_upload"],
    _examples: [
      {
        _module: FILE_SERVICE_MODULE_ID,
        _op: "create-upload",
        _params: {
          _app_id: "pc-10",
          _env: "default",
          _scope: "temp",
          _filename: "yogurt.jpg",
          _mime_type: "image/jpeg",
          _size_bytes: 123456
        }
      }
    ],
    _side_effects: "create-upload-slot"
  },
  "get-metadata": {
    _id: "get-metadata",
    _name: "get-metadata",
    _scope: "app",
    _description: "Return canonical public metadata for an app/env-owned file ref.",
    _params: {
      _app_id: "Owning app id.",
      _env: "Owning app environment.",
      file_ref: "Canonical xpell-file-ref V1."
    },
    _input_schema: {
      type: "object",
      required: ["_app_id", "_env", "file_ref"],
      properties: {
        _app_id: { type: "string" },
        _env: { type: "string" },
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
      }
    },
    _output_schema: {
      type: "object",
      required: ["file_ref"],
      properties: {
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
      }
    },
    _errors: ["E_INVALID_PARAMS", "E_PERMISSION_DENIED", "E_NOT_FOUND", "E_UNSUPPORTED_FILE_REF", "E_FILE_EXPIRED"],
    _permissions: ["file_service:get_metadata"],
    _examples: [],
    _side_effects: "none"
  },
  delete: {
    _id: "delete",
    _name: "delete",
    _scope: "app",
    _description: "Delete an app/env-owned temp or app file.",
    _params: {
      _app_id: "Owning app id.",
      _env: "Owning app environment.",
      file_ref: "Canonical xpell-file-ref V1."
    },
    _input_schema: {
      type: "object",
      required: ["_app_id", "_env", "file_ref"],
      properties: {
        _app_id: { type: "string" },
        _env: { type: "string" },
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
      }
    },
    _output_schema: {
      type: "object",
      required: ["_deleted", "file_ref"],
      properties: {
        _deleted: { const: true },
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
      }
    },
    _errors: ["E_INVALID_PARAMS", "E_PERMISSION_DENIED", "E_NOT_FOUND", "E_UNSUPPORTED_FILE_REF"],
    _permissions: ["file_service:delete"],
    _examples: [],
    _side_effects: "delete-file"
  },
  promote: {
    _id: "promote",
    _name: "promote",
    _scope: "app",
    _description: "Promote a temp file into persistent app scope for the same app/env.",
    _params: {
      _app_id: "Owning app id.",
      _env: "Owning app environment.",
      file_ref: "Canonical temp xpell-file-ref V1."
    },
    _input_schema: {
      type: "object",
      required: ["_app_id", "_env", "file_ref"],
      properties: {
        _app_id: { type: "string" },
        _env: { type: "string" },
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" }
      }
    },
    _output_schema: {
      type: "object",
      required: ["file_ref", "_source_deleted"],
      properties: {
        file_ref: { "$ref": "#/$defs/XpellFileRefV1" },
        _source_deleted: { type: "boolean" }
      }
    },
    _errors: ["E_INVALID_PARAMS", "E_PERMISSION_DENIED", "E_NOT_FOUND", "E_UNSUPPORTED_FILE_REF", "E_FILE_EXPIRED"],
    _permissions: ["file_service:promote"],
    _examples: [],
    _side_effects: "create-file delete-file"
  }
};

export const FILE_SERVICE_SKILL: XpellSkill & Record<string, unknown> = {
  _id: FILE_SERVICE_MODULE_ID,
  _title: "Xpell File Service",
  _version: FILE_SERVICE_VERSION,
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule"],
  _package: FILE_SERVICE_PACKAGE_NAME,
  _runtime: {
    _target: "server",
    _hosts: ["xnode"],
    _xpell_core: ">=2.0.0"
  },
  _ops: FILE_SERVICE_OPS,
  _config: [
    {
      _key: "_work_folder",
      _label: "Work folder",
      _description: "XNode work folder used as the root for files storage.",
      _required: true
    },
    {
      _key: "_temp_ttl_ms",
      _label: "Temp TTL",
      _description: "Default temp file lifetime in milliseconds.",
      _input: "number"
    },
    {
      _key: "_max_image_bytes",
      _label: "Max upload bytes",
      _description: "Maximum accepted upload size in bytes. Backward-compatible name retained from image-only uploads.",
      _input: "number"
    }
  ],
  _secrets: [],
  _permissions: ["file_service:create_upload", "file_service:get_metadata", "file_service:delete", "file_service:promote"],
  _readiness: {
    _status: "ready",
    _checks: ["work_folder", "file_store"]
  },
  _description:
    "Canonical server-side file reference, scoped storage, metadata, promotion, deletion, and trusted resolution service.",
  _exports: {
    _modules: [
      {
        _name: FILE_SERVICE_MODULE_ID,
        _scope: "server",
        _description: "Canonical Xpell File Service V1 server module.",
        _ops: Object.values(FILE_SERVICE_OPS)
      }
    ]
  },
  _core_rules: [
    "Use xpell-file-ref V1 for reusable module file inputs.",
    "Public file refs must not contain absolute local paths.",
    "Server modules must resolve files through file-service before reading bytes.",
    "Phase 2A supports authenticated one-time multipart uploads.",
    "Phase 2A supports temp and app scopes only.",
    "Phase 2A supports JPEG, PNG, WebP, CSV, and PDF bytes with extension/MIME validation."
  ],
  _notes: [
    "Phase 2A does not expose download URLs, food-image-analyzer integration, XVibe integration, or XMCP tools."
  ],
  _canonical_examples: [
    {
      _module: FILE_SERVICE_MODULE_ID,
      _op: "get-capabilities",
      _params: {}
    },
    {
      _module: FILE_SERVICE_MODULE_ID,
      _op: "create-upload",
      _params: {
        _app_id: "pc-10",
        _env: "default",
        _scope: "temp",
        _filename: "yogurt.jpg",
        _mime_type: "image/jpeg",
        _size_bytes: 123456
      }
    },
    {
      _module: FILE_SERVICE_MODULE_ID,
      _op: "get-metadata",
      _params: {
        _app_id: "pc-10",
        _env: "default",
        file_ref: {
          _type: XPELL_FILE_REF_TYPE,
          _version: XPELL_FILE_REF_VERSION,
          _id: "file_00000000000000000000000000000000",
          _scope: "temp",
          _app_id: "pc-10",
          _env: "default",
          _filename: "yogurt.jpg",
          _mime_type: "image/jpeg",
          _size_bytes: 123456,
          _created_at: "2026-09-06T00:00:00.000Z",
          _expires_at: "2026-09-06T01:00:00.000Z"
        }
      }
    }
  ]
};

export class FileServiceModule extends XModule {
  static _name = FILE_SERVICE_MODULE_ID;
  static _ops = FILE_SERVICE_OPS;
  static _skill = FILE_SERVICE_SKILL;

  readonly store: XpellFileStore;
  readonly _upload_route_base_path: string;
  readonly _upload_slot_ttl_ms: number;
  readonly _require_upload_auth: boolean;

  private readonly upload_slots = new Map<string, InternalUploadSlot>();

  constructor(options: FileServiceModuleOptions) {
    super({ _name: FILE_SERVICE_MODULE_ID });
    this.store = new XpellFileStore(options);
    this._upload_route_base_path = options._upload_route_base_path ?? "/file-service/upload";
    this._upload_slot_ttl_ms = options._upload_slot_ttl_ms ?? DEFAULT_UPLOAD_SLOT_TTL_MS;
    this._require_upload_auth = options._require_upload_auth !== false;
  }

  override async onLoad(): Promise<void> {
    await this.store.init();
  }

  get_readiness(): XpellFileServiceReadiness {
    return this.store.get_readiness();
  }

  getCapabilities() {
    return {
      _type: "xpell-file-service-capabilities",
      _version: 1,
      _module: FILE_SERVICE_MODULE_ID,
      _package: FILE_SERVICE_PACKAGE_NAME,
      _scopes: XPELL_FILE_SCOPES_V1,
      _mime_types: XPELL_FILE_MIME_TYPES_V1,
      _image_mime_types: XPELL_IMAGE_MIME_TYPES_V1,
      _max_upload_bytes: this.store._max_image_bytes,
      _max_image_bytes: this.store._max_image_bytes,
      _temp_ttl_ms: this.store._temp_ttl_ms,
      _upload_slot_ttl_ms: this._upload_slot_ttl_ms,
      _public_operations: Object.keys(FILE_SERVICE_OPS),
      _trusted_server_api: ["resolveTrusted", "storeTrustedBuffer"],
      _transport: {
        _multipart_upload: true,
        _upload_slots: true,
        _download_urls: false,
        _x_execute_raw_bytes: false
      }
    };
  }

  async resolveTrusted(file_ref: unknown, requirements: XpellFileResolveRequirements) {
    return this.store.resolveTrusted(file_ref, requirements);
  }

  async storeTrustedBuffer(input: Parameters<XpellFileStore["storeTrustedBuffer"]>[0]) {
    return this.store.storeTrustedBuffer(input);
  }

  async cleanupExpiredTempFiles(now_ms?: number) {
    return this.store.cleanupExpiredTempFiles(now_ms);
  }

  async acceptMultipartUpload(input: FileServiceMultipartUploadInput): Promise<XpellFileRefV1> {
    const slot = this.consumeUploadSlot(input._upload_id, input._token);
    if (input._bytes.length !== slot._size_bytes) {
      throw new FileServiceError("E_INVALID_PARAMS", "Uploaded file size does not match upload slot", {
        _upload_id: slot._upload_id,
        _expected_size_bytes: slot._size_bytes,
        _size_bytes: input._bytes.length
      });
    }

    if (input._mime_type && input._mime_type.toLowerCase() !== slot._mime_type) {
      throw new FileServiceError("E_UNSUPPORTED_MIME_TYPE", "Uploaded file MIME type does not match upload slot", {
        _upload_id: slot._upload_id,
        _expected_mime_type: slot._mime_type,
        _mime_type: input._mime_type
      });
    }

    return this.store.storeTrustedBuffer({
      _scope: slot._scope,
      _app_id: slot._app_id,
      _env: slot._env,
      _filename: input._filename || slot._filename,
      _mime_type: slot._mime_type,
      _bytes: input._bytes
    });
  }

  getUploadSlot(upload_id: string): XpellFileUploadSlotV1 | null {
    this.cleanupExpiredUploadSlots();
    const slot = this.upload_slots.get(upload_id);
    if (!slot) return null;
    return this.publicUploadSlot(slot, "");
  }

  async _get_capabilities(_xcmd: XCommand) {
    try {
      return new XResponseOK(this.getCapabilities()).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  async _create_upload(xcmd: XCommand) {
    try {
      const params = this.readParams(xcmd);
      const auth = this.readTrustedAuth(xcmd);
      if (this._require_upload_auth && auth._authenticated !== true) {
        throw new FileServiceError("E_UPLOAD_AUTH_REQUIRED", "Authenticated runtime context is required to create an upload slot");
      }

      const context = this.readContext(params);
      const scope = normalize_scope(params._scope);
      const filename = sanitize_filename(params._filename);
      const mime_type = normalize_mime_type(params._mime_type);
      validate_filename_for_mime(filename, mime_type);
      const size_bytes = this.readSizeBytes(params._size_bytes);
      if (size_bytes > this.store._max_image_bytes) {
        throw new FileServiceError("E_FILE_TOO_LARGE", "Upload slot size exceeds maximum file size", {
          _size_bytes: size_bytes,
          _max_size_bytes: this.store._max_image_bytes
        });
      }

      const upload = this.createUploadSlot({
        _scope: scope,
        _app_id: context._app_id,
        _env: context._env,
        _filename: filename,
        _mime_type: mime_type,
        _size_bytes: size_bytes,
        _auth: auth
      });

      return new XResponseOK({ upload }).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  async _get_metadata(xcmd: XCommand) {
    try {
      const params = this.readParams(xcmd);
      const context = this.readContext(params);
      const file_ref = await this.store.getMetadata(params.file_ref, context);
      return new XResponseOK({ file_ref }).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  async _delete(xcmd: XCommand) {
    try {
      const params = this.readParams(xcmd);
      const context = this.readContext(params);
      const result = await this.store.deleteFile(params.file_ref, context);
      return new XResponseOK(result).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  async _promote(xcmd: XCommand) {
    try {
      const params = this.readParams(xcmd);
      const context = this.readContext(params);
      const result = await this.store.promote(params.file_ref, context);
      return new XResponseOK(result).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  private readParams(xcmd: XCommand): Record<string, unknown> {
    const params = xcmd?._params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new FileServiceError("E_INVALID_PARAMS", "Command _params must be an object");
    }
    return params as Record<string, unknown>;
  }

  private readContext(params: Record<string, unknown>): XpellFileScopeContext {
    return normalize_scope_context({
      _app_id: params._app_id,
      _env: params._env
    });
  }

  private createUploadSlot(input: {
    _scope: "temp" | "app";
    _app_id: string;
    _env: string;
    _filename: string;
    _mime_type: XpellFileMimeTypeV1;
    _size_bytes: number;
    _auth: FileServiceAuthContext;
  }): XpellFileUploadSlotV1 {
    this.cleanupExpiredUploadSlots();
    const upload_id = `upl_${randomUUID().replaceAll("-", "")}`;
    const token = `xfs_${randomBytes(32).toString("base64url")}`;
    const expires_at = new Date(Date.now() + this._upload_slot_ttl_ms).toISOString();
    const slot: InternalUploadSlot = {
      _type: "xpell-file-upload-slot",
      _version: 1,
      _upload_id: upload_id,
      _url: `${this._upload_route_base_path}/${upload_id}`,
      _method: "POST",
      _field: "file",
      _scope: input._scope,
      _app_id: input._app_id,
      _env: input._env,
      _filename: input._filename,
      _mime_type: input._mime_type,
      _size_bytes: input._size_bytes,
      _max_size_bytes: this.store._max_image_bytes,
      _expires_at: expires_at,
      _token_hash: this.hashToken(token),
      _auth: input._auth
    };
    this.upload_slots.set(upload_id, slot);
    return this.publicUploadSlot(slot, token);
  }

  private consumeUploadSlot(upload_id: string, token: string): InternalUploadSlot {
    this.cleanupExpiredUploadSlots();
    const slot = this.upload_slots.get(upload_id);
    if (!slot) {
      throw new FileServiceError("E_UPLOAD_SLOT_NOT_FOUND", "Upload slot not found", { _upload_id: upload_id });
    }

    if (Date.parse(slot._expires_at) <= Date.now()) {
      this.upload_slots.delete(upload_id);
      throw new FileServiceError("E_UPLOAD_SLOT_EXPIRED", "Upload slot has expired", {
        _upload_id: upload_id,
        _expires_at: slot._expires_at
      });
    }

    if (!this.tokenMatches(token, slot._token_hash)) {
      throw new FileServiceError("E_UPLOAD_TOKEN_INVALID", "Invalid upload token", { _upload_id: upload_id });
    }

    this.upload_slots.delete(upload_id);
    return slot;
  }

  private cleanupExpiredUploadSlots(now_ms = Date.now()): void {
    for (const [upload_id, slot] of this.upload_slots) {
      if (Date.parse(slot._expires_at) <= now_ms) {
        this.upload_slots.delete(upload_id);
      }
    }
  }

  private publicUploadSlot(slot: InternalUploadSlot, token: string): XpellFileUploadSlotV1 {
    return {
      _type: slot._type,
      _version: slot._version,
      _upload_id: slot._upload_id,
      _url: slot._url,
      _method: slot._method,
      _field: slot._field,
      _headers: {
        "X-Xpell-Upload-Token": token
      },
      _scope: slot._scope,
      _app_id: slot._app_id,
      _env: slot._env,
      _filename: slot._filename,
      _mime_type: slot._mime_type,
      _size_bytes: slot._size_bytes,
      _max_size_bytes: slot._max_size_bytes,
      _expires_at: slot._expires_at
    };
  }

  private readSizeBytes(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new FileServiceError("E_INVALID_PARAMS", "_size_bytes must be a positive safe integer", {
        _size_bytes: value
      });
    }
    return value;
  }

  private readTrustedAuth(xcmd: XCommand): FileServiceAuthContext {
    const ctx = (xcmd as any)?._ctx;
    const ctx_auth = ctx && typeof ctx === "object" && ctx._auth && typeof ctx._auth === "object"
      ? ctx._auth as Record<string, unknown>
      : undefined;
    const auth = ctx_auth ?? {};
    return {
      _authenticated: auth._authenticated === true,
      _clearance_level: typeof auth._clearance_level === "number" ? auth._clearance_level : undefined,
      _user_id: typeof auth._user_id === "string" ? auth._user_id : undefined,
      _account_id: typeof auth._account_id === "string" ? auth._account_id : undefined,
      _agent_id: typeof auth._agent_id === "string" ? auth._agent_id : undefined,
      _auth_type: typeof auth._auth_type === "string" ? auth._auth_type : undefined
    };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private tokenMatches(token: string, expected_hash: string): boolean {
    if (typeof token !== "string" || !token.trim()) return false;
    const actual = Buffer.from(this.hashToken(token.trim()), "hex");
    const expected = Buffer.from(expected_hash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export function createFileServiceModule(options: FileServiceModuleOptions): FileServiceModule {
  return new FileServiceModule(options);
}
