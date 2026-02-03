import { FILE_GLOBS } from './.markdownlint-cli2.mjs'

/**
 * Convert `FILE_GLOBS` into a brace-style combined pattern.
 */
const MD_GLOB_KEY = `**/*.{${FILE_GLOBS.map(g => g.replace('**/*.', '')).join(',')}}`

/**
 * @type {import('lint-staged').Configuration}
 *
 * Note: lint-staged supplies a list of staged filenames to each command it
 * runs. Commands invoked through package manager scripts (for example
 * `npm run <script>` or `pnpm run <script>`) do not receive that filename
 * list from the package manager, so tools will run on their default globs (or
 * the entire repo). To ensure formatters and linters operate only on staged
 * files, invoke the tool binaries directly in lint-staged (for example
 * `prettier --write`, `eslint --fix`, `markdownlint-cli2 --fix`). Use the
 * package scripts when you intend to run the tool across the whole repository.
 */
export default {
  [MD_GLOB_KEY]: ['markdownlint-cli2 --fix'],
  '**/*.{astro,cjs,css,csv,gql,graphql,hbs,html,js,jsx,json,json5,jsonc,jsonl,less,mjs,pcss,sass,scss,svelte,styl,ts,tsx,vue,xml,yaml,yml}':
    ['prettier --write', 'eslint --cache --fix'],
}
