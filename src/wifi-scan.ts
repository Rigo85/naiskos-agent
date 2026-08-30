import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface WifiAccessPoint {
  macAddress: string;
}

export async function scanWifiAccessPoints(): Promise<WifiAccessPoint[]> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/nmcli",
      [
        "--terse",
        "--escape",
        "no",
        "--fields",
        "BSSID",
        "device",
        "wifi",
        "list",
        "--rescan",
        "yes",
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 },
    );
    return parseWifiScan(stdout);
  } catch {
    return [];
  }
}

export function parseWifiScan(output: string): WifiAccessPoint[] {
  const unique = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
      const macAddress = line.trim().toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)) continue;
      const firstOctet = Number.parseInt(macAddress.slice(0, 2), 16);
      if ((firstOctet & 0x03) !== 0) continue;
      unique.add(macAddress);
      if (unique.size >= 20) break;
  }
  return [...unique].map((macAddress) => ({ macAddress }));
}
