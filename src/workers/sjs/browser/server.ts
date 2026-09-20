/**
 * Loopback HTTP server: the file channel between Node and the page.
 *
 * A browser has no filesystem, so the worker's Node half owns every byte of IO
 * and this server is the only door between the two halves. Two routes, with
 * deliberately DIFFERENT authorization:
 *
 *   /f/<n>/<rel>   static package files — the SpreadJS UMD bundles. Nothing
 *                  user-supplied is reachable through it.
 *   /ws?p=<path>   WORKSPACE-CONFINED. This is what sandboxed user code reaches
 *                  through `io.*`. Every single request is re-authorized here,
 *                  Node-side, against the session workspace root — the page holds
 *                  no path capability of its own.
 *   /blob/<id>     HOST-AUTHORIZED, one file per id. The host's action names
 *                  these paths and they may legitimately live outside the
 *                  workspace (the host resolved them against its own rules), so
 *                  they cannot be confined by a root the way `/ws` is.
 *
 *                  The id is therefore the whole authorization: an opaque nonce
 *                  minted per file by Node, mapping to exactly one path. There
 *                  is no route anywhere that accepts a path from the page.
 *
 *                  The registry is per PROCESS, and a process now serves many
 *                  operations, so it is cleared at the start of every operation
 *                  (`clearBlobs`): a nonce stays valid for exactly the operation
 *                  that minted it. Without that it would grow for the engine's
 *                  whole life — a PDF export alone mints ~136 of them, one per
 *                  font file.
 *
 *                  This replaced a per-process bearer token in `?k=`, which was
 *                  exploitable: the token sat in a URL the page itself fetched,
 *                  and sandboxed code could recover it with
 *                  `performance.getEntriesByType('resource')` — no fetch
 *                  hijacking, no race — then `fetch('/fs?p=C:/any/path&k=…')`
 *                  and read or write anything the process could reach. A secret
 *                  the page can read is not a secret, so the fix is not a better
 *                  secret; it is removing the page's ability to name a path.
 *
 * Bytes are moved as raw request/response bodies, never base64 through CDP: the
 * spike measured HTTP ~15x faster than base64 over Runtime.evaluate for 10 MB.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { errorMessage } from '../util.ts'
import { writeBytesAtomic, writeBytesPlain } from '../files.ts'

/**
 * Content types for everything the page fetches.
 *
 * This map is a correctness requirement, not a nicety: served as
 * `application/octet-stream`, the page document is DOWNLOADED instead of
 * rendered, which surfaces as `net::ERR_ABORTED`, then "No target with given id
 * found", then "Session with given id not found" — three misleading CDP errors
 * that never mention MIME.
 */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * Cache lifetime for the package bundles. `immutable` is honest: the files
 * belong to an installed package and cannot change while this engine runs.
 */
const STATIC_CACHE = 'public, max-age=3600, immutable'

export interface ServerOptions {
  /** In-memory documents: URL path → body. A path without an extension is HTML. */
  readonly documents: Record<string, string>
  /**
   * Files on disk: URL path → absolute file path. The paths are resolved by Node
   * before the server starts (the SpreadJS UMD bundles), never derived from the
   * request, so there is no traversal surface here at all.
   */
  readonly files: Record<string, string>
}

export interface ServerResponse {
  status: number
  body: string | Buffer
  contentType?: string
}

export interface FileServer {
  readonly origin: string
  /** The workspace root sandboxed `io.*` calls are confined to (set per execute). */
  setWorkspaceRoot(root: string): void
  /**
   * Mint an opaque URL for ONE host-authorized file, and return it.
   *
   * The URL says nothing about where the file is. Possessing it grants access to
   * exactly that one already-authorized file — not to a class of paths — so it
   * is safe to hand to the page even though the page (and any sandboxed code
   * running in it) can see every URL the page fetches. GET reads the file, POST
   * writes it back.
   *
   * @param absolutePath - a path the host has already authorized under its own
   *                       rules; it may legitimately live outside the workspace.
   * @returns the absolute URL to fetch.
   */
  registerBlob(absolutePath: string): string
  /**
   * Drop every nonce previously minted, so the next operation starts with an
   * empty registry. Called by the runtime before each operation (see the
   * header): a nonce authorizes one file for the operation that asked for it
   * and no longer.
   */
  clearBlobs(): void
  close(): Promise<void>
}

/** Classified failure with a worker error code, serialized to the page as JSON. */
export class HttpFailure extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Confine a sandbox-supplied path to the session workspace.
 * Same semantics as the jsdom worker's `makeIo().authorize`.
 */
export function authorizeWorkspacePath(workspaceRoot: string, requested: string): string {
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested)
  const fromRoot = relative(workspaceRoot, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new HttpFailure(403, 'SJS_FILE_PERMISSION_DENIED', 'file path is outside the session workspace')
  }
  return candidate
}

