# Final submission checklist

Audit of commit **c13f163** of https://github.com/mohit-k1708/ClearKYC (branch `main`, public). Everything marked "verified" was checked on a **fresh clone of that commit from GitHub** (not on the working folder), set up exactly as the README says, on its own PostgreSQL server with freshly generated keys. The development database was not used.

> The address `https://github.com/mohit-k1708/ClearKYCcheck` does not exist. The repository is `ClearKYC`. Check which address you will submit.

## 1. Repository readiness

| Item | Status | Evidence |
|---|---|---|
| Repository exists, is public, default branch `main` | Verified | `gh repo view`: public; remote `main` = local `HEAD` = `c13f163` |
| One commit, author uses a GitHub no-reply e-mail | Verified | `git log` on the clone |
| 414 tracked files, no `.env`, `.pgdata`, `node_modules`, uploads, build output, logs | Verified | `git ls-files` on the clone |
| `.gitignore` excludes secrets, dependencies, build output, local databases, logs; keeps the dataset, `dataset/`, `docs/`, `.sql` files | Verified | `git check-ignore` on the submission artifacts: none ignored |
| `.gitattributes` keeps the dataset byte-exact on Windows clones | Verified | clone with `core.autocrlf=true`: 65 checksums verify; without the file they fail |
| Both lock files tracked; `engines` (Node >= 20) and `postinstall` (Prisma client) declared | Verified | `package.json`, `client/package.json` |
| README: overview, features, software and versions, install, `.env` variables, database and migrations, run, tests, production build, workflow verification, documentation map, limits | Verified | every `npm run` in the README exists in `package.json` (18 checked); every `.env.example` variable is explained; no broken relative links in README / docs |
| Project structure explained | Partly | README section 2 lists the folders, but sections 2 to 8 still describe the Scene 1 era (see section 6) |
| LICENSE file | Added, not yet pushed | MIT (`LICENSE`, `"license": "MIT"` in `package.json`, README "License" section) |

## 2. Setup and execution (commands checked on the clean clone)

```powershell
git clone https://github.com/mohit-k1708/ClearKYC.git
cd ClearKYC
npm install                      # also generates the Prisma client
npm --prefix client install
copy .env.example .env           # then put two random 64-hex keys in .env (command in the README)
npm run db:local                 # terminal A: bundled PostgreSQL 17 (leave running)
npm run db:migrate               # 10 migrations
npm run dev                      # backend  http://localhost:4000   (health: /api/health)
npm run client                   # frontend http://localhost:5173
```

Optional demo data, tests, build: see README sections 1.3 and 1.5. Environment assumptions: Node 20 or newer (tested with 24.18.1), npm 10, Google Chrome for the browser tests, Windows for the browser-test runner (it uses `taskkill`), about 1 GB of disk. Missing or undeclared dependencies: none found (every package the code requires or imports is declared in `package.json` / `client/package.json`).

## 3. Test results (on the pushed commit, clean clone)

| Check | Result |
|---|---|
| `npm install`, `npm --prefix client install` | exit 0 |
| `npm run db:migrate` | exit 0, 10 migrations |
| `npm test` | **320 / 320 passed** |
| `npm run test:browser` | **357 / 357 checks passed**, 9 scripts |
| `npm --prefix client run build` | exit 0 |
| `npm run verify:checksums` | VERIFIED, 65 files |
| `npm run verify:package` | all 15 checks passed |
| API start and `GET /api/health` | HTTP 200 `{"status":"ok"}` |

## 4. AI prompt history status

Included: `docs/ai-prompts/prompt-history.md` (57 messages, in order, sanitised: no local user paths, e-mail addresses or key-like values) and `docs/ai-prompts/README.md` (index of the 17 specification prompts and the documents that report each result). Gap: the Scene 3 specification is not in the saved transcripts, so it is not reproduced (stated in that README).

## 5. Dataset and documentation status

`ClearKYC-Dataset/` is present (22 CSV, 22 JSON, `sql/schema.sql`, `sql/seed.sql`, answer key, reports, checksums, generation config with seed 20261022, source manifest, data dictionary): 308,971 rows, 292 MB, 65 files all verified; largest files 74.5 MB and 72.6 MB (GitHub warns above 50 MB, accepts up to 100 MB). Validation: 182 checks, 0 failed, 0 unexpected. Reproducibility: PASS. `dataset/` holds the answer key and reports of the run; `documentation/` the dataset documentation. No secrets, unmasked identifiers or local files in the package (checked). The excluded table is `SystemSetting` (application settings, not KYC data).

## 6. Known limitations

* No real authentication: the "Acting as" selector is a prototype stand-in.
* Full detection sweep takes about 78 s at 8,000 customers (non-blocking, not faster); detection jobs are kept in memory.
* README sections 2 to 8 (structure, schema, API, validation, risk, security, synthetic data) were written for Scene 1 and are not updated for later scenes; `docs/` has the current detail.
* Browser tests are Windows-oriented and timing-sensitive (one transient crash was seen once and did not repeat).
* The baseline's "missing ownership records" were not re-checked against the brief's wording.
* Dataset size (292 MB) makes the clone slower; two files exceed GitHub's 50 MB advice.
* The development database still contains leftovers of an earlier mistaken test run (a backup exists locally).

## 7. Remaining actions before submission

1. Commit and push this checklist, the new `LICENSE` and the small README / `package.json` edits (they are not yet in the repository).
3. Optionally refresh README sections 2 to 8, or add a note at their start pointing to `docs/`.
4. Confirm the exact repository address you submit (`ClearKYC`, not `ClearKYCcheck`).
5. After pushing, open the repository page in a browser and confirm the README renders (not checked here: only the git contents were verified, not GitHub's web pages).
