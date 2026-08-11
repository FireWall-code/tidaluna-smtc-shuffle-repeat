export interface Language {
	value: string;
	label: string;
	rightToLeft?: boolean;
}

export const languages: Language[] = [
	{ value: "af", label: "Afrikaans" },
	{ value: "ar", label: "Arabic", rightToLeft: true },
	{ value: "bg", label: "Bulgarian" },
	{ value: "bn", label: "Bengali" },
	{ value: "ca", label: "Catalan" },
	{ value: "cs", label: "Czech" },
	{ value: "da", label: "Danish" },
	{ value: "de", label: "German" },
	{ value: "el", label: "Greek" },
	{ value: "en", label: "English" },
	{ value: "es", label: "Spanish" },
	{ value: "et", label: "Estonian" },
	{ value: "fa", label: "Persian", rightToLeft: true },
	{ value: "fi", label: "Finnish" },
	{ value: "fr", label: "French" },
	{ value: "he", label: "Hebrew", rightToLeft: true },
	{ value: "hi", label: "Hindi" },
	{ value: "hr", label: "Croatian" },
	{ value: "hu", label: "Hungarian" },
	{ value: "id", label: "Indonesian" },
	{ value: "is", label: "Icelandic" },
	{ value: "it", label: "Italian" },
	{ value: "ja", label: "Japanese" },
	{ value: "ko", label: "Korean" },
	{ value: "lt", label: "Lithuanian" },
	{ value: "lv", label: "Latvian" },
	{ value: "ms", label: "Malay" },
	{ value: "nl", label: "Dutch" },
	{ value: "no", label: "Norwegian" },
	{ value: "pl", label: "Polish" },
	{ value: "pt", label: "Portuguese" },
	{ value: "ro", label: "Romanian" },
	{ value: "ru", label: "Russian" },
	{ value: "sk", label: "Slovak" },
	{ value: "sl", label: "Slovenian" },
	{ value: "sr", label: "Serbian" },
	{ value: "sv", label: "Swedish" },
	{ value: "sw", label: "Swahili" },
	{ value: "th", label: "Thai" },
	{ value: "tl", label: "Filipino" },
	{ value: "tr", label: "Turkish" },
	{ value: "uk", label: "Ukrainian" },
	{ value: "ur", label: "Urdu", rightToLeft: true },
	{ value: "vi", label: "Vietnamese" },
	{ value: "yo", label: "Yoruba" },
	{ value: "zh-CN", label: "Chinese (Simplified)" },
	{ value: "zh-TW", label: "Chinese (Traditional)" },
	{ value: "zu", label: "Zulu" },
];

export const isRightToLeft = (langCode: string): boolean => languages.find(({ value }) => value === langCode)?.rightToLeft ?? false;

/**
 * Google reports detected languages as bare codes (`pt`, `zh-CN`), while the client
 * locale looks like `pt-BR`. Compare on the base code so "already in your language"
 * detection isn't defeated by a regional suffix.
 */
export const sameLanguage = (a?: string, b?: string): boolean => {
	if (a === undefined || b === undefined) return false;
	const base = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
	// zh-CN and zh-TW are different enough to be worth translating between.
	if (base(a) === "zh" && base(b) === "zh") return a.toLowerCase() === b.toLowerCase();
	return base(a) === base(b);
};

/** Best guess at a sane default target: the client's own language, else English. */
export const defaultTargetLanguage = (): string => {
	const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
	if (locale === undefined) return "en";
	const exact = languages.find(({ value }) => value.toLowerCase() === locale.toLowerCase());
	if (exact !== undefined) return exact.value;
	const base = locale.toLowerCase().split(/[-_]/)[0];
	return languages.find(({ value }) => value === base)?.value ?? "en";
};
