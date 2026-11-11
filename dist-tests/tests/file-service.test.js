import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _x } from "@xpell/core";
import express from "express";
import { FILE_CLIENT_MODULE_ID, FileClientModule, createFileClientModule } from "../src/client/index.js";
import { DEFAULT_MAX_IMAGE_BYTES, FILE_SERVICE_MODULE_ID, FileServiceModule, XpellFileStore, createFileServiceUploadRouter, createFileServiceModule } from "../src/server/index.js";
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x00]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = Buffer.from("RIFF\x08\x00\x00\x00WEBPVP8 ", "binary");
const CSV_BYTES = Buffer.from("date,description,amount\n2026-01-01,fee,8.00\n", "utf8");
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");
const SCRIPT_BYTES = Buffer.from("#!/bin/sh\necho unsafe\n", "utf8");
const BINARY_NUL_CSV_BYTES = Buffer.from("date,description,amount\n2026-01-01,\u0000fee,8.00\n", "utf8");
const AUTH_CTX = {
    _auth: {
        _authenticated: true,
        _user_id: "user-1",
        _account_id: "account-1",
        _auth_type: "test"
    }
};
function legacyCsvWithNulPadding() {
    const header = "תאריך תשלום,תאריך רישום,פעילות,סוג פעולה,סכום,יתרה,חייב,שם חייב,קרן,סוג שובר,אסמכתא,חולק לתיק";
    const rows = Array.from({ length: 42 }, (_, index) => {
        const legacy_text = `פעילות ישנה ${index + 1} פירוט היסטורי ארוך ממערכת ישנה לצורך בדיקת דומיננטיות טקסט`;
        const debtor_name = `חייב בדיקה שם ארוך ${index + 1} מקור רשמי מערכת ישנה`;
        return `15.04.08,15.04.08,${legacy_text},סוג לא ממופה,175000.000000,39716.540000,-,${debtor_name},-,לא ידוע מהסבה,          ,`;
    });
    return Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        ...[header, ...rows].flatMap((line, index) => [
            Buffer.from(line, "utf8"),
            ...(index > 0 ? [Buffer.alloc(10)] : []),
            Buffer.from("\r\n", "utf8")
        ])
    ]);
}
function makeBrowserFile(bytes, name, type) {
    const array_buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new File([array_buffer], name, { type });
}
async function withWorkFolder(fn) {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xpell-file-service-"));
    try {
        return await fn(work_folder);
    }
    finally {
        await rm(work_folder, { recursive: true, force: true });
    }
}
async function createReadyModule(work_folder, options = {}) {
    const module = createFileServiceModule({
        _work_folder: work_folder,
        ...options
    });
    await module.load();
    return module;
}
async function storeImage(module, overrides = {}) {
    return module.storeTrustedBuffer({
        _scope: "temp",
        _app_id: "pc-10",
        _env: "default",
        _filename: "yogurt.jpg",
        _mime_type: "image/jpeg",
        _bytes: JPEG_BYTES,
        ...overrides
    });
}
function assertOk(response) {
    assert.equal(response?._ok, true, JSON.stringify(response?._result));
    return response._result;
}
function assertErr(response, code) {
    assert.equal(response?._ok, false, "response should fail");
    assert.equal(response?._result?._code, code, JSON.stringify(response?._result));
}
function uploadCommand(params, ctx = AUTH_CTX) {
    return {
        _module: "file-service",
        _op: "create-upload",
        _params: params,
        ...(ctx ? { _ctx: ctx } : {})
    };
}
function createUploadParams(overrides = {}) {
    return {
        _app_id: "pc-10",
        _env: "default",
        _scope: "temp",
        _filename: "yogurt.jpg",
        _mime_type: "image/jpeg",
        _size_bytes: JPEG_BYTES.length,
        ...overrides
    };
}
function createMultipartBody(input) {
    const boundary = input.boundary ?? "xpell-test-boundary";
    const field = input.field ?? "file";
    const filename = input.filename ?? "yogurt.jpg";
    const mime_type = input.mime_type ?? "image/jpeg";
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`),
        Buffer.from(`Content-Type: ${mime_type}\r\n\r\n`),
        input.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return {
        boundary,
        body,
        content_type: `multipart/form-data; boundary=${boundary}`
    };
}
async function withUploadServer(module, fn) {
    const app = express();
    app.use(createFileServiceUploadRouter(module));
    const server = http.createServer(app);
    await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
        return await fn(origin);
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}
async function postMultipart(input) {
    return new Promise((resolve, reject) => {
        const url = new URL(input.url);
        const req = http.request({
            method: "POST",
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            headers: {
                "Content-Type": input.content_type,
                "Content-Length": input.body.length,
                ...(input.token ? { "X-Xpell-Upload-Token": input.token } : {})
            }
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                resolve({
                    status: res.statusCode ?? 0,
                    json: raw ? JSON.parse(raw) : null
                });
            });
        });
        req.on("error", reject);
        req.end(input.body);
    });
}
function canonicalFileRef(overrides = {}) {
    return {
        _type: "xpell-file-ref",
        _version: 1,
        _id: "file_00000000000000000000000000000001",
        _scope: "temp",
        _app_id: "pc-10",
        _env: "default",
        _filename: "yogurt.jpg",
        _mime_type: "image/jpeg",
        _size_bytes: JPEG_BYTES.length,
        _sha256: createHash("sha256").update(JPEG_BYTES).digest("hex"),
        _created_at: new Date().toISOString(),
        _expires_at: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}
function uploadDescriptor(overrides = {}) {
    return {
        _type: "xpell-file-upload-slot",
        _version: 1,
        _upload_id: "upl_00000000000000000000000000000001",
        _url: "/file-service/upload/upl_00000000000000000000000000000001",
        _method: "POST",
        _field: "file",
        _headers: {
            "X-Xpell-Upload-Token": "xfs_secret"
        },
        _scope: "temp",
        _app_id: "pc-10",
        _env: "default",
        _filename: "yogurt.jpg",
        _mime_type: "image/jpeg",
        _size_bytes: JPEG_BYTES.length,
        _max_size_bytes: DEFAULT_MAX_IMAGE_BYTES,
        _expires_at: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}
async function test_file_client_contract_and_registration() {
    const client = createFileClientModule({
        _send_xcmd: async () => ({ upload: uploadDescriptor() })
    });
    assert.equal(client._name, FILE_CLIENT_MODULE_ID);
    assert.equal(FileClientModule._name, FILE_CLIENT_MODULE_ID);
    assert.ok(FileClientModule._ops.upload);
    assert.equal(FileClientModule._skill._type, "client-module-api");
    assert.equal(FileClientModule._skill._runtime._target, "client");
    assert.deepEqual(FileClientModule._skill._capabilities._accepted_mime_types, ["image/jpeg", "image/png", "image/webp", "text/csv", "application/csv", "application/vnd.ms-excel", "application/pdf"]);
    assert.deepEqual(FileClientModule._skill._capabilities._accepted_image_mime_types, ["image/jpeg", "image/png", "image/webp"]);
    assert.deepEqual(FileClientModule._skill._capabilities._scopes, ["temp", "app"]);
    assert.equal(FileClientModule._skill._capabilities._server_dependency, "file-service");
    const modules = _x._modules ?? {};
    const previous = modules[FILE_CLIENT_MODULE_ID];
    delete modules[FILE_CLIENT_MODULE_ID];
    try {
        await _x.loadModuleAsync(client);
        assert.equal(_x.getModule(FILE_CLIENT_MODULE_ID), client);
        assert.ok(JSON.stringify(_x.getSkills()).includes(FILE_CLIENT_MODULE_ID));
    }
    finally {
        if (previous) {
            modules[FILE_CLIENT_MODULE_ID] = previous;
        }
        else {
            delete modules[FILE_CLIENT_MODULE_ID];
        }
    }
}
async function test_file_client_upload_calls_create_upload_and_posts_multipart() {
    const file_ref = canonicalFileRef();
    const send_commands = [];
    const fetch_calls = [];
    const client = createFileClientModule({
        _send_xcmd: async (cmd) => {
            send_commands.push(cmd);
            return {
                _ok: true,
                _result: {
                    upload: uploadDescriptor()
                }
            };
        },
        _fetch: async (url, init) => {
            fetch_calls.push({ url, init });
            const form = init?.body;
            const uploaded = form.get("file");
            assert.equal(uploaded.name, "yogurt.jpg");
            assert.equal(uploaded.type, "image/jpeg");
            assert.equal(Buffer.from(await uploaded.arrayBuffer()).equals(JPEG_BYTES), true);
            assert.equal(init?.headers?.["X-Xpell-Upload-Token"], "xfs_secret");
            return {
                ok: true,
                status: 201,
                json: async () => ({
                    _ok: true,
                    _result: {
                        file_ref
                    }
                })
            };
        }
    });
    const handle = client.registerFile(makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg"));
    const result = assertOk(await client._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: handle,
            _auth: { _authenticated: true }
        }
    }));
    assert.deepEqual(result.file_ref, file_ref);
    assert.equal(send_commands.length, 1);
    assert.deepEqual(send_commands[0], {
        _module: "file-service",
        _op: "create-upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _filename: "yogurt.jpg",
            _mime_type: "image/jpeg",
            _size_bytes: JPEG_BYTES.length
        }
    });
    assert.equal(fetch_calls.length, 1);
    assert.equal(fetch_calls[0].url, "/file-service/upload/upl_00000000000000000000000000000001");
    assert.equal(fetch_calls[0].init._xpell_opaque_upload_url, true);
    assert.equal(client.getStatus()._state, "completed");
}
async function test_file_client_upload_supports_image_types_and_scopes() {
    const cases = [
        { bytes: JPEG_BYTES, name: "photo.jpg", type: "image/jpeg", scope: "temp" },
        { bytes: PNG_BYTES, name: "photo.png", type: "image/png", scope: "app" },
        { bytes: WEBP_BYTES, name: "photo.webp", type: "image/webp", scope: "temp" },
        { bytes: CSV_BYTES, name: "ledger.csv", type: "text/csv", scope: "app" },
        { bytes: CSV_BYTES, name: "ledger.csv", type: "application/csv", scope: "temp" },
        { bytes: CSV_BYTES, name: "ledger.csv", type: "application/vnd.ms-excel", scope: "temp" },
        { bytes: CSV_BYTES, name: "ledger.csv", type: "", scope: "app", expected: "text/csv" },
        { bytes: PDF_BYTES, name: "decision.pdf", type: "application/pdf", scope: "app" }
    ];
    for (const item of cases) {
        const send_commands = [];
        const client = createFileClientModule({
            _send_xcmd: async (cmd) => {
                send_commands.push(cmd);
                return {
                    upload: uploadDescriptor({
                        _scope: item.scope,
                        _filename: item.name,
                        _mime_type: item.type,
                        _size_bytes: item.bytes.length
                    })
                };
            },
            _fetch: async () => ({
                ok: true,
                status: 201,
                json: async () => ({
                    _ok: true,
                    _result: {
                        file_ref: canonicalFileRef({
                            _scope: item.scope,
                            _filename: item.name,
                            _mime_type: (item.expected ?? item.type),
                            _size_bytes: item.bytes.length
                        })
                    }
                })
            })
        });
        const file = makeBrowserFile(item.bytes, item.name, item.type);
        const result = assertOk(await client.uploadFile({
            _app_id: "pc-10",
            _env: "default",
            _scope: item.scope,
            _file: file
        }));
        assert.equal(result.file_ref._mime_type, item.expected ?? item.type);
        assert.equal(result.file_ref._scope, item.scope);
        assert.equal(send_commands[0]._params._filename, item.name);
        assert.equal(send_commands[0]._params._mime_type, item.expected ?? item.type);
        assert.equal(send_commands[0]._params._scope, item.scope);
    }
}
async function test_file_client_failure_modes() {
    const client = createFileClientModule({
        _send_xcmd: async () => ({ upload: uploadDescriptor() }),
        _fetch: async () => ({
            ok: true,
            status: 201,
            json: async () => ({
                _ok: true,
                _result: { file_ref: canonicalFileRef() }
            })
        })
    });
    assertErr(await client._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file: makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg")
        }
    }), "E_FILE_CLIENT_INVALID_FILE");
    assertErr(await client._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: "missing"
        }
    }), "E_FILE_CLIENT_FILE_HANDLE_NOT_FOUND");
    const bad_handle = client.registerFile(makeBrowserFile(Buffer.from("gif"), "bad.gif", "image/gif"));
    assertErr(await client._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: bad_handle
        }
    }), "E_FILE_CLIENT_UNSUPPORTED_MIME");
    const failing_create = createFileClientModule({
        _send_xcmd: async () => ({
            _ok: false,
            _result: {
                _code: "E_UPLOAD_AUTH_REQUIRED",
                message: "Authenticated runtime context is required"
            }
        }),
        _fetch: async () => {
            throw new Error("fetch should not run");
        }
    });
    const create_handle = failing_create.registerFile(makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg"));
    const create_failure = await failing_create._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: create_handle
        }
    });
    assertErr(create_failure, "E_FILE_CLIENT_CREATE_UPLOAD_FAILED");
    assert.notEqual(create_failure._result.message, "[object Object]");
    const http_failure = createFileClientModule({
        _send_xcmd: async () => ({ upload: uploadDescriptor() }),
        _fetch: async () => ({
            ok: false,
            status: 410,
            json: async () => ({
                _ok: false,
                _result: {
                    _code: "E_UPLOAD_SLOT_EXPIRED",
                    _message: "Upload slot has expired"
                }
            })
        })
    });
    const http_handle = http_failure.registerFile(makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg"));
    assertErr(await http_failure._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: http_handle
        }
    }), "E_FILE_CLIENT_MULTIPART_FAILED");
    const malformed = createFileClientModule({
        _send_xcmd: async () => ({ upload: uploadDescriptor() }),
        _fetch: async () => ({
            ok: true,
            status: 201,
            json: async () => ({
                _ok: true,
                _result: {
                    file_ref: {
                        _type: "other"
                    }
                }
            })
        })
    });
    const malformed_handle = malformed.registerFile(makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg"));
    assertErr(await malformed._upload({
        _module: "file-client",
        _op: "upload",
        _params: {
            _app_id: "pc-10",
            _env: "default",
            _scope: "temp",
            _file_handle: malformed_handle
        }
    }), "E_FILE_CLIENT_MALFORMED_RESPONSE");
}
async function test_file_client_end_to_end_upload_proof() {
    await withWorkFolder(async (work_folder) => {
        const server_module = await createReadyModule(work_folder);
        await withUploadServer(server_module, async (origin) => {
            const client = createFileClientModule({
                _send_xcmd: async (cmd) => {
                    return server_module._create_upload({
                        _module: cmd._module,
                        _op: cmd._op,
                        _params: cmd._params,
                        _ctx: AUTH_CTX
                    });
                },
                _resolve_upload_url: (url) => `${origin}${url}`
            });
            const result = assertOk(await client.uploadFile({
                _app_id: "pc-10",
                _env: "default",
                _scope: "temp",
                _file: makeBrowserFile(JPEG_BYTES, "yogurt.jpg", "image/jpeg")
            }));
            const file_ref = result.file_ref;
            assert.equal(file_ref._type, "xpell-file-ref");
            assert.ok(!("_path" in file_ref));
            const resolved = await server_module.resolveTrusted(file_ref, {
                _app_id: "pc-10",
                _env: "default",
                _accepted_mime_types: ["image/jpeg"]
            });
            assert.equal((await readFile(resolved._absolute_path)).equals(JPEG_BYTES), true);
        });
    });
}
async function test_contract_and_capabilities() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        assert.equal(module._name, FILE_SERVICE_MODULE_ID);
        assert.equal(FileServiceModule._name, FILE_SERVICE_MODULE_ID);
        assert.ok(FileServiceModule._ops["get-capabilities"]);
        assert.equal(FileServiceModule._skill._type, "server-module-api");
        const readiness = module.get_readiness();
        assert.equal(readiness._ready, true);
        assert.equal(readiness._status, "ready");
        const capabilities = assertOk(await module._get_capabilities({ _module: "file-service", _op: "get-capabilities", _params: {} }));
        assert.deepEqual(capabilities._scopes, ["temp", "app"]);
        assert.deepEqual(capabilities._mime_types, ["image/jpeg", "image/png", "image/webp", "text/csv", "application/csv", "application/vnd.ms-excel", "application/pdf"]);
        assert.deepEqual(capabilities._image_mime_types, ["image/jpeg", "image/png", "image/webp"]);
        assert.equal(capabilities._max_upload_bytes, DEFAULT_MAX_IMAGE_BYTES);
        assert.equal(capabilities._transport._multipart_upload, true);
        assert.equal(capabilities._transport._upload_slots, true);
        assert.equal(capabilities._transport._x_execute_raw_bytes, false);
    });
}
async function test_create_upload_requires_auth() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        assertErr(await module._create_upload(uploadCommand(createUploadParams(), null)), "E_UPLOAD_AUTH_REQUIRED");
        assertErr(await module._create_upload(uploadCommand({
            ...createUploadParams(),
            _auth: { _authenticated: true }
        }, null)), "E_UPLOAD_AUTH_REQUIRED");
    });
}
async function test_create_upload_slot_contract() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const result = assertOk(await module._create_upload(uploadCommand(createUploadParams())));
        const upload = result.upload;
        assert.equal(upload._type, "xpell-file-upload-slot");
        assert.equal(upload._version, 1);
        assert.match(upload._upload_id, /^upl_[a-f0-9]{32}$/);
        assert.equal(upload._url, `/file-service/upload/${upload._upload_id}`);
        assert.equal(upload._method, "POST");
        assert.equal(upload._field, "file");
        assert.match(upload._headers["X-Xpell-Upload-Token"], /^xfs_/);
        assert.equal(upload._scope, "temp");
        assert.equal(upload._app_id, "pc-10");
        assert.equal(upload._env, "default");
        assert.equal(upload._filename, "yogurt.jpg");
        assert.equal(upload._mime_type, "image/jpeg");
        assert.equal(upload._size_bytes, JPEG_BYTES.length);
        assert.equal(upload._max_size_bytes, DEFAULT_MAX_IMAGE_BYTES);
        assert.ok(Date.parse(upload._expires_at) > Date.now());
        assert.ok(!("_path" in upload));
        assert.ok(!("_token_hash" in upload));
    });
}
async function test_create_upload_validates_input() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder, { _max_image_bytes: 4 });
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _mime_type: "image/gif" }))), "E_UNSUPPORTED_MIME_TYPE");
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _size_bytes: 5 }))), "E_FILE_TOO_LARGE");
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _scope: "global" }))), "E_INVALID_PARAMS");
    });
}
async function test_http_multipart_upload_success() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        const multipart = createMultipartBody({ bytes: JPEG_BYTES });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(response.status, 201, JSON.stringify(response.json));
            assert.equal(response.json._ok, true);
            const file_ref = response.json._result.file_ref;
            assert.equal(file_ref._type, "xpell-file-ref");
            assert.equal(file_ref._version, 1);
            assert.equal(file_ref._scope, "temp");
            assert.equal(file_ref._app_id, "pc-10");
            assert.equal(file_ref._env, "default");
            assert.equal(file_ref._filename, "yogurt.jpg");
            assert.equal(file_ref._mime_type, "image/jpeg");
            assert.equal(file_ref._size_bytes, JPEG_BYTES.length);
            assert.equal(file_ref._sha256, createHash("sha256").update(JPEG_BYTES).digest("hex"));
            assert.ok(!("_path" in file_ref));
            const metadata = assertOk(await module._get_metadata({
                _module: "file-service",
                _op: "get-metadata",
                _params: { _app_id: "pc-10", _env: "default", file_ref }
            }));
            assert.deepEqual(metadata.file_ref, file_ref);
            const replay = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(replay.status, 404);
            assert.equal(replay.json._result._code, "E_UPLOAD_SLOT_NOT_FOUND");
        });
    });
}
async function test_http_multipart_upload_app_scope_success() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams({
            _scope: "app",
            _filename: "retained.png",
            _mime_type: "image/png",
            _size_bytes: PNG_BYTES.length
        })))).upload;
        const multipart = createMultipartBody({
            filename: "retained.png",
            mime_type: "image/png",
            bytes: PNG_BYTES
        });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(response.status, 201, JSON.stringify(response.json));
            assert.equal(response.json._result.file_ref._scope, "app");
            assert.ok(!response.json._result.file_ref._expires_at);
        });
    });
}
async function test_http_multipart_upload_csv_and_pdf_success() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const legacy_csv = legacyCsvWithNulPadding();
        const cases = [
            { filename: "ledger.csv", mime_type: "text/csv", bytes: CSV_BYTES },
            { filename: "legacy.csv", mime_type: "application/csv", bytes: CSV_BYTES },
            { filename: "legacy-padded.csv", mime_type: "text/csv", bytes: legacy_csv },
            { filename: "excel.csv", mime_type: "application/vnd.ms-excel", bytes: CSV_BYTES },
            { filename: "decision.pdf", mime_type: "application/pdf", bytes: PDF_BYTES }
        ];
        await withUploadServer(module, async (origin) => {
            for (const item of cases) {
                const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams({
                    _scope: "app",
                    _filename: item.filename,
                    _mime_type: item.mime_type,
                    _size_bytes: item.bytes.length
                })))).upload;
                const multipart = createMultipartBody({
                    filename: item.filename,
                    mime_type: item.mime_type,
                    bytes: item.bytes
                });
                const response = await postMultipart({
                    url: `${origin}${upload._url}`,
                    token: upload._headers["X-Xpell-Upload-Token"],
                    body: multipart.body,
                    content_type: multipart.content_type
                });
                assert.equal(response.status, 201, JSON.stringify(response.json));
                const file_ref = response.json._result.file_ref;
                assert.equal(file_ref._type, "xpell-file-ref");
                assert.equal(file_ref._scope, "app");
                assert.equal(file_ref._filename, item.filename);
                assert.equal(file_ref._mime_type, item.mime_type);
                assert.ok(!("_path" in file_ref));
                const resolved = await module.resolveTrusted(file_ref, {
                    _app_id: "pc-10",
                    _env: "default",
                    _accepted_mime_types: [item.mime_type]
                });
                assert.equal((await readFile(resolved._absolute_path)).equals(item.bytes), true);
            }
        });
    });
}
async function test_upload_rejects_unsafe_file_types_and_mismatches() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _filename: "bad.gif", _mime_type: "image/gif" }))), "E_UNSUPPORTED_MIME_TYPE");
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _filename: "bad.js", _mime_type: "text/javascript" }))), "E_UNSUPPORTED_MIME_TYPE");
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _filename: "ledger.csv", _mime_type: "application/pdf" }))), "E_UNSUPPORTED_FILE_EXTENSION");
        assertErr(await module._create_upload(uploadCommand(createUploadParams({ _filename: "decision.pdf", _mime_type: "text/csv" }))), "E_UNSUPPORTED_FILE_EXTENSION");
        await withUploadServer(module, async (origin) => {
            const script_upload = assertOk(await module._create_upload(uploadCommand(createUploadParams({
                _filename: "script.csv",
                _mime_type: "text/csv",
                _size_bytes: SCRIPT_BYTES.length
            })))).upload;
            const script_multipart = createMultipartBody({
                filename: "script.csv",
                mime_type: "text/csv",
                bytes: SCRIPT_BYTES
            });
            const script_response = await postMultipart({
                url: `${origin}${script_upload._url}`,
                token: script_upload._headers["X-Xpell-Upload-Token"],
                body: script_multipart.body,
                content_type: script_multipart.content_type
            });
            assert.equal(script_response.status, 400);
            assert.equal(script_response.json._result._code, "E_FILE_INVALID_BYTES");
            const pdf_upload = assertOk(await module._create_upload(uploadCommand(createUploadParams({
                _filename: "decision.pdf",
                _mime_type: "application/pdf",
                _size_bytes: CSV_BYTES.length
            })))).upload;
            const pdf_multipart = createMultipartBody({
                filename: "decision.pdf",
                mime_type: "application/pdf",
                bytes: CSV_BYTES
            });
            const pdf_response = await postMultipart({
                url: `${origin}${pdf_upload._url}`,
                token: pdf_upload._headers["X-Xpell-Upload-Token"],
                body: pdf_multipart.body,
                content_type: pdf_multipart.content_type
            });
            assert.equal(pdf_response.status, 400);
            assert.equal(pdf_response.json._result._code, "E_FILE_INVALID_BYTES");
        });
    });
}
async function test_upload_sanitizes_path_traversal_filename() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams({
            _filename: "../ledger.csv",
            _mime_type: "text/csv",
            _size_bytes: CSV_BYTES.length
        })))).upload;
        assert.equal(upload._filename, "ledger.csv");
        const multipart = createMultipartBody({
            filename: "../../unsafe.csv",
            mime_type: "text/csv",
            bytes: CSV_BYTES
        });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(response.status, 201, JSON.stringify(response.json));
            const file_ref = response.json._result.file_ref;
            assert.equal(file_ref._filename, "unsafe.csv");
            assert.equal(JSON.stringify(file_ref).includes(".."), false);
            assert.ok(!("_absolute_path" in file_ref));
        });
    });
}
async function test_http_multipart_upload_rejects_missing_or_wrong_token() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        const multipart = createMultipartBody({ bytes: JPEG_BYTES });
        await withUploadServer(module, async (origin) => {
            const missing = await postMultipart({
                url: `${origin}${upload._url}`,
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(missing.status, 401);
            assert.equal(missing.json._result._code, "E_UPLOAD_AUTH_REQUIRED");
            const wrong = await postMultipart({
                url: `${origin}${upload._url}`,
                token: "xfs_wrong",
                body: multipart.body,
                content_type: multipart.content_type
            });
            assert.equal(wrong.status, 401);
            assert.equal(wrong.json._result._code, "E_UPLOAD_TOKEN_INVALID");
        });
    });
}
async function test_http_multipart_upload_rejects_invalid_multipart() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: Buffer.from("not multipart"),
                content_type: "text/plain"
            });
            assert.equal(response.status, 400);
            assert.equal(response.json._result._code, "E_UPLOAD_INVALID_MULTIPART");
        });
    });
}
async function test_http_multipart_upload_rejects_mime_and_size_mismatch() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        const mime_mismatch = createMultipartBody({
            filename: "yogurt.png",
            mime_type: "image/png",
            bytes: JPEG_BYTES
        });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: mime_mismatch.body,
                content_type: mime_mismatch.content_type
            });
            assert.equal(response.status, 400);
            assert.equal(response.json._result._code, "E_UNSUPPORTED_MIME_TYPE");
        });
        const size_upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        const size_mismatch = createMultipartBody({
            bytes: Buffer.concat([JPEG_BYTES, Buffer.from([0x00])])
        });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${size_upload._url}`,
                token: size_upload._headers["X-Xpell-Upload-Token"],
                body: size_mismatch.body,
                content_type: size_mismatch.content_type
            });
            assert.equal(response.status, 400);
            assert.equal(response.json._result._code, "E_INVALID_PARAMS");
        });
    });
}
async function test_http_multipart_upload_rejects_oversize_body() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const upload = assertOk(await module._create_upload(uploadCommand(createUploadParams()))).upload;
        const oversize = createMultipartBody({
            bytes: Buffer.concat([JPEG_BYTES, Buffer.alloc(70 * 1024)])
        });
        await withUploadServer(module, async (origin) => {
            const response = await postMultipart({
                url: `${origin}${upload._url}`,
                token: upload._headers["X-Xpell-Upload-Token"],
                body: oversize.body,
                content_type: oversize.content_type
            });
            assert.equal(response.status, 413);
            assert.equal(response.json._result._code, "E_FILE_TOO_LARGE");
        });
    });
}
async function test_upload_success_metadata_and_no_path_leakage() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module);
        assert.equal(file_ref._type, "xpell-file-ref");
        assert.equal(file_ref._version, 1);
        assert.equal(file_ref._scope, "temp");
        assert.equal(file_ref._app_id, "pc-10");
        assert.equal(file_ref._env, "default");
        assert.equal(file_ref._filename, "yogurt.jpg");
        assert.equal(file_ref._mime_type, "image/jpeg");
        assert.equal(file_ref._size_bytes, JPEG_BYTES.length);
        assert.equal(file_ref._sha256, createHash("sha256").update(JPEG_BYTES).digest("hex"));
        assert.ok(!("_path" in file_ref));
        const result = assertOk(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "pc-10", _env: "default", file_ref }
        }));
        assert.deepEqual(result.file_ref, file_ref);
        assert.ok(!("_absolute_path" in result.file_ref));
    });
}
async function test_invalid_public_params() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        assertErr(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: null
        }), "E_INVALID_PARAMS");
        assertErr(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "pc-10", _env: "default" }
        }), "E_UNSUPPORTED_FILE_REF");
    });
}
async function test_image_validation() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const png = await storeImage(module, {
            _filename: "photo.png",
            _mime_type: "image/png",
            _bytes: PNG_BYTES
        });
        assert.equal(png._mime_type, "image/png");
        const webp = await storeImage(module, {
            _filename: "photo.webp",
            _mime_type: "image/webp",
            _bytes: WEBP_BYTES
        });
        assert.equal(webp._mime_type, "image/webp");
        await assert.rejects(() => storeImage(module, { _mime_type: "image/jpeg", _bytes: PNG_BYTES }), /File bytes do not match/);
        await assert.rejects(() => storeImage(module, { _mime_type: "image/gif" }), /Unsupported file MIME type/);
    });
}
async function test_file_validation_for_csv_and_pdf() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const csv = await module.storeTrustedBuffer({
            _scope: "temp",
            _app_id: "pc-10",
            _env: "default",
            _filename: "ledger.csv",
            _mime_type: "text/csv",
            _bytes: CSV_BYTES
        });
        assert.equal(csv._mime_type, "text/csv");
        const padded_csv_bytes = legacyCsvWithNulPadding();
        const padded_csv = await module.storeTrustedBuffer({
            _scope: "temp",
            _app_id: "pc-10",
            _env: "default",
            _filename: "legacy-padded.csv",
            _mime_type: "text/csv",
            _bytes: padded_csv_bytes
        });
        assert.equal(padded_csv._mime_type, "text/csv");
        assert.equal(padded_csv._sha256, createHash("sha256").update(padded_csv_bytes).digest("hex"));
        const resolved_padded = await module.resolveTrusted(padded_csv, {
            _app_id: "pc-10",
            _env: "default",
            _accepted_mime_types: ["text/csv"]
        });
        assert.equal((await readFile(resolved_padded._absolute_path)).equals(padded_csv_bytes), true, "legacy padded CSV source bytes remain immutable");
        const pdf = await module.storeTrustedBuffer({
            _scope: "temp",
            _app_id: "pc-10",
            _env: "default",
            _filename: "decision.pdf",
            _mime_type: "application/pdf",
            _bytes: PDF_BYTES
        });
        assert.equal(pdf._mime_type, "application/pdf");
        await assert.rejects(() => module.storeTrustedBuffer({ _scope: "temp", _app_id: "pc-10", _env: "default", _filename: "script.csv", _mime_type: "text/csv", _bytes: SCRIPT_BYTES }), /CSV upload bytes do not match/);
        await assert.rejects(() => module.storeTrustedBuffer({ _scope: "temp", _app_id: "pc-10", _env: "default", _filename: "binary.csv", _mime_type: "text/csv", _bytes: BINARY_NUL_CSV_BYTES }), /CSV upload contains binary null bytes/);
        await assert.rejects(() => module.storeTrustedBuffer({ _scope: "temp", _app_id: "pc-10", _env: "default", _filename: "not-pdf.pdf", _mime_type: "application/pdf", _bytes: CSV_BYTES }), /File bytes do not match/);
    });
}
async function test_oversize() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder, { _max_image_bytes: 4 });
        await assert.rejects(() => storeImage(module), /maximum allowed size/);
    });
}
async function test_temp_expiry_cleanup() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module, {
            _expires_at: new Date(Date.now() - 1000).toISOString()
        });
        const metadata = await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "pc-10", _env: "default", file_ref }
        });
        assertErr(metadata, "E_FILE_EXPIRED");
        const cleanup = await module.cleanupExpiredTempFiles(Date.now() + 60_000);
        assert.equal(cleanup._deleted, 0);
    });
}
async function test_delete_expired_temp_file() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module, {
            _expires_at: new Date(Date.now() - 1000).toISOString()
        });
        const deleted = assertOk(await module._delete({
            _module: "file-service",
            _op: "delete",
            _params: { _app_id: "pc-10", _env: "default", file_ref }
        }));
        assert.equal(deleted._deleted, true);
    });
}
async function test_app_ownership_and_cross_app_denial() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module);
        assertErr(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "other-app", _env: "default", file_ref }
        }), "E_PERMISSION_DENIED");
        const forged = { ...file_ref, _app_id: "other-app" };
        assertErr(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "other-app", _env: "default", file_ref: forged }
        }), "E_NOT_FOUND");
    });
}
async function test_delete() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module);
        const resolved = await module.resolveTrusted(file_ref, {
            _app_id: "pc-10",
            _env: "default"
        });
        assert.ok((await stat(resolved._absolute_path)).isFile());
        const deleted = assertOk(await module._delete({
            _module: "file-service",
            _op: "delete",
            _params: { _app_id: "pc-10", _env: "default", file_ref }
        }));
        assert.equal(deleted._deleted, true);
        await assert.rejects(() => stat(resolved._absolute_path));
    });
}
async function test_persistence_across_restart() {
    await withWorkFolder(async (work_folder) => {
        const first = await createReadyModule(work_folder);
        const file_ref = await storeImage(first);
        const restarted = await createReadyModule(work_folder);
        const result = assertOk(await restarted._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "pc-10", _env: "default", file_ref }
        }));
        assert.deepEqual(result.file_ref, file_ref);
    });
}
async function test_promote_temp_to_app() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const temp_ref = await storeImage(module);
        const promoted = assertOk(await module._promote({
            _module: "file-service",
            _op: "promote",
            _params: { _app_id: "pc-10", _env: "default", file_ref: temp_ref }
        }));
        assert.equal(promoted._source_deleted, true);
        assert.equal(promoted.file_ref._scope, "app");
        assert.equal(promoted.file_ref._app_id, temp_ref._app_id);
        assert.equal(promoted.file_ref._env, temp_ref._env);
        assert.equal(promoted.file_ref._mime_type, temp_ref._mime_type);
        assert.equal(promoted.file_ref._sha256, temp_ref._sha256);
        assert.ok(!promoted.file_ref._expires_at);
        assertErr(await module._get_metadata({
            _module: "file-service",
            _op: "get-metadata",
            _params: { _app_id: "pc-10", _env: "default", file_ref: temp_ref }
        }), "E_NOT_FOUND");
    });
}
async function test_safe_server_resolution() {
    await withWorkFolder(async (work_folder) => {
        const module = await createReadyModule(work_folder);
        const file_ref = await storeImage(module);
        const resolved = await module.resolveTrusted(file_ref, {
            _app_id: "pc-10",
            _env: "default",
            _accepted_mime_types: ["image/jpeg"],
            _max_size_bytes: DEFAULT_MAX_IMAGE_BYTES
        });
        assert.equal(resolved._type, "xpell-resolved-file");
        assert.ok(resolved._absolute_path.startsWith(path.resolve(work_folder, "files") + path.sep));
        assert.equal((await readFile(resolved._absolute_path)).equals(JPEG_BYTES), true);
        await assert.rejects(() => module.resolveTrusted(file_ref, {
            _app_id: "pc-10",
            _env: "default",
            _accepted_mime_types: ["image/png"]
        }), /not accepted/);
    });
}
async function test_safe_path_resolution() {
    await withWorkFolder(async (work_folder) => {
        const store = new XpellFileStore({ _work_folder: work_folder });
        await store.init();
        assert.throws(() => store.safeResolveUnderRoot("..", "escape"), /escapes/);
    });
}
async function test_runtime_registration_and_execute() {
    await withWorkFolder(async (work_folder) => {
        const modules = _x._modules ?? {};
        const previous = modules[FILE_SERVICE_MODULE_ID];
        delete modules[FILE_SERVICE_MODULE_ID];
        try {
            const module = await createReadyModule(work_folder);
            await _x.loadModuleAsync(module);
            const response = await _x.execute({
                _module: FILE_SERVICE_MODULE_ID,
                _op: "get-capabilities",
                _params: {}
            });
            assert.equal(response._ok, true);
            const skills = _x.getSkills?.();
            assert.ok(!skills || JSON.stringify(skills).includes(FILE_SERVICE_MODULE_ID));
        }
        finally {
            if (previous) {
                modules[FILE_SERVICE_MODULE_ID] = previous;
            }
            else {
                delete modules[FILE_SERVICE_MODULE_ID];
            }
        }
    });
}
async function run() {
    await test_file_client_contract_and_registration();
    await test_file_client_upload_calls_create_upload_and_posts_multipart();
    await test_file_client_upload_supports_image_types_and_scopes();
    await test_file_client_failure_modes();
    await test_file_client_end_to_end_upload_proof();
    await test_contract_and_capabilities();
    await test_create_upload_requires_auth();
    await test_create_upload_slot_contract();
    await test_create_upload_validates_input();
    await test_http_multipart_upload_success();
    await test_http_multipart_upload_app_scope_success();
    await test_http_multipart_upload_csv_and_pdf_success();
    await test_upload_rejects_unsafe_file_types_and_mismatches();
    await test_upload_sanitizes_path_traversal_filename();
    await test_http_multipart_upload_rejects_missing_or_wrong_token();
    await test_http_multipart_upload_rejects_invalid_multipart();
    await test_http_multipart_upload_rejects_mime_and_size_mismatch();
    await test_http_multipart_upload_rejects_oversize_body();
    await test_upload_success_metadata_and_no_path_leakage();
    await test_invalid_public_params();
    await test_image_validation();
    await test_file_validation_for_csv_and_pdf();
    await test_oversize();
    await test_temp_expiry_cleanup();
    await test_delete_expired_temp_file();
    await test_app_ownership_and_cross_app_denial();
    await test_delete();
    await test_persistence_across_restart();
    await test_promote_temp_to_app();
    await test_safe_server_resolution();
    await test_safe_path_resolution();
    await test_runtime_registration_and_execute();
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
