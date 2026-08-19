# Document template research sources

Koinote's built-in document templates were researched on GitHub on 2026-08-19.
Star counts below are a point-in-time signal, not an endorsement or a bundled
dependency.

| Repository | Stars | License | What informed Koinote |
| --- | ---: | --- | --- |
| [github/docs](https://github.com/github/docs) | 20,693 | CC BY 4.0 | Clear task-oriented documentation and progressive structure |
| [othneildrew/Best-README-Template](https://github.com/othneildrew/Best-README-Template) | 16,302 | Unlicense | README coverage: value, setup, usage, roadmap, contribution, license |
| [noraj/OSCP-Exam-Report-Template-Markdown](https://github.com/noraj/OSCP-Exam-Report-Template-Markdown) | 4,182 | MIT | Evidence-led technical report organization and repeatable sections |
| [microsoft/code-with-engineering-playbook](https://github.com/microsoft/code-with-engineering-playbook) | 2,712 | CC BY 4.0 | Product and engineering planning, quality, rollout, and operational checks |
| [adr/madr](https://github.com/adr/madr) | 2,408 | MIT / CC0 1.0 | Decision context, drivers, options, consequences, and validation |
| [PurpleBooth/a-good-readme-template](https://github.com/PurpleBooth/a-good-readme-template) | 490 | CC0 1.0 | Concise setup, testing, deployment, and contribution prompts |
| [jaantollander/Markdown-Templates](https://github.com/jaantollander/Markdown-Templates) | 230 | MIT | Scientific and technical Markdown document conventions |

The final Koinote templates are original, localized outlines written for the
product. No upstream template is copied verbatim. This avoids pulling third-party
branding, assumptions, or license text into every document a user creates while
still preserving the strongest structural ideas found during research.

The in-product catalog currently contains 15 templates:

- Free: meeting notes, daily note, weekly plan and review, todo list, and a
  flexible table.
- Lifetime: daily work report, weekly work report, OKR plan and review, KPI
  tracker, article brief, project README, product requirements, research paper
  notes, decision record, and technical design.

The catalog is bundled with the SPA and desktop client so free templates remain
available offline. Lifetime access is checked against the current signed-in
account; fully local mode deliberately exposes only the free catalog because it
has no remote membership identity.
