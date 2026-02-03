/**
 * @type {import('lint-staged').Configuration}
 */
export default {
  "**/*.{md,mdoc,mdown,mdx,mkd,mkdn,markdown,rmd}": [
    "npm run format:md",
  ],
  "**/*.{astro,cjs,css,csv,gql,graphql,hbs,html,js,jsx,json,json5,jsonc,jsonl,less,mjs,pcss,sass,scss,svelte,styl,ts,tsx,vue,xml,yaml,yml}": [
    "npm run format:prettier",
    "npm run format:eslint",
  ]
};
