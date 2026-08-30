import { describe, expect, it } from "vitest";

import { parseWifiScan } from "../src/wifi-scan.js";

describe("escaneo Wi-Fi", () => {
  it("normaliza, deduplica y descarta BSSID no utilizables", () => {
    expect(
      parseWifiScan(
        [
          "00:11:22:33:44:55",
          "00:11:22:33:44:55",
          "02:11:22:33:44:55",
          "10:21:32:43:54:65",
          "invalido",
        ].join("\n"),
      ),
    ).toEqual([
      { macAddress: "00:11:22:33:44:55" },
      { macAddress: "10:21:32:43:54:65" },
    ]);
  });
});
