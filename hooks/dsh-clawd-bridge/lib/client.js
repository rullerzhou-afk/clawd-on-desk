/**
 * Clawd on Desk — DeepSeek Harness browser half.
 *
 * Only code inside the page can call `uiWorkspace.openSession`. Clawd raises
 * the desktop window with `dsh://open` and sends the selected session here.
 * An unavailable stream leaves the click as a plain window focus.
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-clawd-bridge",
	factory(require) {
		// The browser cannot read Clawd's runtime port; try the five legacy ports.
		const PORTS = [23333, 23334, 23335, 23336, 23337];
		// This read-only route grants the desktop page permission to subscribe.
		const STREAM_PATH = "/dsh/focus-stream";
		// Clawd writes headers immediately; two seconds is ample on loopback.
		const PROBE_TIMEOUT_MS = 2000;
		// A dropped stream should recover promptly, including after a port change.
		const RETRY_MS = 3000;
		// If a click lands as 15s backoff starts, four ports accept but never respond,
		// and Clawd is on the fifth: 15 + 4×2 + 2 = 25 seconds, below the 30s replay.
		// This connection budget excludes the DSH page's own loading time.
		const RETRY_MAX_MS = 15000;
		// Bound a cold-start wait so an unavailable list cannot navigate much later.
		const LIST_WAIT_MS = 20000;

		return {
			name: "dsh-clawd-bridge-client",
			inject: ["uiWorkspace", "sessions"],
			apply(ctx) {
				// Web and desktop share sessions, but only desktop sessions are jumpable.
				if (location.protocol !== "dsh-app:") return;

				// Retired callbacks must not reconnect or navigate after plugin unload.
				let disposed = false;
				// The open stream owns focus events until it disconnects.
				let stream;
				// Retain even an unopened source so a hung probe can be closed.
				let connecting;
				// Only the latest click may own a list subscription and wait timer.
				let waiting;
				// A full page refresh loses this id and may replay a click within 30s.
				let lastClickId;
				// One timer bounds the current port probe.
				let probeTimer;
				// One timer schedules the next scan after a drop or a failed round.
				let retryTimer;
				// Consecutive failed rounds back off; an open stream resets this delay.
				let retryDelay = RETRY_MS;

				const cancelWaiting = () => {
					if (!waiting) return;
					const target = waiting;
					waiting = undefined;
					clearTimeout(target.timer);
					target.unsubscribe();
				};

				const openSession = (sessionId) => {
					try {
						ctx.get("uiWorkspace").openSession(sessionId);
					} catch {
						// A deleted session gets one attempt; window focus still succeeded.
					}
				};

				const openWhenListReady = (sessionId) => {
					// Only the latest click waits. Manual navigation while the list loads
					// does not cancel it: this is the latest explicit intent from Clawd.
					cancelWaiting();
					const target = { sessionId, unsubscribe: undefined, timer: undefined };
					waiting = target;
					const onListChange = () => {
						if (disposed || waiting !== target) return;
						if (ctx.get("sessions").list.getSnapshot().phase !== "ready") return;
						cancelWaiting();
						openSession(target.sessionId);
					};
					// Subscribe before reading so a ready transition cannot be missed.
					target.unsubscribe = ctx.get("sessions").list.subscribe(onListChange);
					onListChange();
					if (waiting === target) target.timer = setTimeout(cancelWaiting, LIST_WAIT_MS);
				};

				const handleFocusFrame = (event) => {
					let payload;
					try {
						payload = JSON.parse(event.data);
					} catch {
						return;
					}
					if (typeof payload?.clickId !== "string" || !payload.clickId.trim()) return;
					if (typeof payload.sessionId !== "string" || !payload.sessionId.trim()) return;
					if (payload.clickId === lastClickId) return;
					lastClickId = payload.clickId;
					openWhenListReady(payload.sessionId);
				};

				const scheduleNextScan = (delay) => {
					if (disposed) return;
					clearTimeout(retryTimer);
					retryTimer = setTimeout(() => {
						retryTimer = undefined;
						probeFrom(0);
					}, delay);
				};

				const failProbe = (source, portIndex) => {
					// Late open/error events from a timed-out probe cannot start a scan.
					if (disposed || connecting !== source) return;
					clearTimeout(probeTimer);
					probeTimer = undefined;
					connecting = undefined;
					source.close();
					probeFrom(portIndex + 1);
				};

				const acceptStream = (source) => {
					if (disposed || connecting !== source) return;
					clearTimeout(probeTimer);
					probeTimer = undefined;
					connecting = undefined;
					stream = source;
					retryDelay = RETRY_MS;
				};

				const handleStreamError = (source, portIndex) => {
					if (disposed) return;
					// Other sources are probing or already retired; failProbe compares
					// connecting to decide whether to ignore their stale callbacks.
					if (stream !== source) {
						failProbe(source, portIndex);
						return;
					}
					stream = undefined;
					source.close();
					// Clawd was just reachable, so reconnect in three seconds without backoff.
					scheduleNextScan(RETRY_MS);
				};

				const probeFrom = (portIndex) => {
					if (disposed) return;
					if (portIndex >= PORTS.length) {
						scheduleNextScan(retryDelay);
						retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
						return;
					}
					// EventSource is both the probe and the subscription; /state has no CORS.
					const source = new EventSource(`http://127.0.0.1:${PORTS[portIndex]}${STREAM_PATH}`);
					connecting = source;
					probeTimer = setTimeout(() => failProbe(source, portIndex), PROBE_TIMEOUT_MS);
					source.addEventListener("open", () => acceptStream(source));
					source.addEventListener("error", () => handleStreamError(source, portIndex));
					source.addEventListener("focus", (event) => {
						if (!disposed && stream === source) handleFocusFrame(event);
					});
				};

				ctx.effect(() => () => {
					disposed = true;
					clearTimeout(retryTimer);
					clearTimeout(probeTimer);
					cancelWaiting();
					connecting?.close();
					stream?.close();
					connecting = stream = undefined;
				});
				probeFrom(0);
			},
		};
	},
});
