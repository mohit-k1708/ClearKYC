# AI prompt history and how the project was built

ClearKYC was built with an AI coding assistant (**Claude Code**, in VS Code) working from the specifications below, in phases. This folder keeps the prompts so the work is traceable.

## Files

| File | What it is |
|---|---|
| `prompt-history.md` | All 57 messages from the project owner, in order, word for word (17 specification prompts and 40 short follow-ups). |
| this `README.md` | An index of the specification prompts and the documents that report what each one produced. |

## Index of the specification prompts

| # in prompt-history.md | Sent | Prompt | Length (characters) | Where the result is documented |
|---|---|---|---|---|
| 1 | 2026-10-30 08:26 UTC | Scene 1: customer onboarding | 9,082 | README.md, docs/DOCUMENTATION.md |
| 7 | 2026-10-30 09:08 UTC | Scene 2: documents and verification | 10,973 | docs/SCENE2.md |
| 10 | 2026-10-30 10:17 UTC | Scene 4: review cases and exceptions | 11,547 | docs/SCENE4.md |
| 11 | 2026-10-30 11:01 UTC | Scene 5: audit, alerts, analytics, reporting | 12,223 | docs/SCENE5.md |
| 14 | 2026-10-30 17:28 UTC | UI polish | 5,909 | docs/UI_REDESIGN.md |
| 15 | 2026-10-30 18:06 UTC | Overview dashboard redesign | 6,572 | docs/UI_REDESIGN.md |
| 16 | 2026-10-30 18:48 UTC | Project brief (business context) and status question | 5,898 | docs/requirements-traceability.md |
| 20 | 2026-10-30 18:57 UTC | Phase 1: database documentation | 7,362 | documentation/ |
| 21 | 2026-10-30 19:07 UTC | Phase 2: synthetic data generator | 11,560 | generator/, documentation/ |
| 26 | 2026-10-30 19:57 UTC | Phase 3: edge cases, ground truth, detector | 10,886 | generator/edgeCases/, detector/, evaluation/ |
| 27 | 2026-10-30 20:28 UTC | Phase 4: validation, export, packaging | 10,704 | validation/, exporter/, reproducibility/, packaging/, ClearKYC-Dataset/ |
| 29 | 2026-10-31 06:03 UTC | Phase 5: audit and submission package | 5,347 | docs/requirements-traceability.md, docs/submission-readiness.md |
| 36 | 2026-10-31 07:19 UTC | Phase 6: remaining KYC requirements | 3,606 | docs/phase6-features.md |
| 42 | 2026-10-31 08:08 UTC | Final phase: dataset rebuild, policy review, clean-environment check | 2,835 | docs/submission-readiness.md section 10 |
| 46 | 2026-10-31 09:07 UTC | Approval policy for open exceptions | 1,559 | docs/phase6-features.md section A |
| 52 | 2026-10-31 10:43 UTC | Project brief (business context) and status question | 5,870 | docs/requirements-traceability.md |
| 57 | 2026-11-01 03:51 UTC | GitHub submission preparation | 1,690 | README.md, .gitignore, .gitattributes |

## How to read the rest of the documentation

* `README.md` (project root): set-up, commands and a tour of the application.
* `docs/requirements-traceability.md`: every requirement, where it lives and the test that checks it.
* `docs/submission-readiness.md`: test results, dataset package facts, known limitations and decisions.
* `docs/phase6-features.md`: the later features (onboarding decisions and the approval policy, name check, owner view, expiry settings, detection job) and the policy review.
* `documentation/`: the dataset documentation (data dictionary, relationships, ID rules, edge cases, source manifest).

## What this history leaves out, and why

* **Only the project owner's messages.** The assistant's replies, the code it wrote and its tool output are not included: the code and the documents above are the result.
* **Automated notices are removed** (background-task notifications shown in the chat), and a prompt sent twice (the first one, in two sessions) is shown once.
* **Sanitised:** local Windows user paths are shown as `C:\Users\<user>`, e-mail addresses (other than `example.com`) and 64-character hexadecimal values are removed. No secrets were typed in any prompt; the `.env` file is not part of the repository.
* **One gap:** the Scene 3 specification (risk assessment and beneficial ownership) was not found in the saved session transcripts, so it is not reproduced here. Its result is documented in `docs/SCENE3.md`.
* Typos and informal wording in the short messages are kept as they were sent.
