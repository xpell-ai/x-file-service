export type XpellFileScopeV1 = "temp" | "app";

export type XpellImageMimeTypeV1 =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type XpellFileMimeTypeV1 =
  | XpellImageMimeTypeV1
  | "text/csv"
  | "application/csv"
  | "application/vnd.ms-excel"
  | "application/pdf";

export type XpellFileRefV1 = {
  _type: "xpell-file-ref";
  _version: 1;
  _id: string;
  _scope: XpellFileScopeV1;
  _app_id: string;
  _env: string;
  _filename: string;
  _mime_type: XpellFileMimeTypeV1;
  _size_bytes: number;
  _sha256?: string;
  _created_at: string;
  _expires_at?: string;
};

export type XpellFileMetadataV1 = XpellFileRefV1 & {
  _storage_version: 1;
  _blob_name: "blob";
};

export type XpellFileScopeContext = {
  _app_id: string;
  _env: string;
};

export type XpellFileResolveRequirements = XpellFileScopeContext & {
  _accepted_mime_types?: readonly XpellFileMimeTypeV1[];
  _max_size_bytes?: number;
};

export type XpellFileUploadSlotV1 = {
  _type: "xpell-file-upload-slot";
  _version: 1;
  _upload_id: string;
  _url: string;
  _method: "POST";
  _field: "file";
  _headers: {
    "X-Xpell-Upload-Token": string;
  };
  _scope: XpellFileScopeV1;
  _app_id: string;
  _env: string;
  _filename: string;
  _mime_type: XpellFileMimeTypeV1;
  _size_bytes: number;
  _max_size_bytes: number;
  _expires_at: string;
};

export type XpellFileServiceReadiness = {
  _ready: boolean;
  _status: "ready" | "not_ready" | "degraded";
  _checks: Record<string, unknown>;
  _missing_config?: string[];
};
