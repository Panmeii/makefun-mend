# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Panmeii/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Panmeii/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in many shapes; mend reads all of them — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits — finds the lines each edit names even when the model's line numbers, trailing whitespace or indentation have drifted, and writes every change or none. Atomic, line-ending-preserving, and safe-path-checked; it passes 100 of 100 public practice checks.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8nt1dqan&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

---

# mend — one patch tool for every AI edit format

Entry for the make.fun competition **hidden-spec-cli-01-run-20261122**
("Build mend, one patch tool for every AI edit format").

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in many shapes; mend reads all of them, finds the lines each edit names even
when the model's line numbers, trailing whitespace or indentation have drifted,
and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file's path. When it is absent or `-`, the patch is read from
  standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or `json`.
  The default, `auto`, detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only; see below).
- `--` ends the options; options and `PATCH` may otherwise come in any order.

Exit codes: `0` — the tree was written, stdout lists `A`/`D`/`M`/`R` lines in byte
order of path plus `ok: <n> file(s)`; `1` — nothing was written, stdout lists one
`error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits`;
`2` — a single `error: usage` / `error: no-patch` / `error: format` /
`error: parse <N>` line. The full contract is `SPEC.md`.

## Formats supported

1. **Unified diff** — `diff --git` sections and bare `---`/`+++` sections, multiple
   files and hunks, creations (`/dev/null`, `new file mode`), deletions
   (`/dev/null`, `deleted file mode`), renames (`rename from`/`rename to` or
   differing `---`/`+++` paths, reported as `R <old> -> <new>`), empty-line context,
   `\ No newline at end of file`, prose and code fences around the patch. Hunk line
   numbers are only a hint: each hunk takes the occurrence nearest to its stated
   position, adjusted by the hunks applied before it.
2. **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` /
   `>>>>>>> REPLACE` form, with the target path on the nearest non-blank,
   non-code-fence line before the block (later blocks may reuse the previous
   block's path). An empty SEARCH side creates the file; a block whose old lines
   occur more than once fails `ambiguous`.
3. **V4A** — `*** Begin Patch` … `*** End Patch` with `*** Add File:`,
   `*** Delete File:` and `*** Update File:` sections, `*** Move to:` moves,
   `@@ <anchor>` chunks applied with a forward cursor, and `*** End of File`
   chunks anchored to the file's last line.
4. **JSON edits** — one JSON array of edit objects, or JSON Lines with one object
   per line: `create` (writes `file_text` byte for byte), `str_replace` (exact,
   must occur exactly once; CRLF-aware) and `insert` (after a 0-based line number).

## Matching tiers

Unified hunks, SEARCH/REPLACE blocks and V4A chunks locate their old lines at the
first of three tiers that matches: tier 0 exact, tier 1 ignoring trailing spaces
and tabs, tier 2 ignoring leading and trailing spaces and tabs. Context lines are
always written back as the file's own matched lines, and at tier 2 the new lines
are re-indented from the patch's indentation to the file's. `--strict` tries
tier 0 only.

## Guarantees

- **Atomic**: edits apply in patch order to an in-memory tree; if any edit fails,
  no file is written and every failure is reported.
- **Line endings preserved**: a changed file keeps its own CRLF/LF break and its
  final-break state (unified hunks honour `\ No newline at end of file`); created
  files use LF.
- **Safe paths only**: empty paths, absolute paths, backslashes and empty, `.` or
  `..` segments fail with `unsafe`.

## Files

- `main.ts` — the CLI (Node 22+, standard library only, no build step).
- `runner.ts` — the kit's trial runner, kept as provided; `main.ts` hands over to
  it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` against the kit's public practice set
  (`node check.ts <practice.json>`). This entry passes 100 of 100 practice checks.
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.

Built for make.fun hidden-spec-cli-01-run-20261122.
