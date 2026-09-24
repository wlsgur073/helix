// Real compare-mode pairs from the dogfood channel, transcribed verbatim from
// .superpowers/sdd/2026-09-20-item6/specimens-to-ship.json, produced by that directory's
// extract.mjs from the agent's own transcripts — see that path for provenance.
//
// Five compare calls exist as of 2026-09-20. Only three are published here. The other two (09-12,
// 09-18) passed the egress guard by a declared quote, and their passing audit row each name one
// echoed memory record, meaning their payloads carry at least 24 verbatim characters of a live
// memory; this repository is public, so the owner ruled on 2026-09-20 that those two stay
// unpublished.
//
// Each `codexAnswer` is the RENDERED form of what Codex returned for that call: normalized and
// datamarked, with the mark stripped. That rendering is a fixed point for those transformations on
// these three specimens, but it is NOT literally the raw bytes `buildAgreementMap` receives at
// runtime — do not mistake this for a raw capture.
export interface DogfoodSpecimen {
  label: string;
  helixAnswer: string;
  codexAnswer: string;
}

export const DOGFOOD_SPECIMENS: readonly DogfoodSpecimen[] = [
  {
    label: '2026-09-07',
    helixAnswer: `The program prints an advisory line after a lookup returns no rows, in the case where the text the person typed contains a blank-looking character other than the plain one. That line used to finish by asking them to type the phrase again using the plain character. I measured what happens when the recorded label also contains a blank-looking character, a different one. Typing the phrase again as instructed still returns nothing, since the recorded label continues to hold a horizontal tabulation while the retyped phrase now holds the plain character. The printed remedy is therefore not simply brief; it is inaccurate, and nothing else this program prints has been inaccurate in that way. There is a companion line covering the reverse arrangement, where only the recorded label carries such a character, and it does not help here either, since it would direct the person to the renaming verb while leaving their own typed phrase unchanged. Neither line covers the situation on its own, so ordering them differently cannot repair it. My choice was to leave the existing order alone and enrich the line that already prints, so that when the row it cites also carries such a character it states where in the recorded label that character occurs, and gives both parts of the remedy together in one sentence: use the plain character when typing, and invoke the renaming verb on that row so the recorded label uses it too. I confined the added fact to the first row cited, since the sentence cites exactly one row and an offset within any other label would say nothing about that sentence. I do not think this revives the earlier unresolved question in this project concerning how many remedies one printed line may carry, because that concern was about a reader handed alternatives who acts on one and stops reading, while these two parts are both required and neither suffices by itself. What the lookup actually returns is untouched, so this remains explanatory output rather than a change to comparison behaviour.`,
    codexAnswer: `Yes. If both sides contain contributing characters, reporting only one produces a remedy that may still return no rows.

The advisory should:

- Identify the character on each side, ideally by visible representation and Unicode code point.
- Recommend correcting or normalizing both values.
- Preserve the existing message when only one side contributes.
- Include tests for one-sided and two-sided mismatches.

That makes the diagnostic actionable rather than merely explanatory.`,
  },
  {
    label: '2026-09-13',
    helixAnswer: `Three considerations drove the boundary. The tracked defect blamed the referencing habit itself, not one careless contributor, and a habit ends only through something that refuses it automatically; another written convention would lean on the same attentiveness that let the habit persist in the first place. The two populations also differ in kind. Three references sit in program files, they are bounded, and a wrong pointer there misleads whoever is changing program behaviour. Ten sit inside the log, buried in a very large file, and each demands historical detective work to establish which agreement it originally denoted before any rewrite becomes possible; that workload deserves a dedicated pass of its own. Naming a target by day plus subject reuses a style already dominant in the log, so no third style enters circulation, and a day stamp is immune to insertion above it. One of the three could not be resolved at all: no surviving agreement expresses the principle in the language the comment ascribed to it, so instead of guessing at a target I wrote the principle out at the point where it governs, and noted that its pointer had decayed beyond recovery. Before accepting the change I confirmed the gate rejects the old state, listing precisely the three offending lines, and admits the new one; the automated checks totalled two hundred thirty five passing against two hundred thirty four beforehand, with no type errors. What this does not do is protect the log, which can still gain fresh offset references while its dedicated pass is pending, and I said so in the tracked defect instead of marking it resolved.`,
    codexAnswer: `Yes—based on your description, this is a sound incremental fix.

- **Scope:** Fixing the three program references removes that source of silent drift. Leaving the ten references in the log for follow-up is reasonable, and keeping the defect open accurately records the remaining exposure.
- **Reference format:** Date plus subject survives row insertions and follows the log’s existing practice. Each replacement should identify its intended agreement unambiguously.
- **Enforcement:** A required automated gate is a sound way to enforce the rule. A separate written convention isn’t necessary if the gate’s failure message explains the accepted format and gives an example.

The key verification is that all three replacements point to the correct agreements, and that the gate rejects representative offset references while accepting valid comments. The gate prevents the old reference style from returning; checking destination correctness remains a separate responsibility.`,
  },
  {
    label: '2026-09-20',
    helixAnswer: `Yes, and the reason is that only one of the two rules can be honoured by the written file at all. Records predating both fields exist and are still admitted when the file is read, so a program working from that file can meet a record with neither field present no matter what is written from today on. An empty list therefore guaranteed nothing to anyone downstream. It only gave one fact — nothing was filed under this heading — a second spelling, while the target date kept the first, and two spellings for one fact is a cost with no purchase. Nor was that difference ever chosen by anybody. A single expression builds the record, and it filled the category field on every pass because that argument had a fallback value, and filled the date field only when a date arrived because that one had none, so the layout of the file was inherited from a signature rather than from an intent, which is why I treat the change as a repair rather than a preference. The generated view sits in a different position and can keep the opposite rule honestly: it is rebuilt out of whatever the file happens to hold each time it is asked for, so it can promise every heading on every row, and it puts in the empty list and the null itself as it goes. One of them is an archive that cannot be made uniform after the fact; the other is a fresh rendering that can be. Older files already carrying the empty list read back exactly as before, so nothing has to be touched for the change to take effect.`,
    codexAnswer: `Yes, **if an omitted category field and an empty list both mean “no categories.”** Sparse storage then follows a coherent rule: unused optional fields are omitted. Matching the existing target-date convention is a reasonable way to choose that rule.

The original difference wasn’t necessarily wrong: an empty list naturally represents zero categories, while a date has no equivalent empty value. Your change improves uniformity; its correctness depends on preserving meaning and compatibility.

**The generated view can reasonably use a different rule.** It serves other programs, where a predictable set of fields makes consumption simpler. Expanding missing categories to \`[]\` and a missing target date to \`null\` is a useful normalization step. Each format has a consistent contract suited to its purpose.

Check that readers still accept older records containing \`[]\`, that they interpret omitted categories correctly, and that the generated view produces the same output from either representation. If omission means something distinct—such as “unknown” or “use an inherited value”—then treating it as an empty list would need reconsideration.`,
  },
];
