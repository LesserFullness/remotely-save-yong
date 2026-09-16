import { type App, Modal, Notice, Platform, getLanguage, moment } from "obsidian";

/**
 * Read-only diagnostic for the mobile file API.
 *
 * Goal: find out whether Obsidian's iOS/Android WebView exposes any way to
 * transfer a *large* local file WITHOUT first loading it entirely into JS
 * memory (the only real fix for uploading very large files without
 * OOM-killing the app).
 *
 *  - True ranged/streaming read via Capacitor Filesystem `readFile(offset,length)`
 *    would let us read the file in chunks. (Requires Capacitor 8.1.0+.)
 *  - A native `Filesystem.uploadFile(fileOnDisk -> URL)` would let us hand the
 *    native path straight to the remote (presigned URL), so the bytes never
 *    enter JS memory at all. THIS is the real fix if present.
 *
 * Results are streamed line-by-line to a modal, because on iOS there is no
 * devtools console. The modal is opened BEFORE the checks run, so the user
 * always gets visible output even if a step hangs or throws.
 */

type LineSink = (line: string) => void;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      window.setTimeout(
        () => reject(new Error(`TIMEOUT: ${label} did not answer within ${ms}ms`)),
        ms
      );
    }),
  ]);
}

function b64ByteLength(s: string): number {
  try {
    return atob(s).length;
  } catch {
    return -1;
  }
}

