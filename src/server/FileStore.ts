import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_TEMP_FILE_TTL_MS,
  XPELL_FILE_REF_TYPE,
  XPELL_FILE_REF_VERSION
} from "../shared/contract.js";
import type {
  XpellFileMetadataV1,
  XpellFileMimeTypeV1,
  XpellFileRefV1,
  XpellFileResolveRequirements,
  XpellFileScopeContext,
  XpellFileScopeV1
} from "../shared/types.js";
import { FileServiceError } from "./FileServiceError.js";
import {
  assert_file_id,
  assert_file_ref,
  assert_scope_matches_ref,
  encode_scope_segment,
  normalize_env,
  normalize_mime_type,
  normalize_scope,
  normalize_scope_context,
  normalize_scope_segment,
  sanitize_filename,
  validate_file_bytes,
  validate_filename_for_mime
} from "./validation.js";

export type XpellFileStoreOptions = {
  _work_folder: string;
  _temp_ttl_ms?: number;
  _max_image_bytes?: number;
};

export type StoreTrustedBufferInput = {
  _scope: XpellFileScopeV1;
  _app_id: string;
  _env: string;
  _filename: string;
  _mime_type: XpellFileMimeTypeV1;
  _bytes: Buffer;
  _expires_at?: string;
};

type FilePaths = {
  _dir: string;
  _blob_path: string;
  _meta_path: string;
};

export type XpellResolvedFileV1 = {
  _type: "xpell-resolved-file";
  _ref: XpellFileRefV1;
  _absolute_path: string;
  _mime_type: XpellFileMimeTypeV1;
  _size_bytes: number;
  _sha256?: string;
  _owner: XpellFileScopeContext;
  _expires_at?: string;
  openReadStream: () => ReadStream;
};

function scope_dir_name(scope: XpellFileScopeV1): "temp" | "apps" {
  return scope === "temp" ? "temp" : "apps";
}

function public_ref_from_meta(meta: XpellFileMetadataV1): XpellFileRefV1 {
  return {
    _type: meta._type,
    _version: meta._version,
    _id: meta._id,
    _scope: meta._scope,
    _app_id: meta._app_id,
    _env: meta._env,
    _filename: meta._filename,
    _mime_type: meta._mime_type,
    _size_bytes: meta._size_bytes,
    ...(meta._sha256 ? { _sha256: meta._sha256 } : {}),
    _created_at: meta._created_at,
    ...(meta._expires_at ? { _expires_at: meta._expires_at } : {})
  };
}

export class XpellFileStore {
  readonly _work_folder: string;
  readonly _root: string;
  readonly _temp_ttl_ms: number;
  readonly _max_image_bytes: number;

  private _ready = false;

