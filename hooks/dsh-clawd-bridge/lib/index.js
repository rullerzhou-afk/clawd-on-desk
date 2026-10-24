// Clawd on Desk bridge for DeepSeek Harness.
//
// Public seams only:
//   - session/created, session/event, session/disposed for state
//   - sessionProjections snapshot/onChanged for context occupancy
//   - approval/request waterfall for ordinary tool approvals
//
// The plugin deliberately does not register or replace userQuestions. DSH's
// native provider remains the sole owner of ask_user_question.

import { randomUUID } from 'node:crypto'
import { postState, requestPermission } from './clawd-client.js'

export const name = 'dsh-clawd-bridge'

const AGENT_ID = 'deepseek-harness'
const HOOK_SOURCE = 'dsh-plugin'
const DESKTOP_CARRIER = 'desktop'
const SESSION_PREFIX = `${AGENT_ID}:`
const MAX_QUEUE_PER_SESSION = 32
const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const TITLE_MAX = 80
const TEXT_MAX = 500
// Bounded like the outbound queue: a long-lived host can meet many sessions, and
// each remembered title is at most TITLE_MAX.
const MAX_TRACKED_TITLES = 200

const CRITICAL_EVENTS = new Set([
  'SessionStart',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'SessionEnd',
])

function boundedText(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  return Array.from(clean).slice(0, max).join('')
}

// The carrier is read once, at apply time, from the boot-provided profile
// context. DSH provides the context before config-tree plugins are mounted, so
// `profileContext.name` is already available. Only the exact "desktop" name
// counts; a missing context, a throw, "web", or any other value is unknown and
// must not be reported as the desktop carrier.
export function resolveProfileCarrier(ctx) {
  let profileName
  try {
    profileName = ctx?.profileContext?.name
  } catch {
    return null
  }
  return typeof profileName === 'string' && profileName === DESKTOP_CARRIER
    ? DESKTOP_CARRIER
    : null
}

export function canonicalSessionId(value) {
  const raw = boundedText(value, 200)
  if (!raw) return `${SESSION_PREFIX}default`
  return raw.startsWith(SESSION_PREFIX) ? raw : `${SESSION_PREFIX}${raw}`
}

function sessionFields(session) {
  const rawId = session?.id
  const cwd = boundedText(session?.header?.cwd, 4096)
  const headless = session?.header?.origin === 'subagent'
  return {
    session_id: canonicalSessionId(rawId),
    ...(cwd ? { cwd } : {}),
    ...(headless ? { headless: true } : {}),
    ...(headless ? { recap_is_subagent: true } : {}),
  }
}

export function statePayload(session, mapping, sequence = {}, carrier = null) {
  return {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    agent_pid: process.pid,
    ...(carrier === DESKTOP_CARRIER ? { dsh_carrier: DESKTOP_CARRIER } : {}),
    ...sessionFields(session),
    state: mapping.state,
    event: mapping.event,
    ...(mapping.toolName ? { tool_name: boundedText(mapping.toolName, 160) } : {}),
    ...(mapping.title ? { session_title: boundedText(mapping.title, TITLE_MAX) } : {}),
    ...(mapping.contextUsage ? { context_usage: mapping.contextUsage } : {}),
    ...(Number.isSafeInteger(sequence.eventSeq) && sequence.eventSeq >= 0
      ? { event_seq: sequence.eventSeq }
      : {}),
    ...(Number.isSafeInteger(sequence.sessionSeq) && sequence.sessionSeq >= 0
      ? { session_seq: sequence.sessionSeq }
      : {}),
  }
}

// DSH's own ContextMeter displays this projection as a reference occupancy.
// The next-request estimate is preferred over the last provider sample.
export function contextUsageFromPressure(pressure) {
  if (!pressure || typeof pressure !== 'object') return null
  const used = pressure.projectedTokens ?? pressure.pressureTokens
  const limit = pressure.contextWindow
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null
  return {
    used,
    limit,
    percent: Math.max(0, Math.min(100, Math.round(used / limit * 100))),
  }
}

// Metadata (title / context occupancy) only annotates an existing session and
// deliberately never carries the carrier: a metadata-only request must not be
// able to change where a session came from.
export function metadataPayload(session, metadata = {}) {
  const title = boundedText(metadata.title, TITLE_MAX)
  const hasContextPressure = Object.hasOwn(metadata, 'contextPressure')
  const contextUsage = contextUsageFromPressure(metadata.contextPressure)
  if (!title && !hasContextPressure) return null
  return {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    agent_pid: process.pid,
    ...sessionFields(session),
    metadata_only: true,
    ...(title ? { session_title: title } : {}),
    ...(hasContextPressure ? { context_usage: contextUsage } : {}),
  }
}

