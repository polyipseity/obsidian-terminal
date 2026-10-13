declare module "obsidian" {
  interface PluginManifest {
    readonly fundingUrl?: string | Record<string, string>;
  }

  // Inlined `Private<$X, typeof PRIVATE_KEY>`: an interface that only extends it is empty.
  interface App {
    readonly [PRIVATE_KEY]?: $App;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `T` must stay declared to match the augmented class signature.
  interface SuggestModal<T> {
    readonly [PRIVATE_KEY]?: $SuggestModal;
  }
  interface WorkspaceLeaf {
    readonly [PRIVATE_KEY]?: $WorkspaceLeaf;
  }
}
import type {} from "obsidian";

declare const PRIVATE_KEY: unique symbol;
declare module "@polyipseity/obsidian-plugin-library" {
  interface PrivateKeys {
    readonly [PRIVATE_KEY]: never;
  }
}

export interface $App {
  readonly setAccentColor: (color?: string) => void;
}

export interface $SuggestModal {
  readonly selectActiveSuggestion: (evt: KeyboardEvent | MouseEvent) => void;
}

export interface $WorkspaceLeaf {
  /** The tab header. Obsidian keeps `data-` attributes on it across refreshes. */
  readonly tabHeaderEl: HTMLElement;
}
