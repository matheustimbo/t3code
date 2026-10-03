Run from an installed checkout with Node 25.7+ and the production server bundle.
The experiment starts only disposable local servers; it never accesses live T3 state.

```sh
node apps/server/integration/mainPoolResilience.mjs bundle /absolute/path/to/dist/bin.mjs /absolute/path/to/node
```

For the release standalone/SEA path, build the normal production standalone bundle
first. Create a **test-only** SEA alongside its normal runtime dependencies (native
`node_modules`, project worker, resource monitor, and client assets). The builder
embeds only the fault preload before the unchanged production bundle and reports
both hashes. Never deploy this executable.

```sh
node apps/server/integration/buildMainPoolFaultSea.mjs /absolute/path/to/dist-exe/bin.mjs /absolute/path/to/node /absolute/path/to/release-tree/t3-test-pool16
node apps/server/integration/mainPoolResilience.mjs sea /absolute/path/to/release-tree/t3-test-pool16 /absolute/path/to/node
```

Build an exact `6970900` (`v0.1.88`) control in a separate checkout and run the same
invocation with `--expect-failure`. A negative control passes only if healthy
startup/auth/config checks first pass, native saturation is proven, and a probe
then fails under saturation. `--healthy-only` validates artifact packaging without
injecting faults.

The server receives `UV_THREADPOOL_SIZE=16` before startup. After warming HTTP,
authentication, public settings, config, and subscriptions, 16 real
`fs.promises.open` calls wait for FIFO writers in the main process. A queued `stat`
sentinel must remain pending while the event loop answers IPC heartbeats. On macOS,
`sample` must show 16 workers blocked in native filesystem `open` when sampling is
available. Probe processes have their own four-worker pool and use fresh HTTP
connections plus a newly admitted authenticated WebSocket every round.

Three rounds check descriptor identity, configured label, version, and meaningful
capabilities with identity/gzip/br/deflate offers. HTTP and WebSocket admission have
strict 500 ms deadlines. Public settings and `server.probe` also have 500 ms
deadlines. `server.getConfig` and the initial `subscribeServerConfig` snapshot have
3 s deadlines to permit the production editor/remote-target discovery timeout;
both must preserve the descriptor, settings, workspace, and config capabilities.
After saturation the controller appends whitespace to the disposable keybindings
file. The preload observes the first real native access/stat/readFile queued for
that file after the watch event, so the reconnect probes run after the watcher has
invalidated the disk cache, while the previous resident snapshot remains available.
While saturation remains active, the independent controller writes three synthetic
publishing secret files directly in the disposable store, waits for the real
observer's public boolean IPC receipt, and requires descriptor/config/snapshot
capabilities to converge to true. Removing the synthetic credential must converge
back to false. Each receipt has a 6.5 s bound (5 s refresh + 1 s observation
deadline + 0.5 s scheduling allowance), followed by the same strict network probes.
External file writes intentionally bypass inline secret-store mutation hooks.
Only booleans cross the observer IPC; credential contents never enter evidence.
The preload observes real child spawn/exit without replacing either operation;
helper PID, parent PID, independent one-worker pool, and reap are verified.
Wire content encoding is recorded; compressed responses are actually decompressed
in the independent probe process. A server that intentionally declines compression
still validates the same >1 KiB body for every offer.

Cleanup uses an independent process with `O_WRONLY | O_NONBLOCK` FIFO opens and a
deadline, never a synchronous blocking writer in the server. Every open and the
sentinel must drain before bounded shutdown. Evidence and redacted startup logs
are retained in the printed disposable directory; cookies/tokens are excluded
from evidence. No package script is required.