export function mapSessionEvent(event) {
  const type = event?.type
  if (type === 'turn/start') return { event: 'UserPromptSubmit', state: 'thinking' }
  if (type === 'tool/call') {
    return { event: 'PreToolUse', state: 'working', toolName: event?.data?.name }
  }
  if (type === 'tool/result') {
    const content = event?.data?.message?.content
    // 0.2.x marks a failed result on the message; 0.1.x marks it on the content item.
    const messageFlagged = event?.data?.message?.isError === true
    const contentFlagged = Array.isArray(content) && content.some((item) => item?.isError === true)
    const failed = Boolean(event?.data?.error) || messageFlagged || contentFlagged
    return failed
      ? { event: 'PostToolUseFailure', state: 'error' }
      : { event: 'PostToolUse', state: 'working' }
  }
  if (type === 'turn/end') {
    const rawReason = event?.data?.reason
    const reasonKind = boundedText(
      rawReason && typeof rawReason === 'object' ? rawReason.kind : rawReason,
      80,
    ).toLowerCase()
    return reasonKind === 'error'
      ? { event: 'StopFailure', state: 'error' }
      : { event: 'Stop', state: 'attention' }
  }
  return null
}

export function buildApprovalPayload(req, carrier = null) {
  const session = req?.agent?.session
  const rawId = session?.id ?? req?.agent?.id
  const cwd = boundedText(session?.header?.cwd, 4096)
  const callId = boundedText(req?.callId, 200)
  const headless = session?.header?.origin === 'subagent'
  return {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    hook_event_name: 'PermissionRequest',
    session_id: canonicalSessionId(rawId),
    ...(carrier === DESKTOP_CARRIER ? { dsh_carrier: DESKTOP_CARRIER } : {}),
    tool_name: boundedText(req?.toolName, 160) || 'unknown',
    tool_use_id: callId || randomUUID(),
    tool_input: {},
    reason: boundedText(req?.reason, TEXT_MAX),
    agent_pid: process.pid,
    ...(cwd ? { cwd } : {}),
    ...(headless ? { headless: true } : {}),
  }
}

export function createStateSender(signal, postStateImpl = postState) {
  const queues = new Map()

  function compact(queue, payload) {
    if (payload.metadata_only) {
      const last = queue[queue.length - 1]
      if (last?.metadata_only) {
        queue[queue.length - 1] = { ...last, ...payload }
        return true
      }
      if (queue.length >= MAX_QUEUE_PER_SESSION) {
        const lifecycleBoundary = queue.findLastIndex((item) =>
          item.event === 'SessionStart' || item.event === 'SessionEnd')
        const oldMetadata = queue.findLastIndex((item, index) =>
          index > lifecycleBoundary && item.metadata_only)
        if (oldMetadata !== -1) {
          queue.push({ ...queue.splice(oldMetadata, 1)[0], ...payload })
          return true
        }
        const replaceable = queue.findIndex((item) => !CRITICAL_EVENTS.has(item.event))
        if (replaceable === -1) return false
        queue.splice(replaceable, 1)
        queue.push(payload)
        return true
      }
    }
    if (queue.length < MAX_QUEUE_PER_SESSION) {
      queue.push(payload)
      return true
    }
    if (!CRITICAL_EVENTS.has(payload.event)) return false
    const replaceable = queue.findIndex((item) => !CRITICAL_EVENTS.has(item.event))
    if (replaceable !== -1) {
      queue.splice(replaceable, 1)
      queue.push(payload)
      return true
    }
    // A queue made entirely of critical state is only possible through
    // repeated equivalent transitions. Keep the newest failure/terminal
    // watermark while preserving the original SessionStart boundary.
    let coalescible = -1
    if (payload.event !== 'SessionStart') {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].event === payload.event) {
          coalescible = index
          break
        }
      }
    }
    if (coalescible === -1) return false
    queue.splice(coalescible, 1)
    queue.push(payload)
    return true
  }

  async function drain(sessionId, record) {
    if (record.draining) return
    record.draining = true
    try {
      while (!signal.aborted && record.items.length > 0) {
        const payload = record.items.shift()
        try {
          await postStateImpl(payload, { signal })
        } catch {
          // State observation is best-effort and may never damage the host.
        }
      }
    } finally {
      record.draining = false
      if (record.items.length === 0) queues.delete(sessionId)
    }
  }

  return {
    enqueue(payload) {
      if (signal.aborted || !payload?.session_id) return false
      let record = queues.get(payload.session_id)
      if (!record) {
        record = { draining: false, items: [] }
        queues.set(payload.session_id, record)
      }
      const accepted = compact(record.items, payload)
      if (accepted) void drain(payload.session_id, record)
      return accepted
    },
    clear() {
      queues.clear()
    },
  }
}

