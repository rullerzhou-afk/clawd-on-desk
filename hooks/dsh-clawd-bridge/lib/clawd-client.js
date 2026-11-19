import http from 'node:http'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ID = 'clawd-on-desk'
const SERVER_HEADER = 'x-clawd-server'
const NONCE_HEADER = 'x-clawd-routing-nonce'
const PORTS = Object.freeze([23333, 23334, 23335, 23336, 23337])
const RUNTIME_PATH = join(homedir(), '.clawd', 'runtime.json')
const MAX_RESPONSE_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 500
const STATE_TIMEOUT_MS = 1000
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const DISCOVERY_COOLDOWN_MS = 1000
// The remote deployment descriptor has its own version. The bridge protocol
// version is deliberately not reused: it is an ownership equality across every
// installed generation, so changing it would make all local generations look
// foreign.
const REMOTE_DEPLOYMENT_DESCRIPTOR_VERSION = 1
const REMOTE_IDENTITY_VERSION = 2
const REMOTE_PROBE_TIMEOUT_MS = 2000
const PERMISSION_LIVENESS_INTERVAL_MS = 15000
const PERMISSION_LIVENESS_TIMEOUT_MS = 2000
const PERMISSION_LIVENESS_FAILURES = 2
const ROUTING_NONCE_RE = /^[a-f0-9]{32}$/
const INSTALL_ID_RE = /^[a-f0-9]{64}$/
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

let cachedPort = null
let discoveryPromise = null
let retryAfter = 0
let transportModePromise = null
// Remote identities normally pin one of the tunnel's five ports. Tests bind an
// ephemeral port so they never touch a real Clawd listener; the override only
// exists on this module instance.
let remotePortValidatorForTest = null

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

