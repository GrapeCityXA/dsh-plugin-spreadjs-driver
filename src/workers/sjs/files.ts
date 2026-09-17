/**
 * Node-side file primitives shared by the operation handlers and the HTTP
 * server that carries bytes to and from the page.
 *
 * All file IO in this worker happens HERE, in Node: the engine now runs in a
 * real browser, which has no filesystem at all. The browser only ever sees bytes
 * it asked for over the loopback server, and it hands bytes back the same way.
 *
 * Writes are temp+rename. That is deliberate and predates the browser runtime: a
 * half-written workbook that still parses is indistinguishable from a good one,
 * so an interrupted write must never replace the real file.
 */
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SjsWorkerError } from './errors.ts'
import { errorMessage } from './util.ts'

/** Write bytes to `targetPath` through a temp file + rename, creating parents. */
export async function writeBytesAtomic(targetPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp-${String(process.pid)}`
  try {
    await writeFile(tempPath, bytes)
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SjsWorkerError(`cannot write file: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
  }
}

/**
 * Write bytes to `targetPath` in place, without the temp+rename step.
 *
 * Used only for the sandboxed `io.writeText` path, whose contract (a script
 * writing its own scratch file) is not the plugin's workbook-persistence path.
 */
export async function writeBytesPlain(targetPath: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, bytes)
}

/** Copy a file atomically (temp + rename). */
export async function copyFileAtomic(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp-${String(process.pid)}`
  try {
    await copyFile(sourcePath, tempPath)
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SjsWorkerError(`cannot write file: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
  }
}
