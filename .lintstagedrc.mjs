import { FILE_GLOBS } from './.markdownlint-cli2.mjs'

/**
 * Convert `FILE_GLOBS` into a brace-style combined pattern.
 */
const MD_GLOB_KEY = `**/*.{${FILE_GLOBS.map(g => g.replace('**/*.', '')).join(',')}}`

/**
 * @type {import('lint-staged').Configuration}
 */
export default {
	[MD_GLOB_KEY]: ['npm run format:md'],
	'**/*.{astro,cjs,css,csv,gql,graphql,hbs,html,js,jsx,json,json5,jsonc,jsonl,less,mjs,pcss,sass,scss,svelte,styl,ts,tsx,vue,xml,yaml,yml}':
		['npm run format:prettier', 'npm run format:eslint'],
}
