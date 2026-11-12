/**
 * Clawd on Desk — DeepSeek Harness browser half.
 *
 * Clawd runs outside DSH and can only raise the app window (`dsh://open`), so a
 * click on a session lands on whatever conversation the window already showed.
 * Only code inside the page can call the client service `uiWorkspace.openSession`
 * (that is what dsh-pet and the workbench do). This half subscribes to Clawd's
 * loopback SSE stream and performs the switch.
 *
 * Everything here degrades to nothing: no stream, no `uiWorkspace`, or an older
 * DSH all leave the click behaving exactly as before.
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-clawd-bridge",
	factory(require) {
		// Same five ports Clawd's server may bind (hooks/server-config.js order).
		const PORTS = [23333, 23334, 23335, 23336, 23337];
		const STREAM_PATH = "/dsh/focus-stream";
		// Re-probing after a drop costs five fast failures at worst, so a short
		// retry is cheaper than knowing the port: Clawd may restart on another one.
		const RETRY_MS = 3000;

		return {
			name: "dsh-clawd-bridge-client",
			inject: ["uiWorkspace"],
			apply(ctx) {
				let disposed = false;
				let stream;
				let retryTimer;

				const schedule = (delay) => {
					if (disposed) return;
					clearTimeout(retryTimer);
					retryTimer = setTimeout(() => {
						retryTimer = undefined;
						probeFrom(0);
					}, delay);
				};

				const openSession = (sessionId) => {
					// The page decides; a session that was deleted must not throw here.
					try {
						ctx.get("uiWorkspace")?.openSession?.(sessionId);
					} catch {
						// Navigation is optional; the window focus still happened.
					}
				};

				// No separate health probe: a plain `fetch('/state')` would be blocked
				// by CORS (that route grants no origin), while this stream grants the
				// page's origin. Opening EventSource is therefore both the probe and
				// the subscription; the first port that speaks SSE wins.
				const probeFrom = (index) => {
					if (disposed) return;
					if (index >= PORTS.length) {
						schedule(RETRY_MS * 2);
						return;
					}
					const source = new EventSource(`http://127.0.0.1:${PORTS[index]}${STREAM_PATH}`);
					let opened = false;
					source.addEventListener("open", () => {
						if (disposed) {
							source.close();
							return;
						}
						opened = true;
						stream = source;
					});
					source.addEventListener("focus", (event) => {
						if (disposed) return;
						let sessionId;
						try {
							sessionId = JSON.parse(event.data)?.sessionId;
						} catch {
							return;
						}
						if (typeof sessionId === "string" && sessionId !== "") openSession(sessionId);
					});
					source.addEventListener("error", () => {
						source.close();
						if (opened) {
							if (stream === source) stream = undefined;
							schedule(RETRY_MS);
							return;
						}
						probeFrom(index + 1);
					});
				};

				probeFrom(0);

				ctx.effect(() => () => {
					disposed = true;
					clearTimeout(retryTimer);
					stream?.close();
					stream = undefined;
				});
			},
		};
	},
});
