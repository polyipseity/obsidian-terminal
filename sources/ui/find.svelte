<svelte:options immutable={false} />

<script context="module" lang="typescript">
	import { Direction, type Params } from "./find";
	import type { DeepWritable } from "ts-essentials";
	import { consumeEvent } from "sources/utils/util";
	import { t as i18t } from "i18next";
	import { onMount } from "svelte";
	import { setIcon } from "obsidian";
</script>

<script lang="typescript">
	export let i18n = i18t;
	export let params: DeepWritable<Params> = {
		caseSensitive: false,
		findText: "",
		regex: false,
		wholeWord: false,
	};
	export let inputPlaceholder = "";
	export let onClose = (): void => {};
	export let onFind = (_direction: Direction, _params: Params): void => {};
	export let onParamsChanged = (_params: Params): void => {};
	export let searchResult = "";

	let inputElement: HTMLElement | null = null;
	export function focus() {
		inputElement?.focus();
	}
	export function blur() {
		inputElement?.blur();
	}

	onMount(() => {
		inputElement?.addEventListener("keydown", (event) => {
			if (event.code === "Escape") {
				onClose();
				consumeEvent(event);
			}
		});
	});
	$: onParamsChanged(params);
</script>

<div class="document-search-container">
	<div class="document-search">
		<div class="document-search-buttons">
			<button
				class={`document-search-button${
					params.caseSensitive ? " mod-cta" : ""
				}`}
				on:click={() => {
					params.caseSensitive = !params.caseSensitive;
				}}
				use:setIcon={i18n("asset:components.find.case-sensitive-icon")}
			/>
			<button
				class={`document-search-button${params.wholeWord ? " mod-cta" : ""}`}
				on:click={() => {
					params.wholeWord = !params.wholeWord;
				}}
				use:setIcon={i18n("asset:components.find.whole-word-icon")}
			/>
			<button
				class={`document-search-button${params.regex ? " mod-cta" : ""}`}
				on:click={() => {
					params.regex = !params.regex;
				}}
				use:setIcon={i18n("asset:components.find.regex-icon")}
			/>
		</div>
		<input
			class="document-search-input"
			type="text"
			placeholder={inputPlaceholder}
			bind:value={params.findText}
			bind:this={inputElement}
		/>
		<div class="document-search-buttons">
			<button
				class="document-search-button"
				on:click={() => {
					onFind(Direction.previous, params);
				}}
				use:setIcon={i18n("asset:components.find.previous-icon")}
			/>
			<button
				class="document-search-button"
				on:click={() => {
					onFind(Direction.next, params);
				}}
				use:setIcon={i18n("asset:components.find.next-icon")}
			/>
			<div class="document-search-results">{searchResult}</div>
			<button class="document-search-close-button" on:click={onClose} />
		</div>
	</div>
</div>

<style>
	.document-search-container {
		margin: 0;
	}
	.document-search {
		flex-wrap: wrap;
	}

	/* mobile */
	button.mod-cta {
		background-color: var(--interactive-accent) !important;
		color: var(--text-on-accent) !important;
	}
</style>
