# @xpell/file-service

Canonical Xpell File Service V1 server module.

Phase 2B provides the shared `xpell-file-ref` V1 contract, a safe server-side file store under `<work_folder>/files`, image validation for JPEG/PNG/WebP, app/env-scoped metadata, temp cleanup, public metadata/delete/promote ops, authenticated upload-slot creation, one-time multipart HTTP upload, a browser-side `file-client`, and a trusted server-only resolver for consuming modules.

Phase 2B intentionally does not include download URLs, food-image-analyzer integration, XVibe changes, or XMCP changes.

## Module

Runtime module ID:

```text
file-service
```

Server factory:

```ts
import { createFileServiceModule } from "@xpell/file-service/server";

const file_service = createFileServiceModule({
  _work_folder: "./work"
});
```

Browser client factory:

```ts
import { createFileClientModule } from "@xpell/file-service/client";

const file_client = createFileClientModule({
  _send_xcmd: (xcmd) => Wormholes.sendXcmd(xcmd)
});
```

## Public Ops

- `get-capabilities`
- `create-upload`
- `get-metadata`
- `delete`
- `promote`

Public ops return only JSON-safe file refs and metadata. They never return absolute local paths.

`create-upload` returns a short-lived upload slot:

```ts
const response = await _x.execute({
  _module: "file-service",
  _op: "create-upload",
  _params: {
    _app_id: "pc-10",
    _env: "default",
    _scope: "temp",
    _filename: "yogurt.jpg",
    _mime_type: "image/jpeg",
    _size_bytes: 123456
  }
});
```

The client then posts `multipart/form-data` to the returned `_url`, with the file part named `file` and the returned `X-Xpell-Upload-Token` header. A successful upload returns:

```json
{
  "_ok": true,
  "_result": {
    "file_ref": {
      "_type": "xpell-file-ref",
      "_version": 1
    }
  }
}
```

## Browser Client

Runtime module ID:

```text
file-client
```

`file-client` keeps the command surface JSON-safe by using browser-local file handles:

```ts
const handle = file_client.registerFile(file);

await _x.execute({
  _module: "file-client",
  _op: "upload",
  _params: {
    _app_id: "pc-10",
    _env: "default",
    _scope: "temp",
    _file_handle: handle
  }
});
```

For app code that already has a selected browser `File`, the helper API is shorter:

```ts
await file_client.uploadFile({
  _app_id: "pc-10",
  _env: "default",
  _scope: "temp",
  _file: file
});
```

Browser `File` objects, upload tokens, and raw bytes are not sent through `_x.execute`.

## Trusted Server Resolution

Server modules that consume files should call the loaded module directly:

```ts
const resolved = await fileService.resolveTrusted(image_ref, {
  _app_id: "pc-10",
  _env: "default",
  _accepted_mime_types: ["image/jpeg", "image/png", "image/webp"],
  _max_size_bytes: 10000000
});
```

The returned resolved file includes the server-only local path and read-stream factory. Do not return it across client or MCP boundaries.