export async function runMobileFileApiDiagnostic(
  app: App,
  sink: LineSink
): Promise<void> {
  const p = (s: string) => {
    sink(s);
    console.info(`[remotely-save-diag] ${s}`);
  };

  p(`=== Obsidian / device ===`);
  p(`Platform.isMobile     : ${Platform.isMobile}`);
  p(`Platform.isIosApp     : ${Platform.isIosApp}`);
  p(`Platform.isAndroidApp : ${Platform.isAndroidApp}`);
  p(`typeof fetch          : ${typeof fetch}`);
  p(`typeof Blob           : ${typeof Blob}`);
  p(`typeof atob           : ${typeof atob}`);

  p(``);
  p(`=== Language / i18n ===`);
  p(
    `navigator.language      : ${
      typeof navigator !== "undefined" ? navigator.language : "n/a"
    }`
  );
  p(
    `localStorage["language"]: ${(() => {
      try {
        return `${window.localStorage.getItem("language")}`;
      } catch (e) {
        return `unreadable: ${e}`;
      }
    })()}`
  );
  p(
    `obsidian getLanguage()  : ${(() => {
      try {
        return typeof getLanguage === "function"
          ? getLanguage()
          : "n/a (needs obsidian >= 1.8.7)";
      } catch (e) {
        return `error: ${e}`;
      }
    })()}`
  );
  p(
    `moment.locale()         : ${(() => {
      try {
        return moment.locale();
      } catch (e) {
        return `error: ${e}`;
      }
    })()}`
  );
  p(`typeof streamingBody  : ${(() => {
    try {
      // Do NOT touch Response.prototype.body directly: on iOS the getter
      // throws "can only be used on instances of Response".
      const desc = Object.getOwnPropertyDescriptor(
        (Response as any)?.prototype ?? {},
        "body"
      );
      return typeof desc?.get === "function" ? "function (getter)" : "n/a";
    } catch {
      return "probe error";
    }
  })()} (ReadableStream -> streaming fetch)`);

  const w = window as any;

  p(``);
  p(`=== Capacitor ===`);
  p(`typeof window.Capacitor           : ${typeof w.Capacitor}`);
  if (w.Capacitor) {
    p(
      `  Capacitor.getPlatform()         : ${
        typeof w.Capacitor.getPlatform === "function"
          ? w.Capacitor.getPlatform()
          : "n/a"
      }`
    );
    p(
      `  Capacitor.isNativePlatform()    : ${
        typeof w.Capacitor.isNativePlatform === "function"
          ? String(w.Capacitor.isNativePlatform())
          : "n/a"
      }`
    );
    try {
      const plugins = w.Capacitor.Plugins ?? {};
      p(
        `  Capacitor.Plugins keys          : ${JSON.stringify(
          Object.keys(plugins)
        )}`
      );
    } catch (e) {
      p(`  Capacitor.Plugins keys error    : ${e}`);
    }
  }

  const FS = w.Capacitor?.Plugins?.Filesystem;

  p(``);
  p(`=== Capacitor Filesystem capabilities ===`);
  p(`Capacitor.Plugins.Filesystem      : ${typeof FS}`);

  const rangedReadAvailable = { value: false };
  const nativeUploadAvailable = { value: false };
  const nativeDownloadAvailable = { value: false };

  if (FS) {
    // Enumerate *every* method so we discover uploadFile/downloadFile etc.
    try {
      const names = Object.getOwnPropertyNames(FS).filter(
        (k) => typeof (FS as any)[k] === "function"
      );
      p(`  ALL FILESYSTEM METHODS          : ${names.join(", ")}`);
    } catch (e) {
      p(`  enumerate methods error         : ${e}`);
    }
    const probe = (name: string) => {
      const fn = (FS as any)[name];
      p(
        `  .${name.padEnd(18)} : ${typeof fn}${
          typeof fn === "function" ? ` (arity ${fn.length})` : ""
        }`
      );
    };
    [
      "readFile",
      "readFileInChunks",
      "writeFile",
      "appendFile",
      "stat",
      "getUri",
      "getNativeUri",
      "deleteFile",
      "mkdir",
      "uploadFile",
      "downloadFile",
      "getFilePath",
      "rename",
      "copy",
    ].forEach(probe);

    // nativePath is needed by both the ranged-read test and the
    // upload/download implementation probes below.
    let nativePath: string | undefined = undefined;

    p(``);
    p(`=== ranged-read correctness test (offset=56,length=8 on a 64-byte file) ===`);
    const testPath = `.remotely-save-diag-${Date.now()}.bin`;
    try {
      const buf = new Uint8Array(64);
      for (let i = 0; i < buf.length; i++) buf[i] = i;
      await withTimeout(
        app.vault.adapter.writeBinary(testPath, buf.buffer),
        8000,
        "writeBinary"
      );
      p(`wrote test file (64 bytes): ${testPath}`);

      try {
        nativePath = (app.vault.adapter as any).getNativePath?.(testPath);
      } catch (e) {
        p(`getNativePath error: ${e}`);
      }
      p(`nativePath: ${nativePath ?? "n/a"}`);

      if (FS && typeof FS.readFile === "function" && nativePath) {
        const res: any = await withTimeout(
          FS.readFile({ path: nativePath, offset: 56, length: 8 }),
          8000,
          "Filesystem.readFile(offset,length)"
        );
        const b64 = typeof res?.data === "string" ? res.data : "";
        const actual = b64ByteLength(b64);
        p(
          `readFile(offset=56,length=8) -> base64 length=${b64.length}, decoded=${actual} bytes`
        );
        if (actual === 8) {
          // Verify the content bytes are exactly 56..63.
          const dec = atob(b64);
          const correct = [...dec].every((c, i) => c.charCodeAt(0) === 56 + i);
          p(`  byte-content correct (56..63): ${correct}`);
          p(`  -> TRUE CHUNKED READ AVAILABLE`);
          rangedReadAvailable.value = true;
        } else if (actual === 64) {
          p(
            `  -> FALSE POSITIVE: offset/length IGNORED, full file returned (Capacitor < 8.1.0 behavior)`
          );
          p(`  -> CHUNKED READ NOT AVAILABLE`);
        } else {
          p(
            `  -> UNEXPECTED byte count ${actual}; cannot confirm chunked read`
          );
        }
      } else {
        p(
          `ranged read skipped (Filesystem=${typeof FS}, nativePath=${
            nativePath ? "ok" : "n/a"
          })`
        );
        p(`  -> CHUNKED READ NOT AVAILABLE via Capacitor Filesystem`);
      }
    } catch (e) {
      p(`test file error: ${e}`);
    } finally {
      try {
        await withTimeout(app.vault.adapter.remove(testPath), 5000, "remove");
      } catch (e) {
        p(`cleanup warning: ${e}`);
      }
    }

    p(``);
    p(`=== native upload/download probe (the real fix for large files) ===`);

    // Functions may exist as "unimplemented" stubs on some platforms
    // (e.g. iOS: "Filesystem.uploadFile() is not implemented on iOS").
    // We must actually call them to know whether they are real.
    async function probeUpload() {
      if (typeof FS.uploadFile !== "function") {
        p(`  uploadFile MISSING`);
        return;
      }
      p(`  uploadFile EXISTS -> probing implementation with a fake URL...`);
      try {
        p(`    signature: ${String(FS.uploadFile).slice(0, 200)}`);
      } catch {
        /* ignore */
      }
      const probePath = nativePath || "/dev/null/remotely-save-upload-probe";
      try {
        await withTimeout(
          FS.uploadFile({
            url: "http://127.0.0.1:9/remotely-save-upload-probe",
            path: probePath,
            method: "PUT",
            headers: {},
            mimeType: "application/octet-stream",
          }),
          4000,
          "uploadFile probe"
        );
        // It actually ran (network would have timed out, but the call itself
        // is implemented). This is unexpected with a fake URL.
        p(`    uploadFile probe did not throw "not implemented" -> IMPLEMENTED`);
        nativeUploadAvailable.value = true;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        p(`    uploadFile probe error: ${msg.slice(0, 120)}`);
        if (msg.toLowerCase().includes("not implemented")) {
          p(`    -> uploadFile is a STUB on this platform (NOT AVAILABLE)`);
        } else {
          p(`    -> uploadFile appears IMPLEMENTED (error is network/path related)`);
          nativeUploadAvailable.value = true;
        }
      }
    }

    async function probeDownload() {
      if (typeof FS.downloadFile !== "function") {
        p(`  downloadFile MISSING`);
        return;
      }
      p(`  downloadFile EXISTS -> probing implementation with a fake URL...`);
      const dlProbePath = nativePath || "/dev/null/remotely-save-download-probe";
      try {
        await withTimeout(
          FS.downloadFile({
            url: "http://127.0.0.1:9/remotely-save-download-probe",
            path: dlProbePath,
          }),
          4000,
          "downloadFile probe"
        );
        p(`    downloadFile probe did not throw "not implemented" -> IMPLEMENTED`);
        nativeDownloadAvailable.value = true;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        p(`    downloadFile probe error: ${msg.slice(0, 120)}`);
        if (msg.toLowerCase().includes("not implemented")) {
          p(`    -> downloadFile is a STUB on this platform (NOT AVAILABLE)`);
        } else {
          p(`    -> downloadFile appears IMPLEMENTED (error is network/path related)`);
          nativeDownloadAvailable.value = true;
        }
      }
    }

    await probeUpload();
    await probeDownload();
  }

  const adapter = app.vault.adapter as any;
  p(``);
  p(`=== vault adapter (Obsidian internal) ===`);
  p(`adapter ctor            : ${adapter?.constructor?.name}`);
  p(`adapter.getNativePath   : ${typeof adapter?.getNativePath}`);
  p(`adapter.appendBinary    : ${typeof adapter?.appendBinary}`);
  p(
    `adapter.fs              : ${typeof adapter?.fs}${
      adapter?.fs ? ` (${adapter.fs.constructor?.name})` : ""
    }`
  );
  p(`  adapter.fs.readBinary : ${typeof adapter?.fs?.readBinary}`);
  p(`  adapter.fs.getNativeUri: ${typeof adapter?.fs?.getNativeUri}`);

  p(``);
  p(`=== conclusion ===`);
  if (nativeUploadAvailable.value) {
    p(
      `NATIVE UPLOAD AVAILABLE -> we can hand the native file path to the remote`
    );
    p(`   (presigned URL) and let the native layer push the bytes. The file`);
    p(`   NEVER enters JS memory -> large videos upload WITHOUT the crash.`);
  } else if (rangedReadAvailable.value) {
    p(
      `RANGED READ AVAILABLE -> we can read the file in chunks in JS and do a`
    );
    p(`   chunked/multipart upload. Much lower memory, but still JS-side.`);
  } else {
    p(
      `NO STREAMING PATH on this platform -> large files must be skipped /`
    );
    p(`   synced another way. Use the skip-size threshold + the protection`);
    p(`   switches described earlier.`);
  }
  p(`nativeUploadImplemented   : ${nativeUploadAvailable.value}`);
  p(`nativeDownloadImplemented : ${nativeDownloadAvailable.value}`);
  p(`rangedReadImplemented       : ${rangedReadAvailable.value}`);
}

