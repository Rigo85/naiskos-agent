# Emergency recovery (baseline 17)

The existing kiosk watchdog owns recovery; no competing reboot daemon is added.
This restores availability after failed bounded recovery. It does **not** fix
the kernel's video driver or guarantee recovery from every hardware fault.

## State and decisions

- Poll every 15 seconds. Require 120 seconds of unhealthy runtime before action.
- If the agent API is unavailable, attempt one bounded agent restart first.
- Attempt at most three bounded viewer restarts. A failed stop with persistent
  kernel-blocked threads escalates on the following independent observation.
- Track failed-stop PIDs with process start identity, including reparented
  Chromium leaders with surviving D-state threads. Never open a second browser
  over the previous instance. A stale quiesce flag is not a maintenance lock.
- Root state under `recovery/state.json` survives supervisor and machine restarts.
  Writes fsync the file and directory. Queue capacity is 128 unacknowledged
  events; exhaustion fails closed instead of discarding incident evidence.
- Allow one emergency reboot per 24 hours of **accumulated operating uptime**.
  Powered-off time does not replenish the budget. This is intentionally more
  conservative than wall-clock hours, and immune to NTP jumps. Normal updates
  and manual reboots are not charged to this budget.
- Repeated failure within the budget produces an intervention-required event;
  there is no automatic video disabling or promise of a working photo-only mode.
- A persisted request can be handed to systemd at most twice in the same boot
  if the supervisor crashed at the handoff. This is one reboot intent, not two
  reboot allowances. A new boot ID starts verification, not immediate success.

## Coordination and shutdown

Recovery holds locks in this order: system maintenance, release activation,
software staging. It checks release transition state and APT/dpkg locks.
Managed maintenance cannot start after emergency handoff: a `/run` sentinel
is checked under its own lock. Manually launched package managers are outside
the managed coordination contract; do not run them concurrently with recovery.

Voluntary exit/poweroff is persisted per boot; repose and overlays are valid
viewer states. A device with no graphical launch context is not rebooted for
missing Chromium. API/network failure alone does not immediately trigger reboot.

An emergency installs a **runtime-only** shutdown.target timeout of 180 seconds,
then requests an orderly systemctl reboot. Its final fallback is reboot-force,
not immediate `--force --force`. The existing hardware watchdog remains the
last safety net for shutdown's later phase. The runtime drop-in clears on boot;
normal poweroff/update behavior is not permanently changed. An unrecoverable
shutdown still entails residual data-loss risk; fsync cannot cure broken storage.

## Reports and verification

The supervisor has its own durable event queue and sends authenticated events
to the central server without depending on Angular or the agent API. A network
attempt has a 3-second deadline; lack of Telegram delivery never gates reboot.
Events are removed only after central ACK. The latest bounded diagnostic contains
kernel logs, runtime and PID/start/state/thread counts, not process environments.

After a new boot, require at least 120 seconds of healthy viewer observations
and progress (video time, photo timer/scene) or a responsive intentional overlay/
repose state. After five minutes without confirmation report failure, not success.
Agent/API liveness alone is insufficient. Actual blocked kernel threads and
ARM64 graphics remain hardware-observation cases; tests must not induce hangs
on a working user device.

Run `npm test`, `npm run build`, and the disposable-container tests
`test/test-kiosk-control-container.mjs`, `test/test-emergency-recovery-container.mjs`.
The latter uses real root paths/locks but **simulates systemctl**, never rebooting
the host. Persisted state corruption or inability to save the reboot budget
prevents an automatic reboot and requires intervention.
