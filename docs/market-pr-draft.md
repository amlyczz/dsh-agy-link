# Market PR draft (awesome-dsh-plugin)

Target: awesome-dsh-plugin repository, `data/plugins/<owner>__dsh-agy-link.yml`.
Replace `<owner>` with the GitHub owner chosen at publish time. File the PR
after: npm published, GitHub repo created, >= 10 commits, >= 1 day old,
topic `dsh-plugin` set.

---

```yaml
name: dsh-agy-link
description: Google Antigravity (agy CLI) models for DSH — streaming chat, thinking, tool activity, usage, in-GUI Google OAuth login.
npm: dsh-agy-link
repository: https://github.com/<owner>/dsh-agy-link
category: model
tags:
  - antigravity
  - gemini
  - agy
  - model-provider
```

PR body draft:

```markdown
## Add dsh-agy-link (model)

- **npm**: https://www.npmjs.com/package/dsh-agy-link
- **repo**: https://github.com/<owner>/dsh-agy-link
- **category**: model

Brings Google Antigravity models (Gemini / Claude / GPT-OSS slugs exposed by
the agy CLI) into DSH as a first-class provider route: full streaming with
thinking and tool-activity annotation, token usage, session-conversation
binding, model discovery with effort folding, in-GUI Google OAuth login with
QR, an agy_ask delegation tool, and a /agy command family with a redacted
doctor export. Dormant-safe when agy is missing or signed out.

Checklist: dsh bundle manifest present; >= 10 commits; repo age >= 1 day;
`dsh-plugin` topic set on the repository.
```
