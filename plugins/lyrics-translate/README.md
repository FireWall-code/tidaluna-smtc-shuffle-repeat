# TidalLyricsTranslate

Translates — and romanizes — TIDAL lyrics in place, in both the synced and the unsynced
view, with a one-click toggle back to the original.

> **Credits** — Built on the `translate` plugin by **[vMohammad](https://vmohammad.dev)**
> ([vMohammad24/luna-plugins/plugins/translate](https://github.com/vMohammad24/luna-plugins/tree/master/plugins/translate)),
> whose repository is deprecated. Rewritten and maintained here by
> [FireWall](https://github.com/FireWall-code). The lyrics-view button placement comes from
> [meowarex](https://github.com/meowarex), same as in the original.

## What it does

- **Bilingual lyrics** — keep the original line and put the translation under it (or next to
  it), instead of replacing the words you're singing along to.
- **Romanization** — transliterates non-latin lyrics (Japanese, Korean, Russian, Arabic…)
  into latin script, on its own or paired with a translation.
- **Stays in sync** — translations are written back into the LRC timeline, so the highlight
  still follows the music. In the two-line layout the timestamp is repeated, so both halves
  light up together.
- **Toggle, not a one-way door** — the toolbar button flips between translated and original;
  results are cached per track, so flipping back and forth is instant and costs no requests.
- **Skips what it shouldn't touch** — lyrics already in your target language are left alone
  (the job aborts after the first batch, once the source language is known), and lines that
  are already latin script are never sent out for romanization.

## Settings

| Setting                    | What it does                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Target language**        | Language to translate into. Defaults to your client's own language.                                                     |
| **Display**                | `Translation only`, `Original + translation`, `Romanization only`, `Original + romanization`, `Romanization + translation`. |
| **Second line**            | Where the second half of a line goes — its own line (stays in sync, repeats the timestamp) or the same line (compact). |
| **Separator**              | Text placed between both halves in the same-line layout.                                                                |
| **Translate automatically**| Translate every track as its lyrics load, no button press.                                                              |
| **Skip matching languages**| Leave lyrics untouched when they're already in the target language.                                                     |
| **Show the toolbar button**| Hides the button if you only use auto-translate.                                                                        |

Changing anything that affects rendering clears the cache and restores the original lyrics,
so the next translation is built with the new settings.

## How it works

Lyrics arrive through the `content/LOAD_ITEM_LYRICS_SUCCESS` redux action, which the plugin
intercepts. Translated lyrics are pushed back through the same action (preceded by a `_FAIL`
so the view actually re-renders); a guard flag keeps those self-dispatches from being
re-intercepted.

Translation goes through Google's public `translate_a/single` (gtx) endpoint — no API key.
Two details that matter:

- **`q` is sent in the POST body**, not the query string: a full set of lyrics does not fit
  in a URL.
- **Line alignment is verified.** Google usually preserves the newlines it is given, but not
  always — and one dropped newline shifts every following line onto the wrong timestamp. Each
  batch's line count is checked against the input, and a batch that comes back misaligned is
  split in half and retried until it lines up.

Romanization is handled separately, one line per request through a small concurrency pool:
Google returns transliterations as a single blob with the newlines stripped, so there is
nothing to align a batched response against.

Lines are deduplicated before being sent (choruses repeat), and every result is cached per
track and per settings combination.

## Limitations

- The gtx endpoint is unofficial and rate limited. A failed request is retried once; a line
  that still fails keeps its original text rather than blanking out.
- Machine translation of lyrics is machine translation — idioms and wordplay will suffer.
  This is why `Original + translation` is the default.
- The toolbar button attaches next to the lyrics view's fullscreen toggle. If TIDAL reworks
  that toolbar, the button may disappear until the selector is updated; auto-translate keeps
  working regardless.
