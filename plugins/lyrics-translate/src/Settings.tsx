import { ReactiveStore } from "@luna/core";
import { LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import React from "react";

import { clearCache } from ".";
import { defaultTargetLanguage, languages } from "./languages";
import { displayModes, layouts, type DisplayMode, type Layout } from "./modes";

export const settings = await ReactiveStore.getPluginStorage("TidalLyricsTranslate", {
	targetLanguage: defaultTargetLanguage(),
	displayMode: "original+translation" as DisplayMode,
	layout: "newline" as Layout,
	// Used when `layout` is "inline".
	inlineSeparator: "  —  ",
	autoTranslate: false,
	// Leave lyrics alone when they're already in the target language.
	skipSameLanguage: true,
	showButton: true,
});

// The MUI prop types don't survive Luna's React.memo wrappers, so handler params are annotated here.
type SelectEvent = { target: { value: unknown } };
type SwitchHandler = (event: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => void;

const onSwitch =
	(apply: (checked: boolean) => void): SwitchHandler =>
	(_, checked) =>
		apply(checked ?? false);

export const Settings = () => {
	const [targetLanguage, setTargetLanguage] = React.useState(settings.targetLanguage);
	const [displayMode, setDisplayMode] = React.useState(settings.displayMode);
	const [layout, setLayout] = React.useState(settings.layout);
	const [inlineSeparator, setInlineSeparator] = React.useState(settings.inlineSeparator);
	const [autoTranslate, setAutoTranslate] = React.useState(settings.autoTranslate);
	const [skipSameLanguage, setSkipSameLanguage] = React.useState(settings.skipSameLanguage);
	const [showButton, setShowButton] = React.useState(settings.showButton);

	// Anything that changes how a line is rendered invalidates what's cached and on screen.
	const multiPart = displayMode.includes("+");

	return (
		<LunaSettings>
			<LunaSelectSetting
				title="Target language"
				desc="Language lyrics are translated into"
				value={targetLanguage}
				onChange={(event: SelectEvent) => {
					const value = String(event.target.value);
					setTargetLanguage((settings.targetLanguage = value));
					clearCache();
				}}
			>
				{languages.map(({ value, label }) => (
					<LunaSelectItem key={value} value={value}>
						{label}
					</LunaSelectItem>
				))}
			</LunaSelectSetting>
			<LunaSelectSetting
				title="Display"
				desc="What each lyric line shows. Romanization transliterates the original into latin script (useful for Japanese, Korean, Russian…)"
				value={displayMode}
				onChange={(event: SelectEvent) => {
					const value = event.target.value as DisplayMode;
					setDisplayMode((settings.displayMode = value));
					clearCache();
				}}
			>
				{displayModes.map(({ value, label }) => (
					<LunaSelectItem key={value} value={value}>
						{label}
					</LunaSelectItem>
				))}
			</LunaSelectSetting>
			{multiPart && (
				<LunaSelectSetting
					title="Second line"
					desc="Where the second half of each line goes. Its own line keeps both halves in sync with the music; the same line is more compact"
					value={layout}
					onChange={(event: SelectEvent) => {
						const value = event.target.value as Layout;
						setLayout((settings.layout = value));
						clearCache();
					}}
				>
					{layouts.map(({ value, label }) => (
						<LunaSelectItem key={value} value={value}>
							{label}
						</LunaSelectItem>
					))}
				</LunaSelectSetting>
			)}
			{multiPart && layout === "inline" && (
				<LunaTextSetting
					title="Separator"
					desc="Placed between the two halves of a line"
					value={inlineSeparator}
					onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
						const { value } = event.target;
						setInlineSeparator((settings.inlineSeparator = value));
						clearCache();
					}}
				/>
			)}
			<LunaSwitchSetting
				title="Translate automatically"
				desc="Translate every track as its lyrics load, without pressing the button"
				checked={autoTranslate}
				onChange={onSwitch((checked) => setAutoTranslate((settings.autoTranslate = checked)))}
			/>
			<LunaSwitchSetting
				title="Skip matching languages"
				desc="Leave lyrics untouched when they are already in the target language"
				checked={skipSameLanguage}
				onChange={onSwitch((checked) => {
					setSkipSameLanguage((settings.skipSameLanguage = checked));
					clearCache();
				})}
			/>
			<LunaSwitchSetting
				title="Show the toolbar button"
				desc="Adds a translate / show original button next to the fullscreen toggle in the lyrics view"
				checked={showButton}
				onChange={onSwitch((checked) => {
					setShowButton((settings.showButton = checked));
					clearCache();
				})}
			/>
		</LunaSettings>
	);
};