function linkAbortSignals(signals) {
  const controller = new AbortController()
  const listeners = []
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (!signal || typeof signal.addEventListener !== 'function') continue
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(signal)
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const signal of listeners) signal.removeEventListener('abort', abort)
    },
  }
}

export function createApprovalHandler(
  requestPermissionImpl = requestPermission,
  permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
  lifetimeSignal = null,
  carrier = null,
) {
  return async (req, next) => {
    if (req?.signal?.aborted) return 'cancelled'
    // A plugin reload/dispose only removes this answerer. It must not claim
    // that the DSH asker cancelled the approval; continue to the next
    // waterfall listener so the native/web answerer can take over.
    if (lifetimeSignal?.aborted) return next()
    const linked = linkAbortSignals([req?.signal, lifetimeSignal])
    let answer
    try {
      answer = await requestPermissionImpl(buildApprovalPayload(req, carrier), {
        signal: linked.signal,
        timeoutMs: permissionTimeoutMs,
      })
    } catch {
      answer = { kind: 'no-decision' }
    } finally {
      linked.cleanup()
    }
    if (req?.signal?.aborted) return 'cancelled'
    if (lifetimeSignal?.aborted) return next()
    if (answer?.kind === 'cancelled') return 'cancelled'
    if (answer?.kind === 'decision') {
      return answer.decision === 'allow' ? 'allowed-once' : 'rejected'
    }
    // The waterfall continuation is linear. Let ApprovalService normalize a
    // downstream failure; retrying or translating it here would make this
    // listener a second owner of the remaining answerer chain.
    return next()
  }
}

