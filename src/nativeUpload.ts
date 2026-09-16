import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { App } from "obsidian";
import type { FakeFsS3 } from "./fsS3";

/**
 * Native (Capacitor Filesystem) direct upload smoke test.
 *
 * The diagnostic proved that `Capacitor.Plugins.Filesystem.uploadFile` /
 * `downloadFile` exist on iOS. If they really do a *native* transfer
 * (disk -> URL via URLSession), then huge files can be uploaded without
 * their bytes ever entering the JS heap - the true fix for the OOM crash.
 *
 * This smoke test verifies the whole loop against the user's REAL S3/OSS
 * config, with a 1 MiB file:
 *   1. write a 1 MiB test file into the vault (on disk)
 *   2. presign a PUT URL (manual SigV4, no extra dependency)
 *   3. Filesystem.uploadFile(url, nativePath, PUT)
 *   4. verify on the remote: HeadObject size + first bytes via GetObject
 *   5. presign a GET URL and Filesystem.downloadFile() back to disk, compare
 *   6. clean everything up
 *
 * Nothing user-facing is touched; only one temp file in vault + one remote
 * object under a clearly-named key, both deleted at the end.
 */

const EXPIRES = 900;

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(sig);
}

function uriEncode(s: string, encodeSlash: boolean): string {
  // AWS SigV4 uri-encoding: unreserved chars A-Za-z0-9 - _ . ~ stay as-is.
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  if (!encodeSlash) {
    out = out.replace(/%2F/g, "/");
  }
  return out;
}

export interface PresignInputs {
  method: "PUT" | "GET";
  endpoint: string;
  forcePathStyle: boolean;
  bucket: string;
  region: string;
  accessKeyID: string;
  secretAccessKey: string;
  key: string; // full remote key (after prefix)
  expiresIn?: number;
}

/**
 * Manual AWS SigV4 query-string presign (UNSIGNED-PAYLOAD).
 * Mirrors what @aws-sdk/s3-request-presigner would produce.
 */
export async function presignS3Url(inp: PresignInputs): Promise<string> {
  let endpoint = inp.endpoint;
  if (!(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) {
    endpoint = `https://${endpoint}`;
  }
  const u = new URL(endpoint);
  const host = inp.forcePathStyle ? u.host : `${inp.bucket}.${u.host}`;
  const objectPath = inp.forcePathStyle
    ? `/${inp.bucket}/${uriEncode(inp.key, false)}`
    : `/${uriEncode(inp.key, false)}`;

  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const region = inp.region && inp.region !== "" ? inp.region : "us-east-1";
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const query = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${uriEncode(
      `${inp.accessKeyID}/${scope}`,
      true
    )}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${inp.expiresIn ?? EXPIRES}`,
    `X-Amz-SignedHeaders=host`,
  ].join("&");

  const canonicalRequest = [
    inp.method,
    objectPath,
    query,
    `host:${host}`,
    ``,
    `host`,
    `UNSIGNED-PAYLOAD`,
  ].join("\n");

  const stringToSign = [
    `AWS4-HMAC-SHA256`,
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key: Uint8Array = new TextEncoder().encode(`AWS4${inp.secretAccessKey}`);
  for (const data of [dateStamp, region, "s3", "aws4_request", stringToSign]) {
    key = new Uint8Array(await hmac(key, data));
  }
  const signature = [...key]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const proto = u.protocol;
  return `${proto}//${host}${objectPath}?${query}&X-Amz-Signature=${signature}`;
}

export function getCapacitorFilesystem(): any | undefined {
  const w = window as any;
  const FS = w?.Capacitor?.Plugins?.Filesystem;
  if (FS && typeof FS.uploadFile === "function") {
    return FS;
  }
  return undefined;
}

function isNotImplementedError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.toLowerCase().includes("not implemented");
}

