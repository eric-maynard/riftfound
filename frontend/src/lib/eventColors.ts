/**
 * One chip colour per event type, in one place.
 *
 * The calendar grid chip, the "+N more" day list, the format picker's dots and
 * the hover card's tag each carried their own copy of this map with a comment
 * saying it had to match the others. That is how a contrast fix gets applied
 * to one chip and quietly missed on the rest.
 *
 * **The ink is measured against the chip, not against the page.** A chip's
 * label is `--fc-event-text-color` / `.day-event-item`'s colour, both
 * `--color-bg` (#363b43); the trophy's glyph is #21222c. These are solid hex,
 * so there is nothing to composite - but every value here is measured against
 * both inks:
 *
 *   #bd93f9  Nexus Night        label 4.67:1   trophy 6.55:1
 *   #ff79c6  Summoner Skirmish  label 4.72:1   trophy 6.62:1
 *   #73d393  Pre-Rift           label 6.15:1   trophy 8.62:1
 *   #9ea8c7  Other              label 4.77:1   trophy 6.68:1
 *
 * `Other` was Dracula's "comment" slate #6272a4. That put its own label at
 * **2.39:1** against AA's 4.5, and no ink could rescue it: pure black only
 * reaches 4.46:1 on that slate. It also held the trophy to **3.36:1**, the
 * binding case across all four chips against the 3:1 graphics floor. So the
 * chip itself had to move. It is lightened along its own hue - 226 held,
 * saturation held at 27%, L 51% -> 70% - which is the same move
 * `--color-text-muted` made away from the same original value, and lands it in
 * the lightness band its three peers already occupy (64-78%).
 *
 * `--color-border` keeps #6272a4 and is deliberately not imported here: a
 * hairline is not text, and the select chevrons drawn in that slate are not
 * text either.
 */
export const EVENT_COLORS: Record<string, string> = {
  'Nexus Night': '#bd93f9', // Purple
  'Summoner Skirmish': '#ff79c6', // Pink
  'Pre-Rift': '#73d393', // Soft pastel green
  'Other': '#9ea8c7', // Lightened slate - see above
};

/** The fallback chip: an unrecognised type is an "Other" event. */
export const OTHER_EVENT_COLOR = EVENT_COLORS['Other'];

/** The chip colour for an event type, falling back to the slate. */
export function eventColor(eventType: string | null | undefined): string {
  return EVENT_COLORS[eventType ?? 'Other'] ?? OTHER_EVENT_COLOR;
}
