/**
 * The RPC wire protocol, spoken on a route this plugin owns itself.
 *
 * The browser reaches a channel by POSTing a `client-request` envelope to
 * `<channel>/<endpoint>`, and reads a `server-response` envelope back. DSH's
 * first-party way to host one is `connection.rpc.handle` — and that method is
 * unusable from a third-party plugin:
 *
 * ```js
 * get rpc() {
 *   const owner = this.ctx;                       // the connection service's OWN context
 *   return { handle: (channel, handler) => this.register(owner, channel, handler), ... }
 * }
 * // register() ends with:
 * return owner.effect(() => owner.webServer.register(route), ...);
 * ```
 *
 * `handle` mounts the physical route through the **caller's** context, not ours,
 * and that context does not inject `webServer`. So it throws
 * `cannot get property "webServer" without inject`, the route never exists, and
 * every poll from a perfectly healthy tab is answered by the SPA fallback with
 * 405 while the tool reports "no browser connected". Injecting `webServer` on our
 * side cannot help: the failing property read is not on our context. (Nobody
 * exercises the method, which is why this was never noticed — across the whole
 * installed tree the only caller of the rpc registry is `dsh-api-gateway`, and it
 * calls `intercept`, never `handle`, and `intercept` never touches `webServer`.)
 *
 * So this file speaks the same protocol on a route registered directly with
 * `webServer`. The browser half is not touched and cannot tell the difference.
 * Every rule below — including the status codes — is copied from the reference
 * handler `rpcFetchHandler` in `dsh-client-connection/lib/index.js`:
 *
 * | request                                            | answer                    |
 * |----------------------------------------------------|---------------------------|
 * | not a POST, or path is not `<channel>/<endpoint>`   | 404                       |
 * | content-type is not `application/json`              | 415                       |
 * | body is not JSON                                    | 400                       |
 * | envelope is malformed                               | 200, `gateway/bad-request`|
 * | envelope's method is not the path's endpoint         | 200, `gateway/bad-request`|
 * | otherwise                                           | 200, the outcome          |
 *
 * Note the asymmetry: an application-level refusal is a **200 carrying a failed
 * result**, not an error status. The browser client throws on a non-2xx
 * response — it reads that as "the transport is down" and backs off — so
 * answering a bad endpoint with 500 would turn a protocol mistake into a
 * connection outage. That distinction is the reference's, and it is preserved.
 *
 * Authorization is required and is not ours to skip. The reference runs
 * `requestRejection` — the Host/Origin fence, then browser authentication —
 * *before* the handler and refuses with its status. Here that check is a
 * **required** parameter rather than an optional one, and a host that cannot
 * supply it fails to mount at all: a channel that served without it would let
 * any local process drive the user's open workbook.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Carrier-neutral result one endpoint returns.
 *
 * Matches DSH's own `rpcResultSchema`, and the browser's response parser
 * (`parseConnectionResponse`) rejects anything else outright. So the shape is
 * fixed by the other side, not a preference of ours.
 */
export type RpcOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message: string
      readonly details: Record<string, unknown>
    }
  }

/**
 * One route, structurally.
 *
 * Written out rather than imported from `@deepseek-ai/dsh-host-webserver`: this
 * bundle must not depend on that package's runtime module (it is not one of our
 * peers), and the surface used is a single method on a single shape. The
 * signature matches `WebRoute` exactly, including the synchronous disposer
 * `register` returns — unlike `rpc.handle`, whose disposer is async.
 */
