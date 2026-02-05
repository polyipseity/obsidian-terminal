declare global {
  interface File {
    readonly path?: string | undefined;
  }
}
