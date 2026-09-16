# Functional kiosk runtime (baseline 13)

`GET /api/v1/viewer/runtime` reports the agent's immutable package identity,
instance ID, viewer session/build, fresh heartbeat, rendered-UI readiness,
navigation deadline and intentional exit state. HTTP availability alone is not
release health. Normal clock repose remains operational, including offline.

The local quiesce endpoint (release-activator header required) issues a nonce.
The viewer checkpoints, cancels navigation, pauses and removes video sources,
then acknowledges that nonce in its heartbeat. A bounded controller closes the
owned launcher/process tree and starts the existing launcher under a transient
systemd unit with its captured graphical environment. It never reboots the
device or starts over a known blocked owner/orphan.

The same controller is used by the watchdog and release runtime. Watchdog and
activator serialize via the activation lock. Voluntary Exit is persisted only
for the current boot; a new ready session clears it. Suspend contingency is
not confused with a dead browser. Three unsuccessful recovery attempts exhaust
the watchdog budget until two minutes of healthy operation.

Observation counts healthy monotonic intervals from the same boot and runtime
sessions. Power-off time, intentional exit and long sampling gaps earn no
credit. Three consecutive failures trigger rollback; the previous runtime must
also pass two functional samples. Unrecoverable kernel threads cause an explicit
failure, not a reboot loop or a false success.

Release reports are fsynced before delivery, retried with deterministic IDs and
retained through ordinary event bursts. `updates/failed` and
`updates/release-reports` are diagnostic evidence, not disposable cache.

## Validation

Run `npm test`, `npm run typecheck` and `npm run build`. Privileged process tests
must run only in a disposable container, with this repository mounted read-only:

```sh
docker run --rm --cap-add SYS_PTRACE \
  -v "$PWD:/workspace-agent:ro" node:24-trixie-slim \
  node /workspace-agent/test/test-kiosk-control-container.mjs
```

That test uses real process ownership/signals but simulated Chromium and
systemd. It verifies controlled stop, context capture and functional rollback;
it does not prove Wayland or ARM64 GPU recovery. Kernel hangs require hardware
observation and may need manual intervention.

The baseline-12-to-13 migration closes the old launcher before the legacy
activation function can kill Chromium alone. A one-time handoff completes the
new restart after the old activation lock is released. If rollback restores an
older build without this contract, it is reported as requiring review, not as
functionally verified. An older restored activator may also require assisted
delivery of retained release reports.
