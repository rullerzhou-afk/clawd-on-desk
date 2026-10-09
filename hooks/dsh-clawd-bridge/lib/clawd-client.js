import http from 'node:http'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER_ID = 'clawd-on-desk'
const SERVER_HEADER = 'x-clawd-server'
const PORTS = Object.freeze([23333, 23334, 23335, 23336, 23337])
const RUNTIME_PATH = join(homedir(), '.clawd', 'runtime.json')
const MAX_RESPONSE_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 500
const STATE_TIMEOUT_MS = 1000
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const DISCOVERY_COOLDOWN_MS = 1000

let cachedPort = null
let discoveryPromise = null
let retryAfter = 0

function validPort(value) {
  return Number.isInteger(value) && PORTS.includes(value)
}

function finishOnce(resolve) {
  let settled = false
  return (value) => {
    if (settled) return
    settled = true
    resolve(value)
  }
}

function request(port, method, pathname, body, options = {}) {
  return new Promise((resolve) => {
    const finish = finishOnce(resolve)
    const signal = options.signal
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS
    const maxResponseBytes = Number.isFinite(options.maxResponseBytes)
      ? options.maxResponseBytes
      : MAX_RESPONSE_BYTES
    const payload = body === undefined ? null : JSON.stringify(body)
    let abortHandler = null
    let response = null
    let responseBytes = 0
    const chunks = []

    const cleanup = () => {
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
    const done = (value) => {
      cleanup()
      finish(value)
    }

    let req
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: payload === null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        response = res
        res.on('data', (chunk) => {
          responseBytes += chunk.length
          if (responseBytes > maxResponseBytes) {
            req.destroy()
            done({ ok: false, reason: 'response-too-large' })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const server = String(res.headers[SERVER_HEADER] || '')
          if (server !== SERVER_ID) {
            done({ ok: false, reason: 'wrong-server' })
            return
          }
          done({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', () => done({ ok: false, reason: 'response-error' }))
      })
    } catch {
      done({ ok: false, reason: 'request-create-failed' })
      return
    }

    req.on('error', () => done({ ok: false, reason: 'request-error' }))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done({ ok: false, reason: 'timeout' })
    })
    abortHandler = () => {
      req.destroy()
      done({ ok: false, reason: 'aborted', aborted: true })
    }
    if (signal) {
      if (signal.aborted) {
        abortHandler()
        return
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    if (payload !== null) req.write(payload)
    req.end()
  })
}

async function runtimePort() {
  try {
    const parsed = JSON.parse(await fs.readFile(RUNTIME_PATH, 'utf8'))
    return parsed?.app === SERVER_ID && validPort(parsed.port) ? parsed.port : null
  } catch {
    return null
  }
}

async function probe(port) {
  const result = await request(port, 'GET', '/state', undefined, {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxResponseBytes: 4096,
  })
  if (!result.ok || result.statusCode !== 200) return false
  try {
    const parsed = JSON.parse(result.body)
    return parsed?.app === SERVER_ID && parsed?.ok === true
  } catch {
    return false
  }
}

async function discoverUncached() {
  const preferred = await runtimePort()
  const candidates = preferred === null
    ? PORTS
    : [preferred, ...PORTS.filter((port) => port !== preferred)]
  for (const port of candidates) {
    if (await probe(port)) {
      cachedPort = port
      retryAfter = 0
      return port
    }
  }
  cachedPort = null
  retryAfter = Date.now() + DISCOVERY_COOLDOWN_MS
  return null
}

function waitForDiscovery(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(finish, () => finish(null))
  })
}

async function discover(signal) {
  if (validPort(cachedPort)) return cachedPort
  if (Date.now() < retryAfter) return null
  if (!discoveryPromise) {
    // Discovery is shared, but caller cancellation is not. Binding this scan
    // to the first caller's signal lets one aborted approval cancel unrelated
    // state or approval traffic. Each caller races its own signal below.
    discoveryPromise = discoverUncached().finally(() => {
      discoveryPromise = null
    })
  }
  return waitForDiscovery(discoveryPromise, signal)
}

async function post(pathname, body, options = {}) {
  const port = await discover(options.signal)
  if (port === null) return { ok: false, reason: 'clawd-unavailable' }
  const first = await request(port, 'POST', pathname, body, options)
  if (first.ok || first.aborted) return first
  cachedPort = null
  if (options.retry === false) return first
  const retryPort = await discover(options.signal)
  if (retryPort === null) return first
  return request(retryPort, 'POST', pathname, body, { ...options, retry: false })
}

export async function postState(body, options = {}) {
  return post('/state', body, {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS,
    maxResponseBytes: 4096,
  })
}

export function parsePermissionResult(result) {
  if (result?.aborted) return { kind: 'cancelled' }
  if (!result?.ok) return { kind: 'no-decision' }
  if (result.statusCode === 204) return { kind: 'no-decision' }
  if (result.statusCode !== 200 || !result.body) return { kind: 'no-decision' }
  try {
    const parsed = JSON.parse(result.body)
    return parsed?.decision === 'allow' || parsed?.decision === 'deny'
      ? { kind: 'decision', decision: parsed.decision }
      : { kind: 'no-decision' }
  } catch {
    return { kind: 'no-decision' }
  }
}

export async function requestPermission(body, options = {}) {
  const result = await post('/permission', body, {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : PERMISSION_TIMEOUT_MS,
    maxResponseBytes: 16 * 1024,
    // A blocking approval POST may have reached Clawd before the connection
    // failed. Do not create a second pending decision by replaying it.
    retry: false,
  })
  return parsePermissionResult(result)
}

export function clearCachedPortForTest() {
  cachedPort = null
  discoveryPromise = null
  retryAfter = 0
}

export const __test = Object.freeze({
  waitForDiscovery,
  request,
  probe,
  validPort,
  ports: PORTS,
  runtimePath: RUNTIME_PATH,
})
