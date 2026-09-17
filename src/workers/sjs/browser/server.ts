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
 *   /fs?p=<abs>    HOST-AUTHORIZED only. The action the host asked for names
 *                  these paths, and they may legitimately live outside the
 *                  workspace (the host resolved them against its own rules). It
 *                  therefore also requires the per-process capability token in
 *                  `?k=`, which is never placed in a page global: Node inlines it
 *                  in the one call it builds. Without that, sandboxed user code
 *                  could simply `fetch('/fs?p=C:/...')` and read every file the
 *                  process can — which would silently undo the confinement that
 *                  `/ws` exists to enforce.
 *
 * Bytes are moved as raw request/response bodies, never base64 through CDP: the
 * spike measured HTTP ~15x faster than base64 over Runtime.evaluate for 10 MB.
 */
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

export async function startFileServer(options: ServerOptions, capability: string): Promise<FileServer> {
  let workspaceRoot = ''

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      try {
        respond(response, 500, `server error: ${errorMessage(error)}`, 'text/plain; charset=utf-8')
      } catch {
        // the socket is already gone
      }
    })
  })

  const respond = (response: import('node:http').ServerResponse, status: number, body: string | Buffer, contentType?: string): void => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
    response.writeHead(status, {
      'content-type': contentType ?? 'text/plain; charset=utf-8',
      'content-length': buffer.length,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
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

    if (path === '/fs') {
      // Host-authorized: reachable only with the capability token Node inlines
      // into the calls it builds for the page.
      if (url.searchParams.get('k') !== capability) {
        respondFailure(response, new HttpFailure(403, 'SJS_FILE_PERMISSION_DENIED', 'host file route requires the runtime capability'))
        return
      }
      const target = resolve(url.searchParams.get('p') ?? '')
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
          respondFailure(response, new HttpFailure(500, 'SJS_FILE_WRITE_FAILED', `cannot write file: ${errorMessage(error)}`))
        }
        return
      }
      respondFailure(response, new HttpFailure(405, 'SJS_BAD_REQUEST', '/fs accepts GET and POST only'))
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
        respond(response, 200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream')
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

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    setWorkspaceRoot(root: string) { workspaceRoot = root },
    close: () => new Promise<void>((resolve) => { (server as Server).close(() => { resolve() }) }),
  }
}
