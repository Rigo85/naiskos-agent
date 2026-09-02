#!/opt/node24/bin/node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const [command, ...args] = process.argv.slice(2);

if (command === "verify-request") {
  const [requestFile, publicKeyFile, baselineFile] = args;
  const request = JSON.parse(await readFile(required(requestFile), "utf8"));
  const releaseId = String(request.releaseId ?? "");
  const campaignId = String(request.campaignId ?? "");
  if (!releaseIdPattern(releaseId) || !uuidPattern(campaignId)) fail("Solicitud inválida");
  const expectedRoot = `/var/lib/naiskos/updates/${releaseId}`;
  for (const name of ["manifestFile", "signatureFile", "archiveFile"]) {
    const resolved = await realpath(String(request[name] ?? ""));
    if (!resolved.startsWith(`${expectedRoot}/`)) fail(`Ruta ${name} fuera del staging`);
  }
  const manifestBytes = await readFile(request.manifestFile);
  if (!verify(null, manifestBytes, await readFile(required(publicKeyFile)), await readFile(request.signatureFile))) {
    fail("Firma inválida");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const baseline = JSON.parse(await readFile(required(baselineFile), "utf8"));
  if (
    manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId ||
    manifest.compatibility?.nodeMajor !== 24 ||
    !manifest.compatibility?.architectures?.includes("arm64") ||
    Number(baseline.baselineVersion) < Number(manifest.compatibility?.minimumBaselineVersion)
  ) fail("Release incompatible con el baseline");
  const details = await stat(request.archiveFile);
  if (details.size !== manifest.archive?.sizeBytes || await sha256(request.archiveFile) !== manifest.archive?.sha256) {
    fail("Archivo incompleto o alterado");
  }
  const from = String(request.maintenanceWindow?.from ?? "");
  const until = String(request.maintenanceWindow?.until ?? "");
  if (!timePattern(from) || !timePattern(until)) fail("Ventana inválida");
  const observe = Number(request.observeMinutes);
  if (!Number.isInteger(observe) || observe < 1 || observe > 10080) fail("Observación inválida");
  process.stdout.write([
    campaignId, releaseId, request.manifestFile, request.archiveFile,
    from, until, String(observe),
  ].join("|"));
} else if (command === "verify-extracted") {
  const [manifestFile, releaseRoot] = args.map(required);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const root = await realpath(releaseRoot);
  for (const file of manifest.files ?? []) {
    if (
      typeof file.path !== "string" ||
      !/^(naiskos-agent|browser|migrations)\//.test(file.path) ||
      file.path.includes("\0") ||
      file.path.split("/").includes("..")
    ) fail(`Ruta no permitida: ${file.path}`);
    const resolved = await realpath(path.join(root, file.path));
    if (!resolved.startsWith(`${root}/`)) fail(`Ruta fuera de la release: ${file.path}`);
    const details = await stat(resolved);
    if (!details.isFile() || details.size !== file.sizeBytes || await sha256(resolved) !== file.sha256) {
      fail(`Archivo alterado: ${file.path}`);
    }
  }
  for (const entrypoint of ["naiskos-agent/dist/main.js", "browser/index.html"]) {
    const details = await stat(path.join(root, entrypoint));
    if (!details.isFile()) fail(`Falta ${entrypoint}`);
  }
} else if (command === "migrations") {
  const manifest = JSON.parse(await readFile(required(args[0]), "utf8"));
  for (const id of manifest.migrations ?? []) {
    if (!migrationIdPattern(id)) fail("ID de migración inválido");
    process.stdout.write(`${id}\n`);
  }
} else if (command === "verify-migration") {
  const [descriptorFile, migrationRoot, baselineFile] = args.map(required);
  const descriptor = await loadMigration(descriptorFile, migrationRoot);
  const baseline = await loadBaseline(baselineFile);
  validateMigrationCompatibility(descriptor, baseline, false);
  process.stdout.write(`${descriptor.migrationId}|${descriptor.fromVersion}|${descriptor.toVersion}`);
} else if (command === "apply-migration") {
  const [descriptorFile, migrationRoot, baselineFile, stateRoot] = args.map(required);
  const result = await applyMigration(descriptorFile, migrationRoot, baselineFile, stateRoot);
  process.stdout.write(`${result}|${path.basename(migrationRoot)}`);
} else if (command === "rollback-migration") {
  const [migrationId, baselineFile, stateRoot] = args.map(required);
  if (!migrationIdPattern(migrationId)) fail("ID de migración inválido");
  await rollbackMigration(migrationId, baselineFile, stateRoot);
  process.stdout.write(`rolled-back|${migrationId}`);
} else if (command === "repair-migration-permissions") {
  const [stateRoot] = args.map(required);
  await repairMigrationPermissions(stateRoot);
  process.stdout.write("repaired");
} else if (command === "report") {
  const [campaignId, releaseId, status, error = ""] = args;
  if (!uuidPattern(campaignId ?? "") || !releaseIdPattern(releaseId ?? "")) fail("Reporte inválido");
  const response = await fetch("http://127.0.0.1:8080/api/v1/system/release-events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naiskos-request": "release-activator" },
    body: JSON.stringify({ campaignId, releaseId, status, ...(error ? { error } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`Reporte HTTP ${response.status}`);
} else if (command === "report-system") {
  const count = Number(args[0]);
  const rebootRequired = args[1] === "true";
  const error = args[2] ?? "";
  if (!Number.isInteger(count) || count < 0 || count > 10000) fail("Conteo inválido");
  const response = await fetch("http://127.0.0.1:8080/api/v1/system/update-events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naiskos-request": "system-update-check" },
    body: JSON.stringify({ count, rebootRequired, ...(error ? { error } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`Reporte HTTP ${response.status}`);
} else {
  fail("Comando desconocido");
}

async function applyMigration(descriptorFile, migrationRoot, baselineFile, stateRoot) {
  const descriptor = await loadMigration(descriptorFile, migrationRoot);
  let baseline = await loadBaseline(baselineFile);
  const migrationStateRoot = path.join(stateRoot, descriptor.migrationId);
  const stateFile = path.join(migrationStateRoot, "state.json");
  const existingState = await readJsonIfPresent(stateFile);

  if (String(baseline.baselineVersion) === descriptor.toVersion) {
    if (existingState?.status === "applied" || !existingState) return "already-current";
  }
  if (existingState?.status === "applying") {
    await rollbackMigration(descriptor.migrationId, baselineFile, stateRoot);
    baseline = await loadBaseline(baselineFile);
  }
  validateMigrationCompatibility(descriptor, baseline, true);
  if (!descriptor.reversible) fail("Una migración automática debe ser reversible");

  const filesystem = await statfs(path.dirname(baselineFile));
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (freeBytes < descriptor.minimumFreeBytes) fail("Espacio insuficiente para la migración");

  await rm(migrationStateRoot, { recursive: true, force: true });
  await ensureMigrationDirectory(stateRoot);
  await ensureMigrationDirectory(migrationStateRoot);
  await ensureMigrationDirectory(path.join(migrationStateRoot, "files"));
  const baselineDetails = await stat(baselineFile);
  const baselineBackup = path.join(migrationStateRoot, "baseline.before.json");
  await copyFile(baselineFile, baselineBackup);
  await chmod(baselineBackup, 0o600);

  const state = {
    schemaVersion: 1,
    migrationId: descriptor.migrationId,
    fromVersion: descriptor.fromVersion,
    toVersion: descriptor.toVersion,
    status: "applying",
    baseline: {
      mode: baselineDetails.mode & 0o7777,
      uid: baselineDetails.uid,
      gid: baselineDetails.gid,
    },
    files: [],
    units: [],
    createdDirectories: [],
    daemonReload: descriptor.daemonReload,
  };

  for (const [index, operation] of descriptor.files.entries()) {
    assertSafeDestination(operation.destination);
    await assertNoSymlinkComponents(operation.destination);
    const before = await fileState(operation.destination, path.join(migrationStateRoot, "files", `${index}.before`));
    state.files.push({ destination: operation.destination, ...before });
    for (const directory of await missingDirectories(path.dirname(operation.destination))) {
      if (!state.createdDirectories.includes(directory)) state.createdDirectories.push(directory);
    }
  }
  for (const unit of descriptor.units) {
    state.units.push({
      name: unit.name,
      enabled: await systemctlState("is-enabled", unit.name),
      active: await systemctlState("is-active", unit.name),
    });
  }
  await writeJsonAtomic(stateFile, state, 0o600);

  try {
    for (const operation of descriptor.files) {
      if (operation.operation === "remove") await rm(operation.destination, { force: true });
      else await installDeclaredFile(operation, migrationRoot);
    }
    if (descriptor.daemonReload) await systemctl("daemon-reload");
    for (const unit of descriptor.units) await applyUnit(unit);
    await verifyAppliedMigration(descriptor, migrationRoot);
    await writeBaselineVersion(baselineFile, baseline, descriptor.toVersion);
    state.status = "applied";
    state.appliedAt = new Date().toISOString();
    await writeJsonAtomic(stateFile, state, 0o600);
    return "applied";
  } catch (error) {
    await rollbackMigration(descriptor.migrationId, baselineFile, stateRoot).catch(() => undefined);
    throw error;
  }
}

async function rollbackMigration(migrationId, baselineFile, stateRoot) {
  const migrationStateRoot = path.join(stateRoot, migrationId);
  const stateFile = path.join(migrationStateRoot, "state.json");
  const state = await readJsonIfPresent(stateFile);
  if (!state || state.status === "rolled_back") return;
  if (state.migrationId !== migrationId || !Array.isArray(state.files) || !Array.isArray(state.units)) {
    fail("Estado de migración inválido");
  }
  for (const unit of [...state.units].reverse()) {
    if (!unitNamePattern(unit.name)) fail("Unidad inválida en rollback");
    await systemctl("stop", unit.name).catch(() => undefined);
  }
  for (const file of [...state.files].reverse()) {
    assertSafeDestination(file.destination);
    if (file.existed) {
      const temporary = `${file.destination}.rollback-${process.pid}`;
      await copyFile(file.backup, temporary);
      await chmod(temporary, Number(file.mode));
      await chown(temporary, Number(file.uid), Number(file.gid));
      await rename(temporary, file.destination);
    } else {
      await rm(file.destination, { force: true });
    }
  }
  for (const directory of state.createdDirectories ?? []) {
    assertSafeDestination(`${directory}/placeholder`);
    await rmdir(directory).catch((error) => {
      if (!["ENOTEMPTY", "ENOENT"].includes(error?.code)) throw error;
    });
  }
  if (state.daemonReload) await systemctl("daemon-reload");
  for (const unit of [...state.units].reverse()) await restoreUnit(unit);
  const baselineBackup = path.join(migrationStateRoot, "baseline.before.json");
  const temporaryBaseline = `${baselineFile}.rollback-${process.pid}`;
  await copyFile(baselineBackup, temporaryBaseline);
  await chmod(temporaryBaseline, Number(state.baseline.mode));
  await chown(temporaryBaseline, Number(state.baseline.uid), Number(state.baseline.gid));
  await rename(temporaryBaseline, baselineFile);
  state.status = "rolled_back";
  state.rolledBackAt = new Date().toISOString();
  await writeJsonAtomic(stateFile, state, 0o600);
}

async function loadMigration(descriptorFile, migrationRoot) {
  const root = await realpath(migrationRoot);
  const descriptorPath = await realpath(descriptorFile);
  if (!descriptorPath.startsWith(`${root}/`)) fail("Descriptor fuera de la migración");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const allowedKeys = new Set([
    "schemaVersion", "migrationId", "description", "fromVersion", "toVersion",
    "architectures", "hardwareProfiles", "minimumFreeBytes", "reversible",
    "rebootRequired", "daemonReload", "files", "units",
  ]);
  if (!descriptor || typeof descriptor !== "object" || Object.keys(descriptor).some((key) => !allowedKeys.has(key))) {
    fail("Descriptor de migración inválido");
  }
  if (
    descriptor.schemaVersion !== 2 || !migrationIdPattern(descriptor.migrationId) ||
    descriptor.migrationId !== path.basename(root) ||
    !versionPattern(descriptor.fromVersion) || !versionPattern(descriptor.toVersion) ||
    Number(descriptor.toVersion) !== Number(descriptor.fromVersion) + 1 ||
    !Array.isArray(descriptor.architectures) || descriptor.architectures.length < 1 ||
    !descriptor.architectures.every((value) => ["arm64", "x64"].includes(value)) ||
    !Array.isArray(descriptor.hardwareProfiles) || descriptor.hardwareProfiles.length < 1 ||
    !descriptor.hardwareProfiles.every((value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) ||
    !Number.isSafeInteger(descriptor.minimumFreeBytes) || descriptor.minimumFreeBytes < 0 ||
    typeof descriptor.reversible !== "boolean" || typeof descriptor.rebootRequired !== "boolean" ||
    typeof descriptor.daemonReload !== "boolean" ||
    !Array.isArray(descriptor.files) || descriptor.files.length > 100 ||
    !Array.isArray(descriptor.units) || descriptor.units.length > 50
  ) fail("Descriptor de migración inválido");
  if (descriptor.description !== undefined && (typeof descriptor.description !== "string" || descriptor.description.length > 500)) {
    fail("Descripción de migración inválida");
  }
  if (new Set(descriptor.architectures).size !== descriptor.architectures.length ||
      new Set(descriptor.hardwareProfiles).size !== descriptor.hardwareProfiles.length) {
    fail("Compatibilidad duplicada en la migración");
  }

  const destinations = new Set();
  for (const operation of descriptor.files) {
    if (!operation || !["install", "remove"].includes(operation.operation)) fail("Operación de archivo inválida");
    const fileKeys = operation.operation === "install"
      ? new Set(["operation", "source", "destination", "sha256", "mode", "owner", "group"])
      : new Set(["operation", "destination"]);
    if (Object.keys(operation).some((key) => !fileKeys.has(key))) fail("Propiedad de archivo no permitida");
    assertSafeDestination(operation.destination);
    if (destinations.has(operation.destination)) fail("Destino de archivo duplicado");
    destinations.add(operation.destination);
    if (operation.operation === "install") {
      if (
        typeof operation.source !== "string" || !/^payload\/[A-Za-z0-9._/-]+$/.test(operation.source) ||
        operation.source.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(operation.sha256) ||
        !/^0[0-7]{3}$/.test(operation.mode) || !accountPattern(operation.owner) || !accountPattern(operation.group)
      ) fail("Instalación de archivo inválida");
      const source = await realpath(path.join(root, operation.source));
      if (!source.startsWith(`${root}/`)) fail("Fuente fuera de la migración");
      const details = await lstat(source);
      if (!details.isFile() || await sha256(source) !== operation.sha256) fail("Fuente de migración alterada");
    } else if (["source", "sha256", "mode", "owner", "group"].some((key) => key in operation)) {
      fail("Una eliminación no debe declarar contenido");
    }
  }
  const units = new Set();
  for (const unit of descriptor.units) {
    if (!unit || !unitNamePattern(unit.name) || units.has(unit.name)) fail("Unidad de migración inválida");
    if (Object.keys(unit).some((key) => !["name", "enabled", "active", "restart"].includes(key))) {
      fail("Propiedad de unidad no permitida");
    }
    units.add(unit.name);
    if (
      !["boolean", "undefined"].includes(typeof unit.enabled) ||
      !["boolean", "undefined"].includes(typeof unit.active) ||
      !["boolean", "undefined"].includes(typeof unit.restart) ||
      unit.enabled === undefined && unit.active === undefined && unit.restart !== true
    ) fail("Acción de unidad inválida");
  }
  return descriptor;
}

function validateMigrationCompatibility(descriptor, baseline, automatic) {
  const architecture = process.arch;
  if (!descriptor.architectures.includes(architecture)) fail(`Arquitectura no admitida: ${architecture}`);
  if (!descriptor.hardwareProfiles.includes(String(baseline.hardwareProfile ?? ""))) fail("Perfil de hardware no admitido");
  if (String(baseline.baselineVersion) !== descriptor.fromVersion) {
    if (String(baseline.baselineVersion) === descriptor.toVersion) return;
    fail(`Baseline esperado ${descriptor.fromVersion}, actual ${baseline.baselineVersion}`);
  }
  if (automatic && descriptor.rebootRequired) fail("Una migración con reinicio requiere una campaña de SO separada");
}

async function installDeclaredFile(operation, migrationRoot) {
  await assertNoSymlinkComponents(operation.destination);
  await mkdir(path.dirname(operation.destination), { recursive: true, mode: 0o755 });
  const source = path.join(migrationRoot, operation.source);
  if (await sha256(source) !== operation.sha256) fail("Fuente alterada durante la aplicación");
  const temporary = `${operation.destination}.naiskos-${process.pid}`;
  await copyFile(source, temporary);
  await chmod(temporary, Number.parseInt(operation.mode, 8));
  const [uid, gid] = await Promise.all([
    accountId("/etc/passwd", operation.owner),
    accountId("/etc/group", operation.group),
  ]);
  await chown(temporary, uid, gid);
  await rename(temporary, operation.destination);
}

async function verifyAppliedMigration(descriptor, migrationRoot) {
  for (const operation of descriptor.files) {
    if (operation.operation === "remove") {
      if (await exists(operation.destination)) fail(`No se eliminó ${operation.destination}`);
      continue;
    }
    const details = await lstat(operation.destination);
    if (
      !details.isFile() || (details.mode & 0o7777) !== Number.parseInt(operation.mode, 8) ||
      await sha256(operation.destination) !== operation.sha256
    ) fail(`Validación fallida: ${operation.destination}`);
    if (await sha256(path.join(migrationRoot, operation.source)) !== operation.sha256) {
      fail("Fuente alterada después de aplicar");
    }
  }
  for (const unit of descriptor.units) {
    if (unit.enabled !== undefined && await systemctlState("is-enabled", unit.name) !== unit.enabled) {
      fail(`Estado enabled inesperado: ${unit.name}`);
    }
    if (unit.active !== undefined && await systemctlState("is-active", unit.name) !== unit.active) {
      fail(`Estado active inesperado: ${unit.name}`);
    }
  }
}

async function applyUnit(unit) {
  if (unit.enabled === true) await systemctl("enable", unit.name);
  if (unit.enabled === false) await systemctl("disable", unit.name);
  if (unit.active === false) await systemctl("stop", unit.name);
  if (unit.active === true || unit.restart === true) await systemctl("restart", unit.name);
}

async function restoreUnit(unit) {
  if (unit.enabled === true) await systemctl("enable", unit.name);
  if (unit.enabled === false) await systemctl("disable", unit.name);
  if (unit.active === true) await systemctl("start", unit.name);
  if (unit.active === false) await systemctl("stop", unit.name);
}

async function systemctl(...parameters) {
  await execFile("/usr/bin/systemctl", parameters, { timeout: 60_000 });
}

async function systemctlState(commandName, unit) {
  try {
    await execFile("/usr/bin/systemctl", [commandName, "--quiet", unit], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function fileState(destination, backup) {
  try {
    const details = await lstat(destination);
    if (!details.isFile()) fail(`El destino no es un archivo regular: ${destination}`);
    await copyFile(destination, backup);
    await chmod(backup, 0o600);
    return { existed: true, backup, mode: details.mode & 0o7777, uid: details.uid, gid: details.gid };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { existed: false, backup: null, mode: null, uid: null, gid: null };
  }
}

async function missingDirectories(directory) {
  const result = [];
  let current = directory;
  while (!(await exists(current))) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) fail("No se pudo resolver el directorio de destino");
    current = parent;
  }
  await assertNoSymlinkComponents(current);
  return result;
}

async function assertNoSymlinkComponents(destination) {
  const parts = path.resolve(destination).split(path.sep).filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) fail(`Ruta con enlace simbólico: ${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertSafeDestination(destination) {
  if (
    typeof destination !== "string" || destination.includes("\0") ||
    destination.split("/").includes("..") || path.resolve(destination) !== destination ||
    destination === "/etc/naiskos/baseline.json"
  ) fail("Destino no permitido");
  const allowed = [
    /^\/etc\/naiskos\/[A-Za-z0-9._/-]+$/,
    /^\/etc\/systemd\/system\/naiskos-[A-Za-z0-9@_.-]+\.(?:service|timer|path)$/,
    /^\/opt\/naiskos\/bin\/naiskos-[A-Za-z0-9._-]+$/,
    /^\/etc\/chromium\/policies\/managed\/naiskos-[A-Za-z0-9._-]+\.json$/,
  ];
  if (!allowed.some((pattern) => pattern.test(destination))) {
    fail(`Destino fuera de las rutas administradas: ${destination}`);
  }
}

async function writeBaselineVersion(baselineFile, baseline, version) {
  await writeJsonAtomic(baselineFile, { ...baseline, baselineVersion: version }, null);
}

async function ensureMigrationDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o750 });
  await chmod(directory, 0o750);
  await chown(directory, 0, await accountId("/etc/group", "naiskos"));
}

async function repairMigrationPermissions(stateRoot) {
  const root = path.resolve(stateRoot);
  if (root !== "/var/lib/naiskos/migrations") fail("Raíz de migraciones no permitida");
  await ensureMigrationDirectory(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!migrationIdPattern(entry.name)) continue;
    if (entry.isSymbolicLink()) fail(`Migración con enlace simbólico: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const migrationRoot = path.join(root, entry.name);
    const details = await lstat(migrationRoot);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail(`Directorio de migración inválido: ${entry.name}`);
    }
    await ensureMigrationDirectory(migrationRoot);
    const filesRoot = path.join(migrationRoot, "files");
    if (await exists(filesRoot)) {
      const filesDetails = await lstat(filesRoot);
      if (!filesDetails.isDirectory() || filesDetails.isSymbolicLink()) {
        fail(`Directorio de respaldos inválido: ${entry.name}`);
      }
      await ensureMigrationDirectory(filesRoot);
    }
  }
}

async function loadBaseline(baselineFile) {
  const baseline = JSON.parse(await readFile(required(baselineFile), "utf8"));
  if (!baseline || !versionPattern(String(baseline.baselineVersion ?? ""))) fail("Baseline inválido");
  return baseline;
}

async function writeJsonAtomic(file, value, explicitMode) {
  const temporary = `${file}.tmp-${process.pid}`;
  const previous = await stat(file).catch(() => null);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: explicitMode ?? (previous ? previous.mode & 0o7777 : 0o600),
  });
  if (previous) await chown(temporary, previous.uid, previous.gid);
  await rename(temporary, file);
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function accountId(database, name) {
  const line = (await readFile(database, "utf8"))
    .split("\n")
    .find((candidate) => candidate.split(":", 1)[0] === name);
  if (!line) fail(`Cuenta inexistente: ${name}`);
  const id = Number(line.split(":")[2]);
  if (!Number.isSafeInteger(id) || id < 0) fail(`ID inválido para ${name}`);
  return id;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function required(value) { if (!value) fail("Falta argumento"); return value; }
function fail(message) { throw new Error(message); }
function releaseIdPattern(value) { return /^[0-9]{8}[A-Za-z0-9._-]{1,80}$/.test(value); }
function migrationIdPattern(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function versionPattern(value) { return typeof value === "string" && /^[0-9]+$/.test(value); }
function uuidPattern(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function timePattern(value) { return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value); }
function accountPattern(value) { return typeof value === "string" && /^(?:root|naiskos|riggito)$/.test(value); }
function unitNamePattern(value) { return typeof value === "string" && /^naiskos-[a-z0-9@_.-]+\.(?:service|timer|path)$/.test(value); }
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