export class DiagnosticModal extends Modal {
  private pre!: HTMLPreElement;
  private title: string;

  constructor(app: App, title?: string) {
    super(app);
    this.title =
      title ?? "移动端文件 API 诊断 / Mobile file API diagnostic";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.title });
    this.pre = contentEl.createEl("pre");
    this.pre.setText("运行中… / running…");
    this.pre.style.whiteSpace = "pre-wrap";
    this.pre.style.userSelect = "text";
    this.pre.style.fontSize = "12px";
    contentEl.createEl("p", {
      text: "（可长按选中复制；也可在桌面上看控制台的日志。）",
    });
  }

  setText(text: string) {
    if (this.pre) {
      this.pre.setText(text);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Generic helper: opens a modal first, then streams lines produced by `run`
 * into it. Always gives visible output, even if `run` hangs step by step
 * (each step inside `run` should apply its own timeout).
 */
export async function showStreamingReport(
  app: App,
  title: string,
  run: (sink: LineSink) => Promise<void>
): Promise<void> {
  new Notice("诊断运行中… / running diagnostic…", 4000);

  const lines: string[] = [];
  let modal: DiagnosticModal | undefined = undefined;
  const render = () => {
    if (modal) {
      modal.setText(lines.join("\n") || "(no output)");
    }
  };

  try {
    modal = new DiagnosticModal(app, title);
    modal.open();
  } catch (e) {
    new Notice(`弹窗打开失败 / failed to open report: ${e}`, 15000);
    return;
  }

  const sink: LineSink = (line: string) => {
    lines.push(line);
    try {
      render();
    } catch (e) {
      /* ignore render errors */
    }
  };

  try {
    await run(sink);
  } catch (e) {
    sink(`FATAL ERROR: ${e}`);
  }
  render();
}

/**
 * Runs the mobile file API diagnostic and shows it in a modal.
 */
export async function showMobileFileApiDiagnostic(app: App): Promise<void> {
  await showStreamingReport(
    app,
    "移动端文件 API 诊断 / Mobile file API diagnostic",
    (sink) => runMobileFileApiDiagnostic(app, sink)
  );
}
