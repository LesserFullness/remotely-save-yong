import isEqual from "lodash/isEqual";
import { nanoid } from "nanoid";
import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity>;

  /**
   * Whether this provider supports the streaming large-file upload path
   * (progress + auto-retry + size/ETag verification). Default false.
   * Only S3 (and the encrypt wrapper when password is empty) overrides this.
   */
  supportsLargeFileStreaming(): boolean {
    return false;
  }

  /**
   * Threshold (bytes) above which the large-file streaming path should be used.
   * Default undefined (never use the large-file path).
   */
  getLargeFileThresholdBytes(): number | undefined {
    return undefined;
  }

  /**
   * Optional streaming upload path for large files.
   * Default falls back to writeFile (ArrayBuffer). Providers that support it
   * (e.g. S3) override this to stream the body with progress/retry/verify.
   * @param onProgress optional progress callback (loaded, total in bytes)
   */
  async writeFileLarge(
    key: string,
    content: ArrayBuffer | Blob | ReadableStream | Uint8Array,
    mtime: number,
    ctime: number,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Entity> {
    return await this.writeFile(key, content as ArrayBuffer, mtime, ctime);
  }

  /**
   * Optional: read a file as a Blob without materialising it in the JS heap.
   * Only the local fs implements this (via fetch of the vault resource URL).
   * Default undefined -> callers fall back to readFile (ArrayBuffer).
   */
  async readFileAsBlob(_key: string): Promise<Blob | undefined> {
    return undefined;
  }

  abstract readFile(key: string): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string): Promise<void>;
  abstract rm(key: string): Promise<void>;
  abstract checkConnect(callbackFunc?: any): Promise<boolean>;
  async checkConnectCommonOps(callbackFunc?: any) {
    try {
      console.info(`check connect: create folder`);
      const folderName = `rs-test-folder-${nanoid()}/`;
      await this.mkdir(folderName);
      // await delay(3000);

      console.info(`check connect: upload file`);
      const filename = `${folderName}rs-test-file-${nanoid()}`;
      const ctime = Date.now();
      const mtime1 = Date.now();
      const content1 = new ArrayBuffer(100);
      await this.writeFile(filename, content1, mtime1, ctime);
      // await delay(3000);

      console.info(`check connect: overwrite file`);
      const mtime2 = Date.now();
      const content2 = new ArrayBuffer(200);
      await this.writeFile(filename, content2, mtime2, ctime);
      // await delay(3000);

      console.info(`check connect: download file`);
      const content3 = await this.readFile(filename);
      if (!isEqual(content2, content3)) {
        throw Error(`downloaded file is not equal with uploaded file!`);
      }
      // await delay(3000);

      console.info(`check connect: delete file`);
      await this.rm(filename);
      // await delay(3000);

      console.info(`check connect: delete folder`);
      await this.rm(folderName);
      // await delay(3000);

      return true;
    } catch (err) {
      console.error(err);
      callbackFunc?.(err);
      return false;
    }
  }
  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<any>;
  abstract allowEmptyFile(): boolean;
}
