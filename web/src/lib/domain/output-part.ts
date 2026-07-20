export function outputPartFileName(part: number, total: number): string {
  if (!Number.isInteger(part) || !Number.isInteger(total) || total < 1 || total > 999 || part < 1 || part > total) {
    throw new Error("Invalid output part metadata");
  }
  const width = Math.max(2, String(total).length);
  return `part-${String(part).padStart(width, "0")}-of-${String(total).padStart(width, "0")}.mp4`;
}