export async function startFileServer(options: ServerOptions): Promise<FileServer> {
  let workspaceRoot = ''
  /** Opaque blob id → the one path it stands for. Populated by registerBlob only. */
  const blobs = new Map<string, string>()

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      try {
        respond(response, 500, `server error: ${errorMessage(error)}`, 'text/plain; charset=utf-8')
      } catch {
        // the socket is already gone
      }
    })
  })

  const respond = (response: import('node:http').ServerResponse, status: number, body: string | Buffer, contentType?: string, cacheControl = 'no-store'): void => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
    response.writeHead(status, {
      'content-type': contentType ?? 'text/plain; charset=utf-8',
      'content-length': buffer.length,
      'access-control-allow-origin': '*',
      'cache-control': cacheControl,
    })
    response.end(buffer)
  }

  const respondFailure = (response: import('node:http').ServerResponse, failure: HttpFailure): void => {
    respond(response, failure.status, JSON.stringify({ code: failure.code, message: failure.message }), 'application/json; charset=utf-8')
  }

  const readBody = async (request: import('node:http').IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  async function handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)

    if (path.startsWith('/blob/')) {
      // Host-authorized: one opaque id, one file. The id carries no path, and
      // there is no route that accepts a path, so a URL recovered from the
      // page's resource timing is worth exactly the file Node already chose to
      // hand over — and nothing else. See registerBlob.
      const target = blobs.get(path.slice('/blob/'.length))
      if (target === undefined) {
        respondFailure(response, new HttpFailure(403, 'SJS_FILE_PERMISSION_DENIED', 'unknown blob id'))
        return
      }
      if (request.method === 'GET') {
        try {
          respond(response, 200, await readFile(target), 'application/octet-stream')
        } catch (error) {
          respondFailure(response, new HttpFailure(404, 'SJS_FILE_READ_FAILED', `cannot read file: ${target}: ${errorMessage(error)}`))
        }
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        try {
          await writeBytesAtomic(target, body)
          respond(response, 200, 'written')
        } catch (error) {
          respondFailure(response, new HttpFailure(500, 'SJS_FILE_WRITE_FAILED', `cannot write file: ${target}: ${errorMessage(error)}`))
        }
        return
      }
      respondFailure(response, new HttpFailure(405, 'SJS_BAD_REQUEST', 'a blob accepts GET and POST only'))
      return
    }

    if (path === '/ws') {
      // Workspace-confined: what sandboxed user code reaches through io.*.
      let target: string
      try {
        target = authorizeWorkspacePath(workspaceRoot, url.searchParams.get('p') ?? '')
      } catch (error) {
        if (error instanceof HttpFailure) {
          respondFailure(response, error)
          return
        }
        throw error
      }
      if (request.method === 'GET') {
        try {
          respond(response, 200, await readFile(target), 'application/octet-stream')
        } catch (error) {
          respondFailure(response, new HttpFailure(404, 'SJS_FILE_READ_FAILED', `cannot read file: ${target}: ${errorMessage(error)}`))
        }
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        try {
          // Plain (non-atomic) write, matching the sandbox io contract exactly:
          // user code writing its own scratch file is not the plugin's atomic
          // workbook-persistence path.
          await writeBytesPlain(target, body)
          respond(response, 200, 'written')
        } catch (error) {
          respondFailure(response, new HttpFailure(500, 'SJS_FILE_WRITE_FAILED', `cannot write file: ${errorMessage(error)}`))
        }
        return
      }
      respondFailure(response, new HttpFailure(405, 'SJS_BAD_REQUEST', '/ws accepts GET and POST only'))
      return
    }

    const document = options.documents[path]
    if (document !== undefined) {
      // A path with no extension is a page, not an opaque download (see MIME note).
      const ext = extname(path)
      respond(response, 200, document, ext.length > 0 ? MIME[ext] ?? 'application/octet-stream' : 'text/html; charset=utf-8')
      return
    }

    const file = options.files[path]
    if (file !== undefined) {
      try {
        // Cacheable, unlike every other route: these are the package's SpreadJS
        // UMD bundles, fixed for the engine's lifetime, and they are re-fetched
        // by every page. Serving them from the browser's cache is what makes the
        // second and later operations cheap — see the header note on pages.
        respond(response, 200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream', STATIC_CACHE)
      } catch (error) {
        respondFailure(response, new HttpFailure(404, 'SJS_FILE_READ_FAILED', `cannot read ${file}: ${errorMessage(error)}`))
      }
      return
    }

    respond(response, 404, `not found: ${path}`, 'text/plain; charset=utf-8')
  }

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the file server did not bind a TCP port')

  const origin = `http://127.0.0.1:${String(address.port)}`

  return {
    origin,
    setWorkspaceRoot(root: string) { workspaceRoot = root },
    registerBlob(absolutePath: string): string {
      const id = randomBytes(16).toString('hex')
      blobs.set(id, resolve(absolutePath))
      return `${origin}/blob/${id}`
    },
    clearBlobs() { blobs.clear() },
    close: () => new Promise<void>((resolve) => {
      ;(server as Server).close(() => { resolve() })
      // A keep-alive socket left by a browser that is closing anyway would
      // otherwise hold `close` open — and an engine that hangs on its way out
      // is an engine whose browser is not being closed.
      ;(server as Server).closeAllConnections()
    }),
  }
}