function validRemotePort(value) {
  if (remotePortValidatorForTest) return remotePortValidatorForTest(value) === true
  return validPort(value) && PORTS.includes(value)
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
    const headers = { ...(options.headers || {}) }
    if (payload !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    let abortHandler = null
    let response = null
    let responseBytes = 0
    const chunks = []
    let absoluteTimer = null

    const cleanup = () => {
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      abortHandler = null
      if (absoluteTimer) clearTimeout(absoluteTimer)
      absoluteTimer = null
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
        headers,
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
    if (Number.isFinite(options.absoluteTimeoutMs) && options.absoluteTimeoutMs > 0) {
      // req.setTimeout() is an idle-socket timer: a peer that keeps trickling
      // bytes can hold a probe open forever. Probes need a hard wall-clock cap.
      absoluteTimer = setTimeout(() => {
        req.destroy()
        done({ ok: false, reason: 'absolute-timeout' })
      }, options.absoluteTimeoutMs)
      if (typeof absoluteTimer.unref === 'function') absoluteTimer.unref()
    }
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function normalizeLocalPort(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value))) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

async function runtimePort() {
  try {
    const parsed = JSON.parse(await fs.readFile(RUNTIME_PATH, 'utf8'))
    return parsed?.app === SERVER_ID ? normalizeLocalPort(parsed.port) : null
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

async function localPost(pathname, body, options = {}) {
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

// ── Generation-owned transport mode ──────────────────────────────────────────
//
// Every generation contains clawd-manifest.json next to lib/. A manifest
// without `deployment` means "local discovery", exactly as before. A valid
// `deployment` pins this generation to one SSH remote tunnel. Anything else
// (missing file, invalid JSON, an unrecognised descriptor) is unknown: the
// bridge must not guess and must not fall back to scanning this machine's
// ports, because the remote machine may run its own Clawd on them.

function resolveManifestPath() {
  if (!import.meta.url.startsWith('file:')) {
    // Deliberate exception: a non-file module URL cannot locate a generation
    // manifest, and the old bridge worked for every local loader shape. Keeping
    // local discovery here avoids silencing local users if DSH ever loads the
    // plugin without a file: URL. Real file-loaded generations still use the
    // strict three-state manifest decision, and device tests verify the actual
    // DSH loader path.
    return null
  }
  try {
    return fileURLToPath(new URL('../clawd-manifest.json', import.meta.url))
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateDeployment(value) {
  if (!isPlainObject(value)) return null
  if (value.kind !== 'ssh-remote') return null
  if (value.descriptorVersion !== REMOTE_DEPLOYMENT_DESCRIPTOR_VERSION) return null
  if (typeof value.installId !== 'string' || !INSTALL_ID_RE.test(value.installId)) return null
  if (typeof value.profileId !== 'string' || !SAFE_ID_RE.test(value.profileId)) return null
  if (typeof value.runtimeKey !== 'string' || !SAFE_ID_RE.test(value.runtimeKey)) return null
  if (!Number.isInteger(value.layoutVersion) || value.layoutVersion <= 0) return null
  if (typeof value.identityPath !== 'string' || !value.identityPath || !isAbsolute(value.identityPath)) return null
  if (typeof value.hostPrefixPath !== 'string' || !value.hostPrefixPath || !isAbsolute(value.hostPrefixPath)) return null
  return Object.freeze({
    kind: 'ssh-remote',
    descriptorVersion: value.descriptorVersion,
    installId: value.installId,
    profileId: value.profileId,
    runtimeKey: value.runtimeKey,
    layoutVersion: value.layoutVersion,
    identityPath: value.identityPath,
    hostPrefixPath: value.hostPrefixPath,
  })
}

async function readTransportMode() {
  const manifestPath = resolveManifestPath()
  if (manifestPath === null) return { kind: 'local' }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    return { kind: 'unknown' }
  }
  if (!isPlainObject(parsed)) return { kind: 'unknown' }
  if (!Object.hasOwn(parsed, 'deployment')) return { kind: 'local' }
  const deployment = validateDeployment(parsed.deployment)
  return deployment ? { kind: 'remote', deployment } : { kind: 'unknown' }
}

function resolveTransportMode() {
  if (!transportModePromise) transportModePromise = readTransportMode()
  return transportModePromise
}

// Read the identity fresh for every request: each deployment rotates its
// routing nonce, and a generation left over from an older deployment must
// stop talking to the new tunnel even if an attacker copied its manifest.
async function readDeploymentIdentity(deployment) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(deployment.identityPath, 'utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(raw)) return null
  if (raw.version !== REMOTE_IDENTITY_VERSION) return null
  if (!Number.isInteger(raw.layoutVersion) || raw.layoutVersion <= 0) return null
  if (typeof raw.runtimeKey !== 'string' || !SAFE_ID_RE.test(raw.runtimeKey)) return null
  if (typeof raw.profileId !== 'string' || !SAFE_ID_RE.test(raw.profileId)) return null
  if (typeof raw.installId !== 'string' || !INSTALL_ID_RE.test(raw.installId)) return null
  if (!validRemotePort(raw.remotePort)) return null
  if (typeof raw.routingNonce !== 'string' || !ROUTING_NONCE_RE.test(raw.routingNonce)) return null
  if (!Number.isFinite(raw.deployedAt) || raw.deployedAt <= 0) return null
  if (raw.installId !== deployment.installId
    || raw.profileId !== deployment.profileId
    || raw.runtimeKey !== deployment.runtimeKey
    || raw.layoutVersion !== deployment.layoutVersion) {
    return null
  }
  return raw
}

function nonceHeaders(identity) {
  return { [NONCE_HEADER]: identity.routingNonce }
}

function sameDeploymentIdentity(left, right) {
  return Boolean(left && right
    && left.installId === right.installId
    && left.profileId === right.profileId
    && left.runtimeKey === right.runtimeKey
    && left.layoutVersion === right.layoutVersion
    && left.remotePort === right.remotePort
    && left.routingNonce === right.routingNonce)
}

async function remoteProbe(identity, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REMOTE_PROBE_TIMEOUT_MS
  const result = await request(identity.remotePort, 'GET', '/state', undefined, {
    signal: options.signal,
    timeoutMs,
    absoluteTimeoutMs: timeoutMs,
    maxResponseBytes: 4096,
    headers: nonceHeaders(identity),
  })
  if (!result.ok || result.statusCode !== 200) return false
  try {
    const parsed = JSON.parse(result.body)
    return parsed?.app === SERVER_ID && parsed?.ok === true
  } catch {
    return false
  }
}

async function remotePostState(deployment, body, options) {
  const identity = await readDeploymentIdentity(deployment)
  if (!identity) return { ok: false, reason: 'identity-unavailable' }
  // No retry and no rediscovery: a failed remote state POST is dropped. The
  // tunnel health is owned by Clawd's Remote SSH runtime, not by this bridge.
  return request(identity.remotePort, 'POST', '/state', body, {
    signal: options.signal,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS,
    maxResponseBytes: 4096,
    headers: nonceHeaders(identity),
  })
}

async function remoteRequestPermission(deployment, body, options) {
  const initialIdentity = await readDeploymentIdentity(deployment)
  if (!initialIdentity) return { kind: 'no-decision' }
  // A blocked approval is expensive to leave pending on a dead tunnel. Probe
  // the same nonce-protected endpoint first, quickly and with a hard bound.
  if (!(await remoteProbe(initialIdentity, {
    signal: options.signal,
    timeoutMs: options.probeTimeoutMs,
  }))) {
    return { kind: 'no-decision' }
  }
  // The deployment can be replaced while the probe is in flight. Only POST to
  // the identity that the successful probe used.
  const requestIdentity = await readDeploymentIdentity(deployment)
  if (!sameDeploymentIdentity(initialIdentity, requestIdentity)) {
    return { kind: 'no-decision' }
  }

  const controller = new AbortController()
  let settled = false
  let livenessAborted = false
  let failures = 0
  const externalSignal = options.signal
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const intervalMs = Number.isFinite(options.livenessIntervalMs)
    ? options.livenessIntervalMs
    : PERMISSION_LIVENESS_INTERVAL_MS
  const livenessTimeoutMs = Number.isFinite(options.livenessProbeTimeoutMs)
    ? options.livenessProbeTimeoutMs
    : PERMISSION_LIVENESS_TIMEOUT_MS
  const checkLiveness = async () => {
    if (settled || controller.signal.aborted) return
    const identity = await readDeploymentIdentity(deployment)
    if (!settled && !sameDeploymentIdentity(requestIdentity, identity)) {
      // A different deployment now owns the tunnel. The pending POST belongs
      // to the old identity, so it must be abandoned immediately.
      livenessAborted = true
      controller.abort()
      return
    }
    const alive = identity
      ? await remoteProbe(identity, { signal: controller.signal, timeoutMs: livenessTimeoutMs })
      : false
    if (settled) return
    if (alive) {
      failures = 0
      return
    }
    failures += 1
    if (failures >= PERMISSION_LIVENESS_FAILURES && !controller.signal.aborted) {
      livenessAborted = true
      controller.abort()
    }
  }
  const timer = setInterval(() => { void checkLiveness() }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  try {
    const result = await request(requestIdentity.remotePort, 'POST', '/permission', body, {
      signal: controller.signal,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : PERMISSION_TIMEOUT_MS,
      maxResponseBytes: 16 * 1024,
      headers: nonceHeaders(requestIdentity),
    })
    if (livenessAborted) return { kind: 'no-decision' }
    return parsePermissionResult(result)
  } finally {
    settled = true
    clearInterval(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }
}

export async function postState(body, options = {}) {
  const mode = await resolveTransportMode()
  const localOptions = {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS,
    maxResponseBytes: 4096,
  }
  if (mode.kind === 'local') return localPost('/state', body, localOptions)
  if (mode.kind === 'remote') return remotePostState(mode.deployment, body, localOptions)
  return { ok: false, reason: 'deployment-unknown' }
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
  const mode = await resolveTransportMode()
  if (mode.kind === 'unknown') return { kind: 'no-decision' }
  if (mode.kind === 'remote') {
    return remoteRequestPermission(mode.deployment, body, {
      ...options,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : PERMISSION_TIMEOUT_MS,
    })
  }
  const result = await localPost('/permission', body, {
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

export function clearTransportModeForTest() {
  transportModePromise = null
}

export const __test = Object.freeze({
  waitForDiscovery,
  request,
  probe,
  validPort,
  ports: PORTS,
  runtimePath: RUNTIME_PATH,
  resolveManifestPath,
  validateDeployment,
  readDeploymentIdentity,
  resolveTransportMode,
  clearTransportModeForTest,
  remoteProbe,
  setRemotePortValidatorForTest(validator) {
    remotePortValidatorForTest = typeof validator === "function" ? validator : null
  },
})
