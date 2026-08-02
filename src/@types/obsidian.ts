declare module "obsidian" {
  interface PluginManifest {
    readonly fundingUrl?: string | Record<string, string>;
  }

  interface App extends Private<$App, PrivateKey> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SuggestModal<T> extends Private<$SuggestModal, PrivateKey> {}
}
import type { Private } from "@polyipseity/obsidian-plugin-library";
import type {} from "obsidian";

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
