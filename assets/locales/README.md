# Translating

## Files

Translation files for this project are under this folder.

External translation files:

- [`polyipseity/obsidian-plugin-library`](https://github.com/polyipseity/obsidian-plugin-library/tree/main/assets/locales)

To translate all strings, you also need to translate the external translation files.

## Instructions

Each locale has its own directory named with its corresponding __[IETF language tag](https://wikipedia.org/wiki/IETF_language_tag)__.

To contribute translation for an existing locale, modify the files in the corresponding directory.

For a new locale, create a new directory named with its language tag and copy [`assets/locales/en/translation.json`](assets/locales/en/translation.json) into it. Then, add an entry to [`assets/locales/en/language.json`](assets/locales/en/language.json) in this format:

```JSONc
{
    // ...
    "en": "English",
    "(your-language-tag)": "(Native name of your language)",
    "uwu": "Uwuish",
    // ...
}
```

Sort the list of languages by the alphabetical order of their language tags. Then modify the files in the new directory. There will be errors in [`assets/locales.ts`](assets/locales.ts), which you can ignore and we will fix them for you. You are welcome to fix them yourself if you know TypeScript.

When translating, keep in mind the following things:

- Do not translate anything between `{{` and `}}` (`{{example}}`). They are __interpolations__ and will be replaced by localized strings at runtime.
- Do not translate anything between `$t(` and `)` (`$t(example)`). They refer to other localized strings. To find the localized string being referred to, follow the path of the key, which is separated by dots (`.`). For example, the key [`youtu.be./dQw4w9WgXcQ`](https://youtu.be./dQw4w9WgXcQ) refers to:

```JSONc
{
    // ...
    "youtu": {
        // ...
        "be": {
            // ...
            "/dQw4w9WgXcQ": "I am 'youtu.be./dQw4w9WgXcQ'!",
            // ...
        },
        // ...
    },
    // ...
}
```

- The keys under `generic` are vocabularies. They can be referred in translation strings by `$t(generic.key)`. Refer to them as much as possible to standardize translations for vocabularies that appear in different places.
- It is okay to move interpolations and references to other localized strings around to make the translation natural. It is also okay to not use some references used in the original translation. However, it is NOT okay to not use all interpolations.
