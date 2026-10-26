---
name: arxiv-guide
description: Resolve citations to arXiv IDs, find an author's papers, follow a paper's versions, and read long papers section by section with the arxiv_* tools. Use when a task needs arXiv preprints found by citation (author-year, CoRR abs/ refs, arXiv DOIs), author, category, or date, or needs a paper's full text.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

arXiv preprints in physics, mathematics, computer science, quantitative biology, quantitative finance, statistics, electrical engineering, and economics: metadata, abstracts, and full text. Keyless.

- Search reads metadata only (title, authors, abstract, comments, journal reference, categories), never the paper body. A phrase that appears only inside papers is not searchable: find candidates by metadata, then read them.
- No citation counts, cited-by lists, author identifiers, or lookup of the published version. Pair with a scholarly-graph server (OpenAlex, Crossref, or INSPIRE for high-energy physics) for those, and with a bioRxiv/medRxiv server for biology preprints never posted to arXiv.
- A paper becomes findable only once arXiv announces it: Sunday through Thursday at 20:00 US Eastern, never on Friday or Saturday, and moderation can hold a submission one to four days first. A paper submitted today is not here yet, and nothing newer than Thursday's announcement over a weekend is normal.

## Identifiers

An arXiv ID is `YYMM.NNNNN` (`YYMM.NNNN` before 2015) or, before April 2007, `archive/YYMMNNN`, either with an optional `vN`. `YYMM` is the month arXiv first announced the paper, usually its submission month.

References carry IDs in forms the tools reject. Strip them first:

| In the reference | Pass |
|:--|:--|
| `CoRR abs/1409.0473` (DBLP-style computer-science references) | `1409.0473` |
| `10.48550/arXiv.1706.03762`, or its doi.org URL (arXiv's own DOI) | `1706.03762` |
| `arXiv preprint arXiv:1607.06450`, an `arxiv.org/abs/…` URL | as written |

A paper's `doi` field is the journal version's DOI, never arXiv's. The `id` the tools return carries the latest version suffix; an ID without one means the latest version.

## Gates

- **Missing `journal_ref` or `doi` does not mean unpublished.** Authors add both by hand, and many never do: 1706.03762, a NeurIPS 2017 paper, has neither. arXiv tells authors to put acceptance notes in `comment` instead (1206.4635's reads "ICML2012"). Check `comment`, then a scholarly-graph server, before calling a paper unpublished.
- **A quoted full name can miss name variants.** Author strings are free text that differ from paper to paper: middle initials come and go, and some carry an affiliation in parentheses. How a quoted author phrase matches those variants also differs between deployments, so the same quoted name can return different papers on two servers while the surname alone returns the same set. For an author's papers, search the surname alone, narrow with a category, a topic word, or a co-author's surname, then check each `authors` list yourself. arXiv has no author identifiers, so one name can be several people: confirm by co-authors and subject.
- **A category filter includes cross-lists.** `cat:cs.LG`, or `cs.LG` as `category`, matches every paper listing cs.LG in `categories`, primary or not: 1206.6445, primary cs.CV, comes back for cs.LG. For a field's own papers, keep those whose `primary_category` matches.
- **The date window is the first version's date.** `submitted_from` and `submitted_to` filter on `published`, the v1 submission: a paper posted in 2022 and revised in 2024 falls outside a 2024 window. To find recent revisions, sort by `updated`.
- **A citation's year is the venue's, not arXiv's.** The two can be years apart: 1205.2614, posted in 2012, carries the comment "Appears in … UAI2009". Widen a year window, or drop it and match on author and title words.
- **Absence needs a second search.** Before reporting that arXiv has no such paper, search again with the first author's surname and one distinctive title word, no window and no category.
- **arXiv's API is one shared lane.** The server sends arXiv API requests one at a time, 3 s apart, across every caller, so parallel calls only queue. Batch IDs into one `arxiv_get_metadata` call (10 looked up per call) rather than one call per paper. A timeout usually means arXiv itself is slow: retry later, not at once.
- **A pinned version always needs arXiv's live API.** A deployment's local mirror holds only the latest version, so while arXiv is slow a `vN` lookup can time out where the same ID without the suffix still answers.

## Workflows

**Resolve a citation.** An ID anywhere in the reference, stripped per the table, goes straight to `arxiv_get_metadata`. Otherwise search `au:<first author's surname> AND ti:<one or two distinctive title words>`, widened per the year gate, and confirm title and authors before using the ID: "Vaswani et al. 2017, Attention" as `au:vaswani AND ti:attention` within 2017 returns 1706.03762 alone.

**Everything by one author in one category.** `au:<surname> AND cat:<code>` sorted by submitted date, then filter the `authors` lists per the name gate. Run it once more without the category to catch papers filed elsewhere, and apply the cross-list gate if only the category's own papers count.

**Follow a paper's versions.** The suffix on the returned `id` is the latest version, so `…v7` means v1 through v7 exist; `published` is v1's date and `updated` the latest's. `arxiv_get_metadata` takes several pinned IDs in one call and returns each version's own abstract, comment, and `updated` date: 1706.03762v1 reports 41.0 BLEU where v5 reports 41.8. For a pinned version's full text, an `arxiv_html` body is that version; an `ar5iv` body may not be. Every version's submission date is also in arXiv's DataCite record, DOI `10.48550/arXiv.<id>`.

**Read a long paper section by section.** Call `arxiv_read_paper` with `start` 0 and a small `max_characters` (2,000 is plenty): the outline covers the whole body whatever the slice size. Then read one section with `start` set to its entry's `start` and `max_characters` set to the next entry's `start` minus this one, which returns that section and nothing more. Appendices can follow the bibliography, so References is not always the last entry. A `pdf_text` body has no outline; page through it with `start`.

**Follow references.** Read the bibliography from its outline entry. References to arXiv papers appear as `arXiv:YYMM.NNNNN` or `CoRR, abs/YYMM.NNNNN`; strip them per the table and pass them to `arxiv_get_metadata` in batches, following `remaining_ids` past the first 10. A reference without an arXiv ID needs a title or DOI lookup on a scholarly-graph server.
