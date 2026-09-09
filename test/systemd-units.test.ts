import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const verifierUnit = path.resolve("deploy/naiskos-system-maintenance-verify.service");

describe("unidades systemd", () => {
  it("no ordena el verificador después de un target que depende de multi-user", async () => {
    const unit = await readFile(verifierUnit, "utf8");
    const after = directiveValues(unit, "After");
    const wantedBy = directiveValues(unit, "WantedBy");

    expect(wantedBy).toContain("multi-user.target");
    expect(after).toContain("network-online.target");
    expect(after).toContain("naiskos-agent.service");
    expect(after).not.toContain("graphical.target");
  });
});

function directiveValues(unit: string, directive: string): string[] {
  return unit
    .split("\n")
    .filter((line) => line.startsWith(`${directive}=`))
    .flatMap((line) => line.slice(directive.length + 1).trim().split(/\s+/))
    .filter(Boolean);
}
