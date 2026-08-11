/** What a rendered lyric line is built out of, in display order. */
export type LinePart = "original" | "romanization" | "translation";

export type DisplayMode = "translation" | "original+translation" | "romanization" | "original+romanization" | "romanization+translation";

export const displayModes: { value: DisplayMode; label: string }[] = [
	{ value: "translation", label: "Translation only" },
	{ value: "original+translation", label: "Original + translation" },
	{ value: "romanization", label: "Romanization only" },
	{ value: "original+romanization", label: "Original + romanization" },
	{ value: "romanization+translation", label: "Romanization + translation" },
];

const modeParts: Record<DisplayMode, LinePart[]> = {
	translation: ["translation"],
	"original+translation": ["original", "translation"],
	romanization: ["romanization"],
	"original+romanization": ["original", "romanization"],
	"romanization+translation": ["romanization", "translation"],
};

export const partsFor = (mode: DisplayMode): LinePart[] => modeParts[mode] ?? modeParts.translation;

/** How the parts of a line are laid out when a mode renders more than one. */
export type Layout = "newline" | "inline";

export const layouts: { value: Layout; label: string }[] = [
	{ value: "newline", label: "On its own line" },
	{ value: "inline", label: "On the same line" },
];
