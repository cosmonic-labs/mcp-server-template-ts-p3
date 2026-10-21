// QuickJS exposes WIT futures as resources; JCO types describe PromiseLike.
type NativeFuture<T> = { read(): Promise<T>; drop(): void };
export async function readFuture<T>(future: PromiseLike<T>): Promise<T> {
  const native = future as unknown as NativeFuture<T>;
  try { return await native.read(); } finally { native.drop(); }
}
export function dropFuture(future: PromiseLike<unknown>): void {
  (future as unknown as NativeFuture<unknown>).drop();
}
