import { lstat, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

export interface StorageUsage {
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskAvailableBytes: number;
  diskReservedBytes: number;
  diskUsedPercent: number;
  frameDataBytes: number;
  mediaDataBytes: number;
}

export type FileSystemUsage = Pick<
  StorageUsage,
  | "diskTotalBytes"
  | "diskUsedBytes"
  | "diskAvailableBytes"
  | "diskReservedBytes"
  | "diskUsedPercent"
>;

export type FrameDataUsage = Pick<
  StorageUsage,
  "frameDataBytes" | "mediaDataBytes"
>;

function allocatedBytes(blocks: number, size: number): number {
  // Linux informa st_blocks en bloques de 512 bytes. El fallback conserva la
  // utilidad de la función en sistemas que no entreguen ese dato.
  return Number.isFinite(blocks) ? blocks * 512 : size;
}

async function allocatedTreeBytes(
  root: string,
  trackedDirectory: string,
): Promise<{ totalBytes: number; trackedBytes: number }> {
  let totalBytes = 0;
  let trackedBytes = 0;

  async function walk(current: string, tracked: boolean): Promise<void> {
    const details = await stat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") return null;
      throw error;
    });
    if (!details) return;
    const bytes = allocatedBytes(details.blocks, details.size);
    totalBytes += bytes;
    if (tracked) trackedBytes += bytes;
    if (!details.isDirectory()) return;

    const entries = await readdir(current, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EACCES" || error.code === "EPERM") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      // No seguimos enlaces: la data externa no pertenece al marco y un ciclo
      // no debe bloquear la recolección.
      if (entry.isSymbolicLink()) {
        const linkDetails = await lstat(path.join(current, entry.name));
        const linkBytes = allocatedBytes(linkDetails.blocks, linkDetails.size);
        totalBytes += linkBytes;
        if (tracked) trackedBytes += linkBytes;
        continue;
      }
      const child = path.join(current, entry.name);
      await walk(child, tracked || child === trackedDirectory);
    }
  }

  await walk(root, root === trackedDirectory);
  return { totalBytes, trackedBytes };
}

export async function collectFileSystemUsage(
  dataRoot: string,
): Promise<FileSystemUsage> {
  const fileSystem = await statfs(dataRoot);
  const blockSize = Number(fileSystem.bsize);
  const blocks = Number(fileSystem.blocks);
  const freeBlocks = Number(fileSystem.bfree);
  const availableBlocks = Number(fileSystem.bavail);
  const diskTotalBytes = blocks * blockSize;
  const diskUsedBytes = (blocks - freeBlocks) * blockSize;
  const diskAvailableBytes = availableBlocks * blockSize;
  const diskReservedBytes = Math.max(0, freeBlocks - availableBlocks) * blockSize;
  const usableBytes = diskUsedBytes + diskAvailableBytes;

  return {
    diskTotalBytes,
    diskUsedBytes,
    diskAvailableBytes,
    diskReservedBytes,
    // Esta es la misma convención que `df`: reservado no se presenta como usado.
    diskUsedPercent: usableBytes === 0 ? 0 : (diskUsedBytes / usableBytes) * 100,
  };
}

export async function collectFrameDataUsage(
  dataRoot: string,
  mediaRoot: string,
): Promise<FrameDataUsage> {
  const data = await allocatedTreeBytes(dataRoot, mediaRoot);
  return {
    frameDataBytes: data.totalBytes,
    mediaDataBytes: data.trackedBytes,
  };
}

export async function collectStorageUsage(
  dataRoot: string,
  mediaRoot: string,
): Promise<StorageUsage> {
  const [fileSystem, data] = await Promise.all([
    collectFileSystemUsage(dataRoot),
    collectFrameDataUsage(dataRoot, mediaRoot),
  ]);
  return { ...fileSystem, ...data };
}