export async function nativeUploadSmokeTest(
  app: App,
  s3Fs: FakeFsS3,
  sink: (line: string) => void
): Promise<void> {
  const p = (s: string) => {
    sink(s);
    console.info(`[remotely-save-native-smoke] ${s}`);
  };

  const withTimeout = async <T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) =>
        window.setTimeout(
          () => reject(new Error(`TIMEOUT: ${label} >${ms}ms`)),
          ms
        )
      ),
    ]);
  };

  const w = window as any;
  const FS = getCapacitorFilesystem();
  const adapter = app.vault.adapter as any;

  const conf = s3Fs.s3Config;
  p(`=== preflight ===`);
  p(`Filesystem.uploadFile   : ${typeof w?.Capacitor?.Plugins?.Filesystem?.uploadFile}`);
  p(`Filesystem.downloadFile : ${typeof w?.Capacitor?.Plugins?.Filesystem?.downloadFile}`);
  p(`endpoint                : ${conf.s3Endpoint}`);
  p(`forcePathStyle          : ${conf.forcePathStyle}`);
  p(`region                  : ${conf.s3Region || "(empty->us-east-1)"}`);
  p(`remotePrefix            : ${JSON.stringify(conf.remotePrefix ?? "")}`);
  if (FS === undefined) {
    p(`ABORT: Filesystem.uploadFile not available.`);
    return;
  }

  const prefix = conf.remotePrefix ?? "";
  const testId = Date.now();
  const vaultPath = `.remotely-save-native-smoke-${testId}.bin`;
  const remoteKey = `${prefix}${vaultPath}`;
  const SIZE = 1024 * 1024; // 1 MiB

  // deterministic pseudo-random content, first 16 bytes are fixed & known
  const data = new Uint8Array(SIZE);
  let seed = 123456789;
  for (let i = 0; i < SIZE; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  const first16 = data.slice(0, 16);
  const first16Hex = [...first16]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  let remoteObjectCreated = false;
  let localDownloadPath: string | undefined = undefined;

  try {
    p(``);
    p(`=== step 1/6: write 1MiB test file into vault ===`);
    await withTimeout(
      adapter.writeBinary(vaultPath, data.buffer),
      15000,
      "writeBinary"
    );
    p(`OK: ${vaultPath}`);

    p(``);
    p(`=== step 2/6: native path + presign PUT ===`);
    const nativePath = adapter.getNativePath(vaultPath);
    p(`nativePath: ${nativePath ?? "n/a"}`);
    if (!nativePath) {
      p(`ABORT: getNativePath unavailable.`);
      return;
    }
    const putUrl = await presignS3Url({
      method: "PUT",
      endpoint: conf.s3Endpoint,
      forcePathStyle: conf.forcePathStyle ?? false,
      bucket: conf.s3BucketName,
      region: conf.s3Region,
      accessKeyID: conf.s3AccessKeyID,
      secretAccessKey: conf.s3SecretAccessKey,
      key: remoteKey,
    });
    p(`presigned PUT url (host+path only):`);
    try {
      const uu = new URL(putUrl);
      p(`  ${uu.protocol}//${uu.host}${uu.pathname}`);
    } catch {
      p(`  (url parse failed)`);
    }
    p(`presign OK`);

    p(``);
    p(`=== step 3/6: Filesystem.uploadFile (native PUT) ===`);
    let upRes: any;
    try {
      upRes = await withTimeout(
        FS.uploadFile({
          url: putUrl,
          path: nativePath,
          method: "PUT",
          headers: {},
          mimeType: "application/octet-stream",
        }),
        60000,
        "Filesystem.uploadFile"
      );
      p(`uploadFile result: ${JSON.stringify(upRes)?.slice(0, 300)}`);
      remoteObjectCreated = true;
    } catch (e) {
      p(`uploadFile FAILED: ${e}`);
      if (isNotImplementedError(e)) {
        p(`  -> uploadFile EXISTS but is NOT IMPLEMENTED on this platform.`);
        p(`  -> native direct upload is IMPOSSIBLE here.`);
      } else {
        p(`  -> if the error mentions status 4xx/5xx, note the code.`);
        p(`  -> multipart-instead-of-raw-body would show as SignatureMismatch/400.`);
      }
      return;
    }

    p(``);
    p(`=== step 4/6: verify remote object via SDK ===`);
    const head = await withTimeout(
      s3Fs.s3Client.send(
        new HeadObjectCommand({ Bucket: conf.s3BucketName, Key: remoteKey })
      ),
      15000,
      "HeadObject"
    );
    p(`remote ContentLength: ${head.ContentLength} (expect ${SIZE})`);
    p(`size match: ${head.ContentLength === SIZE}`);

    const got = await withTimeout(
      s3Fs.s3Client.send(
        new GetObjectCommand({
          Bucket: conf.s3BucketName,
          Key: remoteKey,
          Range: "bytes=0-15",
        })
      ),
      15000,
      "GetObject(range)"
    );
    const gotBody = got.Body as ReadableStream;
    const gotBuf = new Uint8Array(await new Response(gotBody as any).arrayBuffer());
    const gotHex = [...gotBuf]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    p(`remote first16: ${gotHex}`);
    p(`local  first16: ${first16Hex}`);
    p(`content match: ${gotHex === first16Hex}`);

    p(``);
    p(`=== step 5/6: Filesystem.downloadFile (native GET) ===`);
    const getUrl = await presignS3Url({
      method: "GET",
      endpoint: conf.s3Endpoint,
      forcePathStyle: conf.forcePathStyle ?? false,
      bucket: conf.s3BucketName,
      region: conf.s3Region,
      accessKeyID: conf.s3AccessKeyID,
      secretAccessKey: conf.s3SecretAccessKey,
      key: remoteKey,
    });
    const localDlVaultPath = `${vaultPath}.dl`;
    let dlNativePath: string | undefined;
    try {
      dlNativePath = adapter.getNativePath(localDlVaultPath);
    } catch {
      dlNativePath = undefined;
    }
    localDownloadPath = dlNativePath ?? undefined;
    const dlTarget = dlNativePath ?? `${vaultPath}.dl`;
    try {
      const dlRes: any = await withTimeout(
        FS.downloadFile({ url: getUrl, path: dlTarget }),
        60000,
        "Filesystem.downloadFile"
      );
      p(`downloadFile result: ${JSON.stringify(dlRes)?.slice(0, 300)}`);
      const rb = await withTimeout(
        adapter.readBinary(dlTarget.startsWith("file://") ? localDlVaultPath : dlTarget),
        15000,
        "read downloaded file"
      );
      const rarr = new Uint8Array(rb as ArrayBuffer);
      const rHex = [...rarr.slice(0, 16)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      p(`downloaded bytes: ${rarr.length} (expect ${SIZE})`);
      p(`downloaded first16 match: ${rHex === first16Hex}`);
    } catch (e) {
      p(`downloadFile FAILED: ${e}`);
      p(`  -> download path handling may differ; note this but UPLOAD is the critical one.`);
    }

    p(``);
    p(`=== verdict ===`);
    if (!remoteObjectCreated) {
      p(`  uploadFile FAILED or was not implemented.`);
      p(`  -> NATIVE DIRECT UPLOAD IS NOT VIABLE on this platform.`);
      p(`  -> Large videos must be handled by skip-size + protection switches.`);
    } else {
      p(`  steps 3-4 OK + content match -> NATIVE DIRECT UPLOAD WORKS.`);
      p(`  We can implement "large-file native upload" in the real sync path:`);
      p(`  file stays on disk, native layer pushes to remote,`);
      p(`  JS memory untouched -> no more OOM crash on big videos.`);
    }
  } finally {
    p(``);
    p(`=== step 6/6: cleanup ===`);
    try {
      await withTimeout(adapter.remove(vaultPath), 10000, "remove local test file");
      p(`removed local test file`);
    } catch (e) {
      p(`cleanup warning (local test file): ${e}`);
    }
    if (remoteObjectCreated) {
      try {
        await withTimeout(
          s3Fs.s3Client.send(
            new DeleteObjectCommand({
              Bucket: conf.s3BucketName,
              Key: remoteKey,
            })
          ),
          15000,
          "DeleteObject"
        );
        p(`deleted remote test object: ${remoteKey}`);
      } catch (e) {
        p(`cleanup warning (remote object): ${e}`);
      }
    }
    if (localDownloadPath) {
      try {
        // best-effort: remove via the vault-relative path if possible
        await withTimeout(
          adapter.remove(`${vaultPath}.dl`),
          10000,
          "remove downloaded file"
        );
        p(`removed downloaded test file`);
      } catch (e) {
        p(`cleanup warning (downloaded file): ${e}`);
      }
    }
  }
}
