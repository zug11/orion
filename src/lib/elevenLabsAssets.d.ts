/** Vite's explicit file URL, with inlining disabled for AudioWorklet CSP. */
declare module "*?no-inline&url" {
  const url: string;
  export default url;
}
