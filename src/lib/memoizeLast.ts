/**
 * `fn` that remembers its last call: called again with the same arguments (each `===`), it returns
 * the same result without running. For pure work a view throws away and redoes on a remount, such
 * as tokenizing a file again after its Preview was toggled to the source and back. Only one call
 * is kept, so the memory held is one result.
 */
export function memoizeLast<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { args: A; result: R } | null = null;
  return (...args: A): R => {
    if (last !== null && last.args.length === args.length && last.args.every((arg, index) => arg === args[index])) return last.result;
    const result = fn(...args);
    last = { args, result };
    return result;
  };
}
