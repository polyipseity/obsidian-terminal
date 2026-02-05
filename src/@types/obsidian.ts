/* eslint-disable @typescript-eslint/no-empty-object-type */
declare module "obsidian" {
  interface App extends Private<$App, PrivateKey> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SuggestModal<T> extends Private<$SuggestModal, PrivateKey> {}
}
import type {} from "obsidian";
import type { Private } from "@polyipseity/obsidian-plugin-library";

declare const PRIVATE_KEY: unique symbol;
type PrivateKey = typeof PRIVATE_KEY;
declare module "@polyipseity/obsidian-plugin-library" {
  interface PrivateKeys {
    readonly [PRIVATE_KEY]: never;
  }
}

interface $App {
  readonly setAccentColor: (color?: string) => void;
}

interface $SuggestModal {
  readonly selectActiveSuggestion: (evt: KeyboardEvent | MouseEvent) => void;
}
