# Read-path corpus

Real arXiv documents that `arxiv_read_paper`'s read path is tested against. `corpus.test.ts` reads every fixture here through `ArxivService.readContent`, with the network rungs answering from the stored bytes and the PDF going through the real text extractor. Each fixture must pass the license gate and the read invariants in `corpus-gate.ts` before its `expected.json` snapshot is compared.

## Layout

```text
tests/corpus/<kind>/<fixture-id>/
  source.html.gz | source.pdf   the document exactly as served (HTML gzipped)
  meta.json                     provenance and license
  expected.json                 snapshot, written by the runner
```

| Kind | Read outcome |
|:--|:--|
| `render` | served from the rung `meta.json` names (`arxiv_html` or `ar5iv`) |
| `empty` | the page is no render, so the chain requests the next rung |
| `pdf` | `pdf_text` from the stored PDF |

A fixture ID is `<origin>-<identifier>`: `arxiv-2409.09856v3`, `ar5iv-1906.00591`. It must match `meta.id`.

## meta.json

```json
{
  "id": "arxiv-2409.09856v3",
  "paperId": "2409.09856v3",
  "title": "…",
  "url": "https://arxiv.org/html/2409.09856v3",
  "rung": "arxiv_html",
  "retrieved": "2026-10-25",
  "license": {
    "id": "CC-BY-4.0",
    "url": "https://creativecommons.org/licenses/by/4.0/",
    "confirmedBy": "https://arxiv.org/abs/2409.09856v3"
  },
  "attribution": "Author A, Author B. Title. arXiv:2409.09856v3. 2024.",
  "sha256": "<SHA-256 of the served bytes>",
  "notes": "What the fixture exercises."
}
```

- `paperId` is the versioned ID the runner reads. `url` is where `rung` serves it. An ar5iv URL may leave off the version, since ar5iv keeps one render per paper.
- `sha256` is the hash of the document as served: the gunzipped HTML, or the PDF file. Compute it with `shasum -a 256` on the fetched file. arXiv revises its site markup, so a later fetch of the same page can hash differently.
- `notes` is optional. No other fields are allowed.

## Adding a fixture

1. **Check the license for the exact version.** Only CC BY 4.0 (`CC-BY-4.0`), CC BY-SA 4.0 (`CC-BY-SA-4.0`), and CC0 1.0 (`CC0-1.0`) are allowed, with the matching deed URL in `license.url`. NC and ND licenses, arXiv's non-exclusive distribution license, and papers with no license are refused.
2. **Record where you checked it** in `license.confirmedBy`, as one of:
   - `https://arxiv.org/abs/<id>v<n>`: the abs page of that exact version, which shows that version's license.
   - `https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:<id>&metadataPrefix=arXiv`: the OAI-PMH record. It reports only the latest version's license, so use it only when the fixture is the latest version. `export.arxiv.org/oai2` has moved here.
3. **Store the bytes as served.** Fetch with `curl -g`, keeping at least 3 s between arXiv requests. Never trim, reformat, or re-encode a page: a trimmed page is an adaptation that CC BY requires a change notice for, and it hides the real size. Gzip HTML with `gzip -9 -n -c page.html > source.html.gz`; store a PDF as is. `.gitattributes` marks `*.gz` and `*.pdf` binary.
4. **Keep each stored source at most 256 KB** (262,144 bytes). Prefer the smallest document that shows the behavior.
5. **Write `meta.json`**, then run the corpus once: `bun run test tests/corpus/corpus.test.ts`. The first run of a new fixture writes its `expected.json` after the fixture's checks pass. Review that file before committing it.

## Updating snapshots

A change to the read path that moves a snapshot fails the run with a diff. Once the new values are confirmed correct, rewrite the snapshots with `bun run test tests/corpus/corpus.test.ts --update`. Put `--update` after the file path: Vitest reads a value following `-u` or `--update` as the update mode, so `-u tests/corpus` runs the whole suite in update mode. The license gate and the invariants run before the snapshot comparison in the same test, so a fixture that fails a check fails before its `expected.json` is compared or written.

`expected.json` is written in the layout Biome formats JSON to, so `devcheck` leaves it as the snapshot compares it. Never edit it by hand.

## Removing a fixture

Delete its directory. No other file lists fixtures: the runner reads every `<kind>/<fixture-id>/` directory with a `meta.json`.
