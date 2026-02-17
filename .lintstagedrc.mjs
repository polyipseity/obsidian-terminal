import { FILE_GLOBS as ESLINT_FILE_GLOBS } from "./eslint.config.mjs";
import { FILE_GLOB as MD_FILE_GLOB } from "./.markdownlint-cli2.mjs";

/**
 * Convert ESLint `FILE_GLOBS` into a brace-style combined pattern.
 */
const ESLINT_GLOB_KEY = `**/*.{${ESLINT_FILE_GLOBS.map((g) =>
  g.replace("**/*.", ""),
).join(",")}}`;

/**
 * Convert `FILE_GLOB`, which uses globby/fast-glob style brace expansion,
 * into a micromatch-compatible glob pattern that matches the same set of files.
 */
const MD_GLOB_KEY = MD_FILE_GLOB;

const ORIGINAL_PRETTIER_GLOB =
  "**/*.{astro,cjs,css,csv,gql,graphql,hbs,html,js,jsx,json,json5,jsonc,jsonl,less,mjs,pcss,sass,scss,svelte,styl,ts,tsx,vue,xml,yaml,yml}";
/**
 * Compute the Prettier-only glob by parsing the original lint-staged glob
 * and excluding extensions handled by ESLint (to avoid race conditions).
 */
const PRETTIER_GLOB_KEY = (() => {
  const eslintExts = new Set(
    ESLINT_FILE_GLOBS.map((g) => g.replace("**/*.", "")),
  );
  const m = ORIGINAL_PRETTIER_GLOB.match(/\{([^}]+)\}/);
  const exts = m ? m[1].split(",").filter((e) => !eslintExts.has(e)) : [];
  return `**/*.{${exts.join(",")}}`;
})();

/**
 * @type {import('lint-staged').Configuration}
 *
 * Note: lint-staged supplies a list of staged filenames to each command it
 * runs. Commands invoked through package manager scripts (for example
 * `npm run <script>` or `pnpm run <script>`) do not receive that filename
 * list from the package manager, so tools will run on their default globs (or
 * the entire repo). To ensure formatters and linters operate only on staged
 * files, invoke the tool binaries directly in lint-staged (for example
 * `prettier --write`, `eslint --fix`, `markdownlint-cli2 --fix --no-globs`). Use the
 * package scripts when you intend to run the tool across the whole repository.
 */
export default {
  [MD_GLOB_KEY]: ["markdownlint-cli2 --fix --no-globs"],
  [ESLINT_GLOB_KEY]: ["eslint --fix", "prettier --write"],
  [PRETTIER_GLOB_KEY]: ["prettier --write"],
};
