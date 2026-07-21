import { describe, expect, it } from "vitest";
import { parseSshCommand } from "../src/ssh-command.js";

describe("parseSshCommand", () => {
  it("parses the CKEY SSH form", () => {
    expect(parseSshCommand("ssh root@n1.ckey.vn -p 1210")).toEqual({ user: "root", host: "n1.ckey.vn", port: 1210 });
  });

  it("defaults to port 22 when no -p is given", () => {
    expect(parseSshCommand("ssh root@example.host")).toEqual({ user: "root", host: "example.host", port: 22 });
  });

  it.each([
    "root@n1.ckey.vn:1210",
    "ssh ubuntu@n1.ckey.vn -p 1210",
    "ssh root@n1.ckey.vn -p 0",
    "ssh root@n1.ckey.vn -p 65536",
    "ssh root@n1.ckey.vn -p 1210; rm -rf /",
    "ssh root@n1.ckey.vn -p 1210 -o StrictHostKeyChecking=no",
  ])("rejects unsafe or unsupported input: %s", (value) => {
    expect(() => parseSshCommand(value)).toThrow();
  });
});
