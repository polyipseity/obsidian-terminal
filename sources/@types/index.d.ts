// eslint-disable-next-line spaced-comment
/// <reference types="svelte" />

declare module "*.md" {
	const value: PromiseLike<string>
	export default value
}
