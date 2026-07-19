import { randomBytes, scrypt as callback } from "node:crypto";
import { promisify } from "node:util";
import { stdin, stdout } from "node:process";

stdin.setEncoding("utf8");
stdout.write("Nhập admin key: ");
const key = await new Promise((resolve) => stdin.once("data", (value) => resolve(value.trim())));
if (key.length < 16) throw new Error("Admin key phải có ít nhất 16 ký tự");

const salt = randomBytes(16);
const N = 16_384;
const r = 8;
const p = 1;
const digest = await promisify(callback)(key, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${digest.toString("base64url")}\n`);
