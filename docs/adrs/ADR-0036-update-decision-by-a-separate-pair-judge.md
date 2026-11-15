# ADR-0036: A separate judge decides, pair by pair, whether a fact updates a memory

Status: Accepted (2026-11-13). The end-to-end run in the write path passed every criterion written
before it; the numbers are under "Result in the write path".

## Context

Supersession on write (ADR-0029) lets the extractor list, in the same call that extracts facts,
the existing memories a new fact replaces. Valid time then decides which side ends (#253).

That decision is wrong in both directions. On 223 pairs of notes with a gold label, three
repetitions, `gpt-4o-mini` (Observed):

- it finds 49 of 63 real updates and corrections: 21 of 32 updates said with no word of change,
  28 of 31 explicit corrections;
- it ends 5 of 160 notes that stay true: a count for another year, one more value of something that
  admits several, a different attribute.

The cost of a miss was measured too. When the old and the new value both reach a reader, it answers
35 of 113 questions; with only the new value, 67 of 67. Printing the date of each fact does not
help, and telling the reader that the later statement wins makes a stronger reader doubt facts that
do not conflict. A conflict has to be settled before it reaches the reader.

ADR-0033 tried a verification call over the pairs the extractor proposed and was rejected: it could
only refuse proposals, so it did nothing for the updates the extractor never proposed, and it did
not reach zero wrong invalidations.

No reference system read in source decides invalidation from a pair named inside the extraction
call. They use a separate judge, a later batch review, or a keyed slot (Reported, source read at
named commits).

## Decision

The extractor stops deciding. The supersession directive leaves the extraction prompt, and
`supersedes_memory_ids` is no longer read.

After the new facts are stored, each new fact is compared with each existing memory shown for the
write (the most similar ones, at most ten), one pair per call. The judge sees only the two texts and
the dates they were said, earlier first. It reasons before it answers, and answers `replaces` when
both give a value for the same thing, that thing holds one value at a time, and the values differ,
or when the later one says the earlier was wrong; and `both` when they can be true together: the
same value again, different things, different periods, separate occasions, or a thing that admits
several values.

On `replaces`, the earlier of the two ends at the instant the later one began, through the same
store operation and with the same history record as today. The period guard stays in front and
saves the call for a pair about different periods. A pair whose call fails or answers something
else is left alone and reported. Calls of one write run concurrently.

`supersedeOnWrite: false` turns the judge off, as it turns supersession off today.

## Evidence before the decision

Four ways of deciding were compared on the 223 pairs, outside the write path, with the rule of
choice written before the run:

| Way | Found, of 63 | Wrongly ended, of 160 |
|---|---|---|
| The extractor, in the extraction call (today) | 49 | 5 |
| A separate judge, one pair per call | 63 | 0 |
| An attribute key and a cardinality per fact, decided in code | 55 | 21 |
| The key and the judge both agreeing | 55 | 0 |

Only the pair judge passed the rule: it finds 14 updates today's path misses and loses none
(p below 0.001), and ends none of the notes that stay true. The key with a cardinality, which the
literature favours, marks as single-valued things that admit several (14 of 32 pairs of one more
language, pet or allergy).

Asked about a whole list of existing memories in one call, the same judge found 39 of 45 updates
and wrongly ended 20 of 579 other pairs on development data; asked pair by pair it found 45 and
wrongly ended none. So the call is per pair.

## What this evidence does not show

The 223 pairs are isolated and their wording comes from a small pool of sentence shapes; a careful
independent reader also labels 223 of 224 of them correctly, so the isolated task is easy. What
is not measured yet: the judge inside the write path with real retrieval choosing its candidates,
conversation-like wording, and latency. The end-to-end run exists for the first of these.

## Consequences

- Up to ten small calls per new fact, when the scope has memories similar to the write. They run
  concurrently and carry two short texts each.
- The extraction prompt loses a responsibility. Its other outputs may shift and are checked by the
  existing fidelity and memory-semantics evaluations.
- An update between two facts of the same write is not judged; only new against existing.
- Wrong invalidations of the kind in #252 should fall, since the judge refuses the pairs the
  extractor used to propose. `judge-cases-supersession-check.json` is the guard for that.

## How it is approved

Base and arm in the same batch, three runs each, read with `comparePaired`, on a case set written
before the code: several notes per person in English and Brazilian Portuguese, with updates logged
in and out of order and controls that are not updates. The criteria are fixed in the benchmark log
before the first run and cover: current answers without the old value, controls still answered,
answers as of a date before the change, the 223 pairs through the real write path, and the earlier
case sets as guards.

## Result in the write path

Base (the commit before the judge) and arm in the same batch, three runs each, `gpt-4o-mini`
(Observed):

| Measure | Base | Arm | Paired reading |
|---|---|---|---|
| Current-value questions with no old value in the top five (48) | 22, 22, 24 | 47, 48, 47 | arm 29, base 0, p < 0.0001 |
| Control questions answered (80) | 75, 76, 76 | 76, 77, 77 | arm 4, base 5, p = 1.0 |
| Questions as of a date before the change, answered (48) | 48, 48, 48 | 47, 47, 47 | arm 0, base 2, p = 0.5 |
| Real updates ended, of 63 pairs, majority of three | 54 | 63 | arm 9, base 0, p = 0.004 |
| Notes that stay true and were kept, of 160 pairs | 155 | 159 | arm 5, base 1, p = 0.22 |
| `judge-cases-supersession-check.json` answered (72) | 63, 64, 63 | 72, 72, 72 | arm 10, base 0, p = 0.002 |

The other guard sets (`judge-cases`, `judge-cases-multi`, `judge-cases-late-arrival`,
`judge-cases-period`) show no significant difference in answered questions. In the late-arrival
set the old value left the top five in 16 more questions (p = 0.0003). Memory-semantics passes
with no forbidden fact, the small-talk controls of the fidelity evaluation store nothing, and the
frozen date set is unchanged (141 against 140 correct of 156).

Limits of this result:

- Through the real write path the judge still ends one or two of the 160 notes that stay true in
  each repetition, always one more value of an attribute that admits several. The isolated
  measurement had shown none.
- In the end-to-end set, the count of ended memories that are not an old value is the same on both
  sides (10 in three runs). The judge does not lower it there.
- One question as of an earlier date is lost in all three arm runs.
- A run of the end-to-end set took about a third longer on a loaded machine. Judge calls were not
  counted separately.

## Alternatives considered

- Keep the decision in the extraction call and loosen its instruction. Rejected: the same call
  already errs in both directions, and earlier prompt changes moved unrelated outputs.
- A keyed slot per attribute with a cardinality (the profile shape of some reference systems).
  Measured and rejected for now: 21 wrong endings of 160 with a small model.
- One judge call over the whole list. Measured on development data and rejected.
- Leave both values and let the reader decide by date. Measured and rejected (H195, H196).

## Amendment (2026-11-14): measured limits of the judge

Later sets, written for the cases the approval set did not have, show two kinds of pair the judge
gets wrong (#252). All figures are Observed with `gpt-4o-mini`, three runs, on sets kept in
`packages/eval/src/stages/update-decision/` and `update-history/`.

- The same attribute of another person. "The user's insurer is A" followed by "the user's aunt's
  insurer is B": the judge ends the first fact in 37 to 50 of 96 runs across three independent sets.
- Two values in tension that can both hold. The judge ends the first in 46 to 87 of 96 runs.
- Updates and corrections are still found: 95 to 100% in every set.

End to end, on 16 histories of 36 dated messages (176 questions, `topK` 5, one reader):

| Question | Ending on write | `supersedeOnWrite: false` |
|---|---|---|
| The user's current value (192) | 170 | 90 |
| A relative's value of the same attribute (144) | 61 | 123 |
| A relative's current value (48) | 46 | 24 |
| A fact that never changes (144) | 134 | 132 |

Ending on write stays the default. It gives the reader the current value far more often than
leaving every value with its date, and a reader given the whole history does no better (162 of
192). Its cost is the second row: the relative's fact was in the recall result in 72 of 144 runs.

What was tried and not adopted, each against criteria fixed before the run:

- A second call that describes the pair, as a veto. Wrong endings fell from 93 to 9 of 288; updates
  found fell to 91.3%, under the 95% floor.
- A second call that reads whose fact each note is, as a veto. Wrong endings fell from 47 to 4 of
  192; updates found fell to 93.0%, under the same floor.
- The extractor stating whose fact it is, in the extraction call. On development sets the label was
  missing or wrong too often to gate anything, and wrong endings did not fall.
- A larger model on the same judge prompt (development sets, one run): `gpt-4.1` still ended 31 of
  96 pairs about another person, against 47 for `gpt-4o-mini`. Model size alone does not remove it.

What a caller can do today: an ended fact is never deleted, so `recall({ asOf })` before the ending
still returns it, and the `history` of the memory names the fact that ended it.
`createLocalMemory({ supersedeOnWrite: false })` keeps every value current, at the cost shown in
the first row of the table.

## Amendment (2026-11-15): a pair of facts of two individuals is kept when two readings agree

The first limit above, the same attribute of another person, now has a fix that passed.

After the judge says "replaces", the pair is kept, and nothing ends, when two independent readings
agree that the notes are facts of different individuals:

- The names differ. Each note has proper names the other lacks, and not the same number of them
  ("user's insurer is Vida Plena" against "user's aunt Ottoline's insurer is Unimais"). Read from
  the stored texts, with no model call (`name-difference.ts`).
- The owners differ. Each note, read on its own by the model, is split into value, attribute and
  owner, and the two owners are compared in code (`fact-owner.ts`). This call is made only for the
  pairs where the names differ.

An owner that cannot be read counts as no agreement, and the note ends as before. A kept pair
emits `update_declined` with `reason: different_owner`.

Why two readings. Each one alone was measured and failed the floor of 95% of updates found, in
different places: the owner reading takes a mechanic or a doctor named at the start of a note for
the owner (93.0%), and the name reading fires on a value written with two names. Requiring both
removes most of each one's mistakes.

Measured on a fresh set (`pairs-owner-confirmation-two.json`, 192 pairs, names and attributes used
in no other set, written one pair at a time by agents with no access to the repository, read blind
by another), criteria fixed before the set existed and with the thresholds of the two earlier
attempts, base and change in one batch, three runs, `gpt-4o-mini`. Observed:

| Family (96 runs each) | Base ended | Now ended | Expected |
|---|---|---|---|
| Fact of another person | 23 | 0 | stays |
| Two relatives | 0 | 0 | stays |
| Update | 93 | 94 | ends |
| Update of a relative | 95 | 89 | ends |
| Correction | 95 | 94 | ends |
| Switch | 96 | 96 | ends |

- Wrong endings in the two families that stay: 23 of 192 before, none now; fewer in 8 pairs, more
  in none (p = 0.008).
- Updates found: 373 of 384 (97.1%), against 379 for the base.
- Sets already seen, as a guard: the first confirmation set, 372 of 384 updates found and wrong
  endings from 51 to 18 of 192; the held-out attribute set, 264 of 264 and 88 to 64 of 384; the
  first pair set, 189 of 189 and 10 to 10 of 480.
- `memory-semantics`, three runs per side: no forbidden fact on either side.

What this does not fix, and its cost:

- Two values in tension that can both hold are still ended (50 and 51 of 96 on the held-out set).
- Two different relatives with the same attribute are not told apart by the names (9 of 96 wrong
  endings on the first confirmation set, 12 for the base).
- Updates of a relative's fact fall from 95 to 89 of 96 on the fresh set.
- The name reading depends on capital letters. In a script without them it never fires, and the
  judge decides alone, as before.
- One or two more model calls on a write where the judge says "replaces" and the names differ.

## Amendment (2026-11-15, second): the name reading also fires for two different relatives

The amendment above left one case out. Two relatives with the same attribute ("my uncle
Halvard's dentist is Dr. A", then "my aunt Thora's dentist is Dr. B") each name their own person
and their own value: two names the other note lacks on each side, the same number, so the name
reading did not fire and the judge decided alone.

The name reading now also fires when each note has two or more names the other lacks. The owner
reading is asked as before, and the pair is kept when the owners differ.

Measured against the previous amendment as base, criteria fixed before the fresh set existed,
one batch, three runs, `gpt-4o-mini`. Observed, wrong endings in the two families that stay, of
192 runs, and updates found, of 384:

| Set | Wrong endings, base | Wrong endings, now | Updates found, base | Updates found, now |
|---|---|---|---|---|
| Fresh (`pairs-owner-confirmation-three.json`) | 1 | 0 | 375 | 376 |
| Second confirmation set, seen | 0 | 0 | 379 | 375 |
| First confirmation set, seen | 15 | 0 | 373 | 370 |

How to read it. The criteria passed, and the fresh set says the change does no harm, but it had
one wrong ending to fix, so it does not show the benefit. The benefit is measured on the first
confirmation set, 15 to 0 (fewer in 8 pairs, more in none, p = 0.008), and that set is also the
one the rule was estimated on. Updates found stay above 96% on all three.

