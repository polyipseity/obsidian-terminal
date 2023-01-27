<svelte:options immutable={false} />

<script context="module" lang="typescript">
	import { Direction, type Params, copyParams } from "./find";
	import type { Mutable } from "sources/util";
	import { setIcon } from "obsidian";
</script>

<script lang="typescript">
	export let params: Partial<Mutable<Params>> = {};
	params = copyParams(params);
	export let inputPlaceholder = "";
	export let onClose = () => {};
	export let onFind = (_direction: Direction, _params: Params) => {};
	export let onParamsChanged = (_params: Params) => {};
	export let searchResult = "";

	$: onParamsChanged(copyParams(params));
</script>

<div class="document-search-container">
	<div class="document-search">
		<div class="document-search-buttons">
			<button
				class={`document-search-button${
					params.caseSensitive ? " mod-cta" : ""
				}`}
				on:click={() => (params.caseSensitive = !params.caseSensitive)}
				use:setIcon={"uppercase-lowercase-a"}
			/>
			<button
				class={`document-search-button${params.wholeWord ? " mod-cta" : ""}`}
				on:click={() => (params.wholeWord = !params.wholeWord)}
				use:setIcon={"align-horizontal-space-around"}
			/>
			<button
				class={`document-search-button${params.regex ? " mod-cta" : ""}`}
				on:click={() => (params.regex = !params.regex)}
				use:setIcon={"regex"}
			/>
		</div>
		<input
			class="document-search-input"
			type="text"
			placeholder={inputPlaceholder}
			bind:value={params.findText}
		/>
		<div class="document-search-buttons">
			<button
				class="document-search-button"
				on:click={() => onFind(Direction.previous, copyParams(params))}
				use:setIcon={"arrow-up"}
			/>
			<button
				class="document-search-button"
				on:click={() => onFind(Direction.next, copyParams(params))}
				use:setIcon={"arrow-down"}
			/>
			<div class="document-search-results">{searchResult}</div>
			<button
				class="document-search-close-button"
				on:click={onClose}
				use:setIcon={"x"}
			/>
		</div>
	</div>
</div>

<style>
	.document-search-container {
		margin: 0;
	}
</style>
