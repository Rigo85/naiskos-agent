#!/opt/node24/bin/node

import { createHash, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

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
    ) {
      fail(`Ruta no permitida: ${file.path}`);
    }
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
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail("ID de migración inválido");
    process.stdout.write(`${id}\n`);
  }
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

function required(value) {
  if (!value) fail("Falta argumento");
  return value;
}
function fail(message) { throw new Error(message); }
function releaseIdPattern(value) { return /^[0-9]{8}[A-Za-z0-9._-]{1,80}$/.test(value); }
function uuidPattern(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function timePattern(value) { return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value); }
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
