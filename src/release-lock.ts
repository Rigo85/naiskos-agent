import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** The same kernel lock as the root activator. Never unlink/replace its inode.
 * The small shell owns the fd until stdin closes, including if the agent exits.
 */
export async function acquireReleaseLock(dataRoot: string): Promise<(() => Promise<void>) | null> {
  const directory = path.join(dataRoot, "updates");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const holder = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75",
    "--no-fork", path.join(directory, ".software-update.lock"), "/bin/sh", "-c",
    'printf "locked\\n"; read -r release_lock_done; exit 0'], { stdio: ["pipe", "pipe", "pipe"] });
  // Consume stderr without publishing inherited context or paths in log output.
  holder.stderr.resume();
  holder.stdin.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  const acquired = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => { holder.kill("SIGKILL"); reject(new Error("Timeout adquiriendo bloqueo de releases")); }, 5_000);
    const finish = (error: Error | null, busy = false) => {
      clearTimeout(timeout);
      if (error) reject(error); else resolve(!busy);
    };
    holder.once("error", () => finish(new Error("No se pudo ejecutar el bloqueo de releases")));
    holder.stdout.once("data", (data: Buffer) => {
      if (data.toString() === "locked\n") finish(null);
      else { holder.kill("SIGKILL"); finish(new Error("Respuesta de bloqueo inválida")); }
    });
    holder.once("exit", (code) => finish(code === 75 ? null : new Error("El bloqueo de releases terminó antes de tiempo"), code === 75));
  });
  if (!acquired) { await closed; return null; }
  return async () => {
    holder.stdin.end();
    const timeout = setTimeout(() => holder.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(timeout); }
  };
}
