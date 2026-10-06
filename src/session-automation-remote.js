"use strict";

const REVOKE_ACTION_PREFIX = "session-grant:revoke:";
const DEFAULT_CARD_WORK_LIMIT = 64;
const DEFAULT_CARD_WORK_DEADLINE_MS = 10_000;

function buildSessionGrantRevokeAction(grantId) {
  const id = typeof grantId === "string" ? grantId.trim() : "";
  return id ? `${REVOKE_ACTION_PREFIX}${id}` : "";
}

function parseSessionGrantRevokeAction(value) {
  if (typeof value !== "string" || !value.startsWith(REVOKE_ACTION_PREFIX)) return null;
  const grantId = value.slice(REVOKE_ACTION_PREFIX.length);
  return grantId && grantId.length <= 128 ? grantId : null;
}

function createRemoteCardWorkRegistry(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_CARD_WORK_LIMIT;
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : DEFAULT_CARD_WORK_DEADLINE_MS;
  const log = typeof options.log === "function" ? options.log : () => {};
  const slots = new Map();
  const slotByHandle = new WeakMap();
  const activeByGrant = new Map();
  let nextId = 0;

  function removeActive(slot) {
    if (!slot || !slot.grantId) return;
    const set = activeByGrant.get(slot.grantId);
    if (!set) return;
    set.delete(slot.handle);
    if (set.size === 0) activeByGrant.delete(slot.grantId);
  }

  function releaseSlot(slot) {
    if (!slot || slot.released) return false;
    slot.released = true;
    removeActive(slot);
    slots.delete(slot.id);
    return true;
  }

  function reserve(grantId, cardRef) {
    const id = typeof grantId === "string" ? grantId.trim() : "";
    if (!id || !cardRef || typeof cardRef !== "object" || slots.size >= limit) return null;
    const handle = Object.freeze({});
    const slot = {
      id: ++nextId,
      handle,
      grantId: id,
      cardRef,
      state: "candidate",
      outcome: "candidate",
      inFlight: null,
      next: null,
      released: false,
    };
    slots.set(slot.id, slot);
    slotByHandle.set(handle, slot);
    return handle;
  }

  function getSlot(handle) {
    const slot = handle && typeof handle === "object" ? slotByHandle.get(handle) : null;
    return slot && !slot.released ? slot : null;
  }

  function getCardRef(handle) {
    const slot = getSlot(handle);
    return slot ? slot.cardRef : null;
  }

  function activate(handle, grantId) {
    const slot = getSlot(handle);
    const id = typeof grantId === "string" ? grantId.trim() : "";
    if (!slot || !id) return false;
    removeActive(slot);
    slot.grantId = id;
    slot.state = "active";
    let set = activeByGrant.get(id);
    if (!set) {
      set = new Set();
      activeByGrant.set(id, set);
    }
    set.add(handle);
    return true;
  }

  function bindCandidateGrant(handle, grantId) {
    const slot = getSlot(handle);
    const id = typeof grantId === "string" ? grantId.trim() : "";
    if (!slot || slot.state !== "candidate" || !id) return false;
    slot.grantId = id;
    return true;
  }

  function settleWork(work, result) {
    for (const resolve of work.waiters) {
      try { resolve(result); } catch {}
    }
  }

  function startNext(slot) {
    if (!slot || slot.released || slot.inFlight || !slot.next) return;
    const work = slot.next;
    slot.next = null;
    slot.inFlight = work;
    slot.outcome = work.outcome;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    work.controller = controller;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) {
          try { controller.abort(); } catch {}
        }
        reject(new Error("remote card edit deadline exceeded"));
      }, deadlineMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    Promise.race([
      Promise.resolve().then(() => work.task(slot.cardRef, {
        signal: controller ? controller.signal : undefined,
        outcome: work.outcome,
      })),
      timeout,
    ]).then(
      () => settleWork(work, true),
      (err) => {
        try { log(err); } catch {}
        settleWork(work, false);
      }
    ).finally(() => {
      if (timer) clearTimeout(timer);
      if (slot.inFlight === work) slot.inFlight = null;
      if (work.terminal) {
        if (slot.next) {
          settleWork(slot.next, false);
          slot.next = null;
        }
        releaseSlot(slot);
        return;
      }
      startNext(slot);
    });
  }

  function enqueue(handle, task, config = {}) {
    const slot = getSlot(handle);
    if (!slot || typeof task !== "function") return Promise.resolve(false);
    const terminal = config.terminal === true;
    if (slot.outcome === "terminal" && !terminal) return Promise.resolve(false);
    const outcome = typeof config.outcome === "string" && config.outcome
      ? config.outcome
      : (terminal ? "terminal" : "update");
    return new Promise((resolve) => {
      const work = {
        task,
        terminal,
        outcome: terminal ? "terminal" : outcome,
        waiters: [resolve],
        controller: null,
      };
      if (terminal) {
        slot.outcome = "terminal";
        if (slot.inFlight && !slot.inFlight.terminal && slot.inFlight.controller) {
          try { slot.inFlight.controller.abort(); } catch {}
        }
      }
      if (slot.next) {
        if (slot.next.terminal && !terminal) {
          resolve(false);
          return;
        }
        settleWork(slot.next, false);
      }
      slot.next = work;
      startNext(slot);
    });
  }

  function release(handle) {
    return releaseSlot(getSlot(handle));
  }

  function activeHandles(grantId) {
    const set = activeByGrant.get(grantId);
    return set ? Object.freeze([...set]) : Object.freeze([]);
  }

  function hasActiveCard(grantId, predicate) {
    const handles = activeHandles(grantId);
    for (const handle of handles) {
      const ref = getCardRef(handle);
      if (!predicate || predicate(ref)) return true;
    }
    return false;
  }

  function hasCard(grantId, predicate) {
    for (const slot of slots.values()) {
      if (slot.released || slot.grantId !== grantId) continue;
      if (!predicate || predicate(slot.cardRef)) return true;
    }
    return false;
  }

  function deactivateGrant(grantId, taskFactory) {
    const handles = [...activeHandles(grantId)];
    for (const handle of handles) {
      const slot = getSlot(handle);
      if (!slot) continue;
      removeActive(slot);
      slot.state = "inactive";
      enqueue(handle, (cardRef, taskContext) => (
        typeof taskFactory === "function" ? taskFactory(cardRef, grantId, taskContext) : undefined
      ), { terminal: true, outcome: "terminal" });
    }
    return handles.length;
  }

  return Object.freeze({
    reserve,
    getCardRef,
    bindCandidateGrant,
    activate,
    enqueue,
    release,
    activeHandles,
    hasActiveCard,
    hasCard,
    activeGrantIds: () => Object.freeze([...activeByGrant.keys()]),
    deactivateGrant,
    size: () => slots.size,
  });
}

module.exports = {
  REVOKE_ACTION_PREFIX,
  buildSessionGrantRevokeAction,
  parseSessionGrantRevokeAction,
  createRemoteCardWorkRegistry,
};
