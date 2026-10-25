export function newId(): string {
  return crypto.randomUUID().slice(0, 13);
}
