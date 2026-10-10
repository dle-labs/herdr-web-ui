/** Vite bundles the AudioWorklet entry and its imports as a standalone asset. */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
