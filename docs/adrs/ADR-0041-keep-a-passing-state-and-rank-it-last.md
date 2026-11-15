# ADR-0041: A passing state with no day word is kept and ranked last

Status: Accepted (2026-11-14), amended the same day: the ranking part was removed, see the
amendment at the end. Narrows the expiry rule of ADR-0035, stage 1.

## Context

ADR-0035 ends a fact with the day it was said when the extractor labels it `temporary` or
`tentative`, its tense is not future or past, and no date was resolved. Recall stops showing it
the next day.

The label is right for wishes and moods of the moment and wrong for a minority of things that
last. Measured on sentences written for this, three repetitions, `gpt-4o-mini` (Observed):

- something that goes on for weeks ("I am taking a course at ...") was stored to expire in 14 of
  120 writes on one set and 60 of 480 on another;
- a lasting attribute stated about the person, in 16 of 576 values;
- a wish of the moment with no word for the day, in all 120 writes, which is what the rule is for.

A month later the lasting things that expired no longer answer a question (#285). One day leaves
no room for the error of the label, and a longer horizon only moves the loss to a later date.

## Decision

What is stored and what recall shows first are separated.

- A `temporary` fact gets an end with its day only when its source quote has a word for the day
  or the moment (a fixed list in six languages; the bare "now" of each language is not on it).
  Without such a word the fact is stored with no end, and `short_lived_kept_without_expiry` is
  emitted.
- A `tentative` fact, an undecided statement, still ends with its day.
- In recall, after the threshold, the facts labeled `temporary` that have no event date and were
  said before the day of the query are placed after all the other results, in their own order.
  There is no numeric weight: a passing state of an earlier day never ranks above a fact that is
  not one, and it still appears when nothing else answers. The event is
  `recall_stale_state_demoted`.
- What recall returns already carries when the fact was said and its durability, so a reader can
  tell an old state from a current one.

## Evidence

Base and arm in the same batch, three repetitions per side, on 160 people written for this: each
states a lasting fact, something that goes on for weeks and a wish of the moment, and is asked
about them thirty days later (Observed; 480 answers per row).

| Question, a month later | Base | Arm | Paired by person |
|---|---|---|---|
| About the lasting fact | 476 | 476 | 2 and 2 |
| About the ongoing matter | 417 | 477 | arm 27, base 0, p < 0.0001 |
| Whether the wish holds today: the reader said it does | 3 | 8 | base ahead in 3, p = 0.25 |
| What the wish was a month ago, answered | 3 | 458 | arm 154, base 0, p < 0.0001 |

In the arm the old wish reached the reader in all 480 answers, with its date and label, and the
reader said it held only on the earlier date in 472. A state tied to the day by its own words
expires as before (96 of 120 writes on both sides). Extraction fidelity, the frozen date set and
memory-semantics are unchanged.

## What was tried first and rejected

The same rule for the expiry, with no change to recall. It removed the wrongful expiries and left
every wish of the moment in the results as if it were current, with nothing to rank it below the
rest; its own criterion also failed for lack of power. Reverted.

## Consequences

- Nothing a person stated without a day word is lost to the label. A wish or a mood of the moment
  stays stored and can be asked about later.
- A reader given an old state with its date called it current in 8 of 480 answers, against 3
  before. Callers that show recalled facts to a model should pass the date and the durability
  along; the MCP `recall` tool already returns both.
- The demotion applies to the default order of recall. A caller that asks for a reranker,
  diversification or a scope reweight gets the order those produce.
- The check that counted a stored passing state as a defect now has to look at what recall
  returns. The memory-semantics evaluation still passes as it is, with no forbidden fact.

## Limits

- The approval set has three sentences per person, so the old state always fits in the top five.
  It measures what a reader does with it, not how often it is pushed out of a longer list.
- One reader model. The case set was written and checked by the same model family as the author
  of this record.
- A lasting fact labeled `tentative` still expires with its day (9 of 504 values on a
  development set).
- The list of day words is finite. A state tied to the day by a word that is not on it is kept
  and ranked last.

## Amendment (2026-11-14): the ranking part is removed

The first limit above was measured. The same 160 people got ten more lasting statements each, so
that the top five is contested, and a fifth question about one of them. Base is this record as
written; the arm stores the same way and leaves the order of recall alone. Same batch, three
repetitions per side (Observed; 480 answers per row).

| Question, a month later | With the ranking | Without it | Paired by person |
|---|---|---|---|
| About the lasting fact | 470 | 471 | 2 and 2 |
| About the ongoing matter | 397 | 471 | without 27, with 1, p < 0.0001 |
| Whether the wish holds today: the reader said it does | 0 | 9 | with ahead in 5, p = 0.0625 |
| What the wish was a month ago, answered | 148 | 437 | without 101, with 1, p < 0.0001 |
| About one of the ten added statements | 236 | 238 | 4 and 2 |

The extractor labels part of the ongoing matters `temporary`. In a scope of three sentences the
ranking cost them nothing; in a scope of thirteen it pushed them out of the top five, and 74 of
480 questions about them went unanswered. It did the same to the wish when the question was
about the past. What it bought was the reader calling an old wish current in 0 answers where
without it the reader does so in 9 of 480 (1.9%), under the 5% fixed before the run.

The three criteria fixed before the run passed, so the ranking is removed: `demoteStaleStates`
and the event `recall_stale_state_demoted` no longer exist. The expiry rule of the decision
stands. What keeps an old state from being read as current is the date and the durability that
recall returns with it.

Limits of this measurement: one reader model, top five, thirty days. The criterion on the old
wish passed at p = 0.0625 with five people against none, so a larger set could show a
difference this one could not. The question about an added statement was answered in about half
of the runs on both sides. The cause is in the case set and in the write path, not in recall: the
added statements gave a favourite dish and, three messages later, said the person is a
vegetarian. When the dish had meat or fish the update judge ended it (240 of 240 rows, against 2
of 240 for the other dishes), and the question had nothing to find (#252). Both sides had the
same split, so the comparison stands.

## Amendment (2026-11-14, second): a `tentative` fact follows the same rule

The decision above left `tentative` facts ending with their day, with the limit recorded as 9 of
504 values on a development set. A live sweep of the write path showed a family where the rate is
far higher: what someone told the person to do. "My therapist suggested I start journaling." was
stored with an end at the close of the day in 5 of 5 writes, and "My boss told me I need to travel
to Denver in May." in 2 of 5 (#304). The extractor gives the label to "should" and "need to".

A `tentative` fact now ends with its day only when its source has a word for the day, as a
`temporary` fact does. `short_lived_kept_without_expiry` reports both and carries `durability`.

Measured on a fresh set of 160 sentences in five families (`short-lived-expiry/cases-undecided.json`,
written by an agent with no access to the repository, read blind by another, criteria fixed before
the run), base against this change in one batch, three runs, `gpt-4o-mini`. Observed:

| Family (96 writes each) | Stored, base | Stored, now | Expiring, base | Expiring, now |
|---|---|---|---|---|
| Reported advice | 96 | 96 | 24 | 0 |
| Dated obligation | 96 | 96 | 3 | 0 |
| Undecided plan | 45 | 43 | 36 | 0 |
| Undecided about today (day word) | 0 | 0 | 0 | 0 |
| Undecided about the moment (no day word) | 8 | 9 | 0 | 0 |

- The three families that should stay: 63 of 288 writes expired before and none now; fewer in 26
  sentences, more in none (p < 0.001).
- The earlier set (`cases.json`): a state with a day word still expires (94 and 95 of 120), and a
  habit or an ongoing matter does not (0 and 0, 1 and 0).
- `memory-semantics`, three runs per side: no forbidden fact on either side, precision 0.92 and 0.91.

What this does not show:

- The control family "undecided about today" stored no fact on either side, so it gave no evidence
  that an undecided statement with a day word still expires. That branch is covered by a unit test
  only.
- Half of the undecided plans ("I'm thinking of moving to another city") are not stored at all, on
  both sides. That is a separate loss, before this rule.
- One extractor model, sentences in English and Portuguese.