// Builds the public-seam observer set for one plugin generation. `sender` is
// the only outbound dependency, so tests can inject a recording sender without
// touching the network; apply() wires these into the DSH context and owns
// disposal.
export function createSessionObservers(sender, options = {}) {
  const lifetimeSignal = options.lifetimeSignal || null
  const permissionTimeoutMs = Number.isFinite(options.permissionTimeoutMs)
    ? options.permissionTimeoutMs
    : DEFAULT_PERMISSION_TIMEOUT_MS
  const requestPermissionImpl = typeof options.requestPermissionImpl === 'function'
    ? options.requestPermissionImpl
    : requestPermission
  // The carrier travels with the observer set instead of module scope so two
  // plugin instances (or a reload) can never leak one context's profile into
  // the other's payloads.
  const carrier = options.carrier === DESKTOP_CARRIER ? DESKTOP_CARRIER : null
  let projectionRegistry = null

  const safely = (work) => (...args) => {
    if (lifetimeSignal?.aborted) return
    try {
      work(...args)
    } catch {
      // session/created synchronous throws veto and roll back DSH session
      // publication. Every observer boundary is intentionally non-throwing.
    }
  }

  // DSH publishes session/title as a metadata-only request, and Clawd only lets
  // metadata annotate a session it already holds: a title that arrives before
  // the first state event is dropped with no retry. The bridge therefore
  // remembers the title per session and re-attaches it to state payloads, which
  // are what create (and can recreate) the row. A session this plugin generation
  // met after creation - a reload, or the desktop app reopening a conversation -
  // is asked once for its current projection, because DSH never re-emits a title
  // it already generated.
  const sessionTitles = new Map()
  const titleSnapshotAttempted = new Set()

  function rememberSessionTitle(session, value) {
    const id = canonicalSessionId(session?.id)
    const title = boundedText(value, TITLE_MAX)
    if (!title) return null
    if (sessionTitles.size >= MAX_TRACKED_TITLES && !sessionTitles.has(id)) {
      const oldest = sessionTitles.keys().next().value
      if (oldest !== undefined) sessionTitles.delete(oldest)
    }
    sessionTitles.set(id, title)
    return title
  }

  function snapshotSessionTitle(session) {
    // Until the projection service is injected there is nothing to ask; do not
    // spend the one attempt an early event would otherwise consume.
    if (!projectionRegistry) return null
    const id = canonicalSessionId(session?.id)
    if (titleSnapshotAttempted.has(id)) return null
    titleSnapshotAttempted.add(id)
    try {
      return rememberSessionTitle(
        session,
        projectionRegistry.snapshot(session, ['title'])?.values?.title
      )
    } catch {
      // An optional projection must never block a state report.
      return null
    }
  }

  function forgetSessionTitle(session) {
    const id = canonicalSessionId(session?.id)
    sessionTitles.delete(id)
    titleSnapshotAttempted.delete(id)
  }

  const handleSessionCreated = safely((session) => {
    let metadata = null
    try {
      metadata = projectionRegistry?.snapshot(session, ['title', 'contextPressure'])?.values
    } catch {
      // An optional projection must never veto DSH session creation.
    }
    rememberSessionTitle(session, metadata?.title)
    rememberSessionTitle(session, metadata?.title)
    const contextUsage = contextUsageFromPressure(metadata?.contextPressure)
    sender.enqueue(statePayload(session, {
      event: 'SessionStart',
      state: 'idle',
      title: metadata?.title,
      contextUsage,
    }, { sessionSeq: session?.seq }, carrier))
    if (!contextUsage) {
      // A resumed session may still have an old Clawd context value. Match
      // DSH's ContextMeter, which hides occupancy without both operands.
      sender.enqueue(metadataPayload(session, { contextPressure: metadata?.contextPressure }))
    }
  })

  const handleSessionEvent = safely((session, event) => {
    if (event?.type === 'session/title') {
      const title = rememberSessionTitle(session, event?.data?.title)
      const titlePayload = title ? metadataPayload(session, { title }) : null
      if (titlePayload) sender.enqueue(titlePayload)
    }
    const mapping = mapSessionEvent(event)
    if (!mapping) return
    // A metadata-only title cannot create a row, so anything it cannot deliver
    // yet has to ride this state payload instead.
    const knownTitle = sessionTitles.get(canonicalSessionId(session?.id)) || snapshotSessionTitle(session)
    sender.enqueue(statePayload(
      session,
      knownTitle ? { ...mapping, title: mapping.title || knownTitle } : mapping,
      { eventSeq: event?.seq },
      carrier
    ))
  })

  const handleSessionDisposed = safely((session) => {
    forgetSessionTitle(session)
    sender.enqueue(statePayload(session, {
      event: 'SessionEnd',
      state: 'sleeping',
    }, { sessionSeq: session?.seq }, carrier))
  })

  const attachProjections = (projectionCtx) => {
    const registry = projectionCtx?.sessionProjections
    if (!registry || typeof registry.onChanged !== 'function') return
    projectionRegistry = registry
    const unsubscribe = registry.onChanged(safely((session, key, value) => {
      if (key !== 'contextPressure') return
      const payload = metadataPayload(session, { contextPressure: value })
      if (payload) sender.enqueue(payload)
    }))
    projectionCtx.effect(() => () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      if (projectionRegistry === registry) projectionRegistry = null
    }, 'clawd projection detachment')
  }

  const attachApproval = (approvalCtx) => {
    if (!approvalCtx || typeof approvalCtx.on !== 'function') return
    approvalCtx.on(
      'approval/request',
      createApprovalHandler(requestPermissionImpl, permissionTimeoutMs, lifetimeSignal, carrier),
      { prepend: true },
    )
  }

  return {
    handleSessionCreated,
    handleSessionEvent,
    handleSessionDisposed,
    attachProjections,
    attachApproval,
  }
}

export function apply(ctx, config = {}) {
  if (
    !ctx
    || typeof ctx.on !== 'function'
    || typeof ctx.inject !== 'function'
    || typeof ctx.effect !== 'function'
  ) return
  const generation = new AbortController()
  const sender = createStateSender(generation.signal)
  const permissionTimeoutMs = Number.isFinite(config.permissionTimeoutMs)
    ? Math.max(1000, config.permissionTimeoutMs)
    : DEFAULT_PERMISSION_TIMEOUT_MS
  const observers = createSessionObservers(sender, {
    lifetimeSignal: generation.signal,
    permissionTimeoutMs,
    carrier: resolveProfileCarrier(ctx),
  })

  ctx.on('session/created', observers.handleSessionCreated)
  ctx.on('session/event', observers.handleSessionEvent)
  ctx.on('session/disposed', observers.handleSessionDisposed)

  ctx.inject(['sessionProjections'], observers.attachProjections)
  ctx.inject(['approval'], observers.attachApproval)

  ctx.effect(() => () => {
    generation.abort()
    sender.clear()
  }, 'clawd bridge disposal')
}

export default apply
