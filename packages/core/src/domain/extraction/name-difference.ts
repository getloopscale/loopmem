/**
 * Proper names two notes do not share (#252).
 *
 * When the judge says a later note replaces an earlier one, the two usually name the same people
 * and things except for the value that changed: one name gone, one name in its place. A note
 * about the same attribute of someone else looks different: it names that person and their value,
 * so each note has names the other lacks, and not the same number of them ("user's insurer is
 * Vida Plena" against "user's aunt Ottoline's insurer is Unimais"), or two on each side when
 * both notes are about relatives.
 *
 * This is one of two signals. Read alone it also fires on a value written with two names ("Ines
 * at Apex Motors" replaced by "Seu Nicanor"), so the caller acts only when a second, independent
 * reading agrees. It depends on capital letters and says nothing in a script without them.
 */

const NAME_PART = "\\p{Lu}[\\p{L}\\p{N}_'’\\-]*\\.?";
const CONTINUATION = "(?:[\\p{Lu}\\p{N}][\\p{L}\\p{N}_'’\\-]*\\.?|de|da|do|dos|das|of|van|von|del|la|at)";
const NAME = new RegExp(`(?<![\\p{L}\\p{N}_])${NAME_PART}(?:\\s+${CONTINUATION})*`, 'gu');
const LEADING_ARTICLE = /^(?:The|A|An|O|Os|As|Um|Uma)\s+/u;
const TRAILING_CONNECTOR = /\s+(?:de|da|do|dos|das|of|van|von|del|la|at)$/u;
const NOT_NAMES: ReadonlySet<string> = new Set(['user', 'the', 'user’s', "user's"]);

/** The proper names of a note, each a run of capitalised words, in lower case. */
export function namesIn(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.trim().replace(LEADING_ARTICLE, '').matchAll(NAME)) {
    const name = match[0].trim().replace(/\.+$/u, '').replace(/[’']s$/u, '').toLowerCase().replace(TRAILING_CONNECTOR, '');
    if (name !== '' && !NOT_NAMES.has(name)) names.add(name);
  }
  return names;
}

/**
 * True when each note has names the other lacks, and either not the same number of them or two
 * or more on each side. The second case is two different people with the same attribute: each
 * note names its own person and its own value.
 */
export function nameSetsDiffer(first: string, second: string): boolean {
  const a = namesIn(first);
  const b = namesIn(second);
  const onlyFirst = [...a].filter((name) => !b.has(name)).length;
  const onlySecond = [...b].filter((name) => !a.has(name)).length;
  return onlyFirst >= 1 && onlySecond >= 1 && (onlyFirst !== onlySecond || (onlyFirst >= 2 && onlySecond >= 2));
}
