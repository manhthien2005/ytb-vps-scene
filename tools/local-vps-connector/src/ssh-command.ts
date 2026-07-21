export type SshTarget = Readonly<{ user: "root"; host: string; port: number }>;

const SSH_PATTERN = /^ssh\s+root@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?:\s+-p\s+([0-9]{1,5}))?$/;

export function parseSshCommand(value: string): SshTarget {
  const input = value.trim();
  if (input.length > 255 || /[^\x20-\x7e]/.test(input)) throw new Error("SSH command is invalid");
  const match = SSH_PATTERN.exec(input);
  if (!match) throw new Error("Expected: ssh root@host -p port");
  const port = match[2] === undefined ? 22 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH port is invalid");
  return Object.freeze({ user: "root", host: match[1], port });
}