  constructor(options: XpellFileStoreOptions) {
    this._work_folder = path.resolve(normalize_scope_segment(options._work_folder, "_work_folder"));
    this._root = path.resolve(this._work_folder, "files");
    this._temp_ttl_ms = options._temp_ttl_ms ?? DEFAULT_TEMP_FILE_TTL_MS;
    this._max_image_bytes = options._max_image_bytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  get ready() {
    return this._ready;
  }

  async init(): Promise<void> {
    await mkdir(this.safeResolveUnderRoot("temp"), { recursive: true });
    await mkdir(this.safeResolveUnderRoot("apps"), { recursive: true });
    this._ready = true;
    await this.cleanupExpiredTempFiles();
  }

  get_readiness() {
    return {
      _ready: this._ready,
      _status: this._ready ? "ready" as const : "not_ready" as const,
      _checks: {
        _work_folder: this._work_folder,
        _root: this._root,
        _temp_ttl_ms: this._temp_ttl_ms,
        _max_image_bytes: this._max_image_bytes
      }
    };
  }

  safeResolveUnderRoot(...parts: string[]): string {
    const resolved = path.resolve(this._root, ...parts);
    const relative = path.relative(this._root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new FileServiceError("E_PERMISSION_DENIED", "Resolved file path escapes file-store root");
  }

  pathsFor(scope: XpellFileScopeV1, app_id: string, env: string, file_id: string): FilePaths {
    const normalized_scope = normalize_scope(scope);
    const normalized_app_id = normalize_scope_segment(app_id, "_app_id");
    const normalized_env = normalize_env(env);
    const id = assert_file_id(file_id);
    const dir = this.safeResolveUnderRoot(
      scope_dir_name(normalized_scope),
      encode_scope_segment(normalized_env),
      encode_scope_segment(normalized_app_id),
      id
    );
    return {
      _dir: dir,
      _blob_path: this.safeResolveUnderRoot(
        scope_dir_name(normalized_scope),
        encode_scope_segment(normalized_env),
        encode_scope_segment(normalized_app_id),
        id,
        "blob"
      ),
      _meta_path: this.safeResolveUnderRoot(
        scope_dir_name(normalized_scope),
        encode_scope_segment(normalized_env),
        encode_scope_segment(normalized_app_id),
        id,
        "meta.json"
      )
    };
  }

  async storeTrustedBuffer(input: StoreTrustedBufferInput): Promise<XpellFileRefV1> {
    this.assertReady();
    const scope = normalize_scope(input._scope);
    const context = normalize_scope_context(input);
    const filename = sanitize_filename(input._filename);
    const mime_type = normalize_mime_type(input._mime_type);
    validate_filename_for_mime(filename, mime_type);
    validate_file_bytes(input._bytes, mime_type, this._max_image_bytes);

    const file_id = this.generateFileId();
    const paths = this.pathsFor(scope, context._app_id, context._env, file_id);
    const created_at = new Date().toISOString();
    const expires_at =
      scope === "temp"
        ? input._expires_at ?? new Date(Date.now() + this._temp_ttl_ms).toISOString()
        : undefined;
    const sha256 = createHash("sha256").update(input._bytes).digest("hex");
    const meta: XpellFileMetadataV1 = {
      _type: XPELL_FILE_REF_TYPE,
      _version: XPELL_FILE_REF_VERSION,
      _storage_version: 1,
      _id: file_id,
      _scope: scope,
      _app_id: context._app_id,
      _env: context._env,
      _filename: filename,
      _mime_type: mime_type,
      _size_bytes: input._bytes.length,
      _sha256: sha256,
      _created_at: created_at,
      ...(expires_at ? { _expires_at: expires_at } : {}),
      _blob_name: "blob"
    };

    await mkdir(paths._dir, { recursive: true });
    const tmp_blob = path.join(paths._dir, `blob.${process.pid}.${Date.now()}.tmp`);
    const tmp_meta = path.join(paths._dir, `meta.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp_blob, input._bytes);
    await writeFile(tmp_meta, JSON.stringify(meta, null, 2), "utf8");
    await rename(tmp_blob, paths._blob_path);
    await rename(tmp_meta, paths._meta_path);

    return public_ref_from_meta(meta);
  }

  async getMetadata(file_ref: unknown, context: XpellFileScopeContext): Promise<XpellFileRefV1> {
    const meta = await this.readMetadata(file_ref, context);
    return public_ref_from_meta(meta);
  }

  async deleteFile(file_ref: unknown, context: XpellFileScopeContext): Promise<{ _deleted: true; file_ref: XpellFileRefV1 }> {
    const meta = await this.readMetadata(file_ref, context, { _allow_expired: true });
    const paths = this.pathsFor(meta._scope, meta._app_id, meta._env, meta._id);
    await rm(paths._dir, { recursive: true, force: true });
    return {
      _deleted: true,
      file_ref: public_ref_from_meta(meta)
    };
  }

  async promote(file_ref: unknown, context: XpellFileScopeContext): Promise<{
    file_ref: XpellFileRefV1;
    _source_deleted: boolean;
  }> {
    const source = await this.readMetadata(file_ref, context);
    if (source._scope !== "temp") {
      throw new FileServiceError("E_INVALID_PARAMS", "Only temp files can be promoted", {
        _scope: source._scope
      });
    }

    const source_paths = this.pathsFor(source._scope, source._app_id, source._env, source._id);
    const next_id = this.generateFileId();
    const target_paths = this.pathsFor("app", source._app_id, source._env, next_id);
    const created_at = new Date().toISOString();
    const target: XpellFileMetadataV1 = {
      _type: XPELL_FILE_REF_TYPE,
      _version: XPELL_FILE_REF_VERSION,
      _storage_version: 1,
      _id: next_id,
      _scope: "app",
      _app_id: source._app_id,
      _env: source._env,
      _filename: source._filename,
      _mime_type: source._mime_type,
      _size_bytes: source._size_bytes,
      ...(source._sha256 ? { _sha256: source._sha256 } : {}),
      _created_at: created_at,
      _blob_name: "blob"
    };

    await mkdir(target_paths._dir, { recursive: true });
    await copyFile(source_paths._blob_path, target_paths._blob_path);
    await writeFile(target_paths._meta_path, JSON.stringify(target, null, 2), "utf8");
    await rm(source_paths._dir, { recursive: true, force: true });

    return {
      file_ref: public_ref_from_meta(target),
      _source_deleted: true
    };
  }

  async resolveTrusted(file_ref: unknown, requirements: XpellFileResolveRequirements): Promise<XpellResolvedFileV1> {
    const context = normalize_scope_context(requirements);
    const meta = await this.readMetadata(file_ref, context);
    const accepted = requirements._accepted_mime_types;
    if (accepted && !accepted.includes(meta._mime_type)) {
      throw new FileServiceError("E_UNSUPPORTED_MIME_TYPE", "Resolved file MIME type is not accepted", {
        _mime_type: meta._mime_type,
        _accepted_mime_types: accepted
      });
    }

    if (
      typeof requirements._max_size_bytes === "number" &&
      Number.isFinite(requirements._max_size_bytes) &&
      meta._size_bytes > requirements._max_size_bytes
    ) {
      throw new FileServiceError("E_FILE_TOO_LARGE", "Resolved file exceeds maximum allowed size", {
        _size_bytes: meta._size_bytes,
        _max_size_bytes: requirements._max_size_bytes
      });
    }

    const paths = this.pathsFor(meta._scope, meta._app_id, meta._env, meta._id);
    const current_stat = await stat(paths._blob_path);
    if (!current_stat.isFile() || current_stat.size !== meta._size_bytes) {
      throw new FileServiceError("E_FILE_INVALID_BYTES", "Stored file does not match metadata", {
        _id: meta._id
      });
    }

    return {
      _type: "xpell-resolved-file",
      _ref: public_ref_from_meta(meta),
      _absolute_path: paths._blob_path,
      _mime_type: meta._mime_type,
      _size_bytes: meta._size_bytes,
      ...(meta._sha256 ? { _sha256: meta._sha256 } : {}),
      _owner: {
        _app_id: meta._app_id,
        _env: meta._env
      },
      ...(meta._expires_at ? { _expires_at: meta._expires_at } : {}),
      openReadStream: (): ReadStream => createReadStream(paths._blob_path)
    };
  }

  async cleanupExpiredTempFiles(now_ms = Date.now()): Promise<{ _deleted: number }> {
    let deleted = 0;
    const temp_root = this.safeResolveUnderRoot("temp");
    const env_entries = await this.readDirSafe(temp_root);

    for (const env_entry of env_entries) {
      if (!env_entry.isDirectory()) continue;
      const env_path = path.join(temp_root, env_entry.name);
      const app_entries = await this.readDirSafe(env_path);
      for (const app_entry of app_entries) {
        if (!app_entry.isDirectory()) continue;
        const app_path = path.join(env_path, app_entry.name);
        const file_entries = await this.readDirSafe(app_path);
        for (const file_entry of file_entries) {
          if (!file_entry.isDirectory()) continue;
          const file_dir = path.join(app_path, file_entry.name);
          const meta_path = path.join(file_dir, "meta.json");
          try {
            const raw = JSON.parse(await readFile(meta_path, "utf8")) as XpellFileMetadataV1;
            if (raw._scope === "temp" && raw._expires_at && Date.parse(raw._expires_at) <= now_ms) {
              await rm(file_dir, { recursive: true, force: true });
              deleted += 1;
            }
          } catch {
            continue;
          }
        }
      }
    }

    return { _deleted: deleted };
  }

  private async readMetadata(
    file_ref: unknown,
    context: XpellFileScopeContext,
    options: { _allow_expired?: boolean; _allow_expired_cleanup?: boolean } = {}
  ): Promise<XpellFileMetadataV1> {
    this.assertReady();
    const ref = assert_file_ref(file_ref);
    const normalized_context = normalize_scope_context(context);
    assert_scope_matches_ref(ref, normalized_context);
    const paths = this.pathsFor(ref._scope, ref._app_id, ref._env, ref._id);

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(paths._meta_path, "utf8"));
    } catch (error) {
      throw new FileServiceError("E_NOT_FOUND", "File metadata not found", {
        _id: ref._id,
        _cause: error instanceof Error ? error.message : String(error)
      });
    }

    const meta = this.assertMetadata(raw);
    assert_scope_matches_ref(meta, normalized_context);
    if (meta._id !== ref._id || meta._scope !== ref._scope) {
      throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "File ref does not match stored metadata", {
        _id: ref._id
      });
    }

    if (
      meta._scope === "temp" &&
      meta._expires_at &&
      Date.parse(meta._expires_at) <= Date.now() &&
      options._allow_expired !== true
    ) {
      if (options._allow_expired_cleanup !== false) {
        await rm(paths._dir, { recursive: true, force: true });
      }
      throw new FileServiceError("E_FILE_EXPIRED", "Temp file has expired", {
        _id: meta._id,
        _expires_at: meta._expires_at
      });
    }

    return meta;
  }

  private assertMetadata(value: unknown): XpellFileMetadataV1 {
    const ref = assert_file_ref(value);
    const raw = value as Record<string, unknown>;
    if (raw._storage_version !== 1 || raw._blob_name !== "blob") {
      throw new FileServiceError("E_UNSUPPORTED_FILE_REF", "Unsupported stored file metadata", {
        _storage_version: raw._storage_version
      });
    }
    return {
      ...ref,
      _storage_version: 1,
      _blob_name: "blob"
    };
  }

  private assertReady(): void {
    if (!this._ready) {
      throw new FileServiceError("E_NOT_READY", "File store is not ready");
    }
  }

  private generateFileId(): string {
    return `file_${randomUUID().replaceAll("-", "")}`;
  }

  private async readDirSafe(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}
