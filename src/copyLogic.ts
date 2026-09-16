import type { FakeFs } from "./fsAll";

/**
 * Serializes *large* file copies (local read + remote transfer) so that at
 * most one large file's bytes are held in memory at a time.
 *
 * This is the key defence against iOS OOM-kill: the sync engine runs file
 * transfers with a pool (default concurrency 5), so without this lock a first
 * full sync could hold several hundreds of MB of file buffers at once and the
 * OS would kill Obsidian (which looks like a "restart" / all plugins reload).
 *
 * Small files never touch this lock and keep the normal sync concurrency.
 */
let largeFileChain: Promise<unknown> = Promise.resolve();
function withLargeFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = largeFileChain.then(fn, fn);
  // Keep the chain alive no matter how this copy finishes.
  largeFileChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function copyFolder(key: string, left: FakeFs, right: FakeFs) {
  if (!key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFolder`);
  }
  const statsLeft = await left.stat(key);
  const entity = await right.mkdir(key, statsLeft.mtimeCli);
  return {
    entity: entity,
    content: undefined,
  };
}

export async function copyFile(
  key: string,
  left: FakeFs,
  right: FakeFs,
  onProgress?: (loaded: number, total: number) => void
) {
  // console.debug(`copyFile: key=${key}, left=${left.kind}, right=${right.kind}`);
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFile`);
  }
  const statsLeft = await left.stat(key);

  // A file counts as "large" if either side declares a large-file threshold
  // (uploads: right is S3/OSS; downloads: left is S3/OSS).
  const threshold =
    right.getLargeFileThresholdBytes() ?? left.getLargeFileThresholdBytes();
  const isLarge =
    threshold !== undefined &&
    statsLeft.size !== undefined &&
    statsLeft.size > 0 &&
    statsLeft.size >= threshold;

  const useStreamingUpload = isLarge && right.supportsLargeFileStreaming();

  const doCopy = async () => {
    // For large uploads, prefer a Blob source obtained via fetch() of the
    // vault resource URL. Unlike adapter.readBinary(), this does not put the
    // whole file on the JS heap (WebKit backs the Blob with blob storage), and
    // the S3 SDK can slice it part-by-part. Falls back to readFile() below.
    let blob: Blob | undefined = undefined;
    if (useStreamingUpload) {
      blob = await left.readFileAsBlob(key);
      if (
        blob !== undefined &&
        statsLeft.size !== undefined &&
        statsLeft.size > 0 &&
        blob.size !== statsLeft.size
      ) {
        // Unexpected size -> don't trust the blob; fall back to readBinary().
        blob = undefined;
      }
    }

    const content = blob === undefined ? await left.readFile(key) : undefined;
    const size = blob !== undefined ? blob.size : content!.byteLength;

    if (statsLeft.size === undefined || statsLeft.size === 0) {
      // some weird bugs on android not returning size. just ignore them
      statsLeft.size = size;
    } else {
      if (statsLeft.size !== size) {
        throw Error(
          `error copying ${left.kind}=>${right.kind}: size not matched`
        );
      }
    }

    if (statsLeft.mtimeCli === undefined) {
      throw Error(`error copying ${left.kind}=>${right.kind}, no mtimeCli`);
    }

    // Route large uploads through the streaming path when the destination
    // supports it (progress + retry + verification).
    const entity = useStreamingUpload
      ? await right.writeFileLarge(
          key,
          (blob ?? content) as ArrayBuffer | Blob | Uint8Array,
          statsLeft.mtimeCli,
          statsLeft.ctimeCli ?? statsLeft.mtimeCli,
          onProgress
        )
      : await right.writeFile(
          key,
          content!,
          statsLeft.mtimeCli,
          statsLeft.ctimeCli ?? statsLeft.mtimeCli
        );

    // Large files are never "mergable" (that only applies to small text
    // notes), so we can drop the buffer reference immediately to release
    // memory as early as possible.
    return {
      entity: entity,
      content: isLarge ? undefined : content,
    };
  };

  if (isLarge) {
    return await withLargeFileLock(doCopy);
  }
  return await doCopy();
}

export async function copyFileOrFolder(
  key: string,
  left: FakeFs,
  right: FakeFs,
  onProgress?: (loaded: number, total: number) => void
) {
  if (key.endsWith("/")) {
    return await copyFolder(key, left, right);
  } else {
    return await copyFile(key, left, right, onProgress);
  }
}