export interface LiveRoute {
  /** `prefix`: answers the path itself and anything under `<path>/`. */
  readonly kind: 'prefix'
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  /** Owns the full response lifecycle of a matched request. */
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

/** What the route needs from the channel that owns it. */
export interface LiveRouteOptions {
  /** Channel path; endpoints live one segment below it. */
  readonly path: string
  /**
   * DSH's own request check — Host/Origin fence, then the signed browser cookie.
   * Returns the status to refuse with, or undefined to serve. Called before
   * anything is read, and its answer is the only thing that lets a request past.
   */
  readonly authenticate: (request: IncomingMessage) => number | undefined
  /** Route one validated endpoint to its handler. */
  readonly dispatch: (endpoint: string, payload: unknown) => RpcOutcome
}

/**
 * Base for parsing a request's origin-form URL. Never sent anywhere: `new URL`
 * needs an absolute base, and the reference uses this same internal host.
 */
const INTERNAL_BASE = 'http://dsh.internal'

/** Endpoint segments, from the reference's `ENDPOINT_SEGMENT_PATTERN`. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** The one content type this protocol accepts. */
const JSON_CONTENT_TYPE = 'application/json'

/**
 * Ceiling on a request body. Same value the reference bridge uses for a buffered
 * request (`DEFAULT_MAX_REQUEST_BODY_BYTES`); it is large because a job result
 * carries a JSON value the browser produced, which can be a whole-workbook
 * readout, and refusing those would invent a new field failure for no gain —
 * DSH's own `/api` carrier already accepts this much from the same page.
 */
const MAX_REQUEST_BYTES = 300 * 1024 * 1024

/**
 * Correlation id used when the request was too broken to carry one, matching the
 * reference. It can never collide with a real one, which is generated fresh per
 * call and checked for equality by the browser.
 */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/** Envelope fields the reference's `clientRequestSchema` insists on. */
interface ClientRequest {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Build the route for one live channel.
 * @param options - channel path, the authentication check, and the dispatcher.
 * @returns the route to hand to `webServer.register`.
 */
export function liveRoute(options: LiveRouteOptions): LiveRoute {
  return {
    kind: 'prefix',
    path: options.path,
    handler: (request, response) => serve(options, request, response),
  }
}

/** Answer one request: authenticate, decode, dispatch, encode. */
async function serve(
  options: LiveRouteOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // First, before a byte of the body is read: nothing below this line is
  // reachable by a request DSH would not have served itself. A check that throws
  // refuses too — an authentication failure must never fall through to "serve".
  let rejection: number | undefined
  try {
    rejection = options.authenticate(request)
  } catch {
    rejection = 500
  }
  if (rejection !== undefined) {
    refuse(response, rejection, refusalReason(rejection))
    return
  }

  const pathname = new URL(request.url ?? '/', INTERNAL_BASE).pathname
  const endpoint = endpointFromPath(options.path, pathname)
  if (request.method !== 'POST' || endpoint === undefined) {
    refuse(response, 404, 'not found')
    return
  }
  if (contentTypeOf(request) !== JSON_CONTENT_TYPE) {
    refuse(response, 415, 'content type must be application/json')
    return
  }

  const body = await readBody(request)
  if (body === undefined) {
    refuse(response, 413, 'request body too large')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    refuse(response, 400, 'body is not JSON')
    return
  }

  const message = clientRequest(parsed)
  if (message === undefined) {
    // 200 carrying a failed result, not 400: see the note at the top. The
    // correlation id is echoed when the caller managed to supply one, so a
    // browser can match the refusal to the call that caused it.
    fullResponse(response, rawRpcId(parsed), badRequest('invalid client-request message'))
    return
  }
  if (message.method !== endpoint) {
    fullResponse(
      response,
      message.rpcId,
      badRequest(`method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`),
    )
    return
  }

  let outcome: RpcOutcome
  try {
    outcome = options.dispatch(endpoint, message.payload)
  } catch (error) {
    // A dispatcher that throws is a bug here, not a request problem: it gets a
    // 500 and a body naming the failure, the way the reference does.
    refuse(response, 500, `handler failure: ${String(error)}`)
    return
  }
  fullResponse(response, message.rpcId, outcome)
}

/**
 * The endpoint a request path names, or undefined when it names none.
 *
 * Copied from the reference, empty and dot segments included: they are the
 * traversal shapes a path can be made to wear, and a channel that accepted them
 * would dispatch on a string the browser could never have produced.
 */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((segment) => segment === ''
    || segment === '.'
    || segment === '..'
    || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined
  return endpoint
}

/** The media type of the request, lower-cased and stripped of parameters. */
function contentTypeOf(request: IncomingMessage): string | undefined {
  const header = request.headers['content-type']
  const single = Array.isArray(header) ? header[0] : header
  return single?.split(';', 1)[0]?.trim().toLowerCase()
}

/**
 * Read the whole body as text.
 * @returns the body, or undefined when it exceeds {@link MAX_REQUEST_BYTES}.
 */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_REQUEST_BYTES) return undefined
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_REQUEST_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Validate the request envelope, or return undefined when it is not one. */
function clientRequest(value: unknown): ClientRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = value as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (envelope.type !== 'client-request') return undefined
  if (typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') return undefined
  // Payload is deliberately unvalidated here: its shape belongs to the endpoint,
  // which is the only code that knows what it is looking at.
  return { rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload }
}

/** The correlation id a malformed envelope carried, when it carried one. */
function rawRpcId(value: unknown): string {
  const candidate = typeof value === 'object' && value !== null
    ? (value as { rpcId?: unknown }).rpcId
    : undefined
  return typeof candidate === 'string' ? candidate : INVALID_REQUEST_RPC_ID
}

/** One protocol-level failure result, which is served with a 200. */
function badRequest(message: string): RpcOutcome {
  return { ok: false, error: { code: 'gateway/bad-request', message, details: { issues: [] } } }
}

/** One `server-response` envelope, as the browser's parser expects to read it. */
function fullResponse(response: ServerResponse, rpcId: string, result: RpcOutcome): void {
  response.writeHead(200, {
    'content-type': JSON_CONTENT_TYPE,
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/**
 * Refuse a request with a plain-text body.
 *
 * The connection is closed with the answer, because a refused request may still
 * have an unread body behind it and this handler is not going to drain one it
 * has already decided not to serve.
 */
function refuse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(body)
}

/** The word the reference writes under each refusal status. */
function refusalReason(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  return 'authentication failed'
}
