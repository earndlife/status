# Earnd status page

A public page that says whether earnd.life and the waitlist are up, checked every 30 minutes
**from GitHub's servers, not Earnd's own box**, with 90 days of history per component and every
incident written for readers.

Everything in this folder is public the moment it is mirrored, and it is live before the site
says everything it will. So it names only what earnd.life already shows: a component joins the
list when the site has said what it is, not before.

Why off the box: the site runs on one server. A status page on that server is down exactly when
it is needed. GitHub Pages is free, served from GitHub's CDN, and the checks run in GitHub
Actions, which are free for a public repository. The organisation is on GitHub's free plan, where
Pages exists only for public repositories, so this folder is **mirrored into a separate public
repository**, `earndlife/status`, by `publish.sh`. Nothing in it is private: public addresses,
the checks' results, incident text meant for readers.

## What is here

| Path | What |
| --- | --- |
| `index.html` | The page. Vanilla HTML, CSS and JavaScript; reads the three JSON files beside it |
| `components.json` | What is checked: name, address, expected statuses, time-out, the "degraded" latency, enabled |
| `scripts/lib.mjs` | The rules: samples to a state, history, uptime, incident files. `lib.test.ts` pins them (the website's `pnpm test`) |
| `scripts/probe.mjs` | One run: asks every enabled component twice, writes `site/status.json`, folds the day into the history |
| `scripts/build.mjs` | Assembles `site/`: the page, assets, `status.json`, `history.json`, `incidents.json` from `incidents/*.md` |
| `incidents/` | One markdown file per incident, front matter plus plain text. `_template.md` is the shape; underscored files are not published |
| `.github/workflows/status.yml` | Every 30 minutes in the public repository: probe, keep the history on the `data` branch, build, deploy to Pages |
| `publish.sh` | Mirrors this folder into `earndlife/status`, enables Pages from Actions, runs the first check |
| `assets/earnd-mark-on-dark.svg` | The owl mark, a byte copy of the logo folder's (content/brand-files.test.ts holds it to its source) |

## The rules

- **Up**: an expected status came back within the degraded latency on the first attempt.
- **Degraded**: it came back, but slower than `degradedMs`, or only on the second attempt.
- **Down**: no expected status came back in two attempts (a time-out, a refused connection, a
  5xx, a DNS miss).
- **Disabled**: listed for later, shown as "not live yet", never counted.
- **Uptime** over 90 days is the share of checks that were not down; degraded counts as up,
  because slow is not out.
- Days are **UTC** in the history; the page shows times in IST.

## Owner steps, once

1. `bash status/publish.sh --create` from the website checkout. It creates the public repository
   under the organisation with the token git already holds, pushes this folder as its `main`,
   enables Pages from Actions, and dispatches the first run. If the Pages call is refused, enable
   it by hand: repository **Settings → Pages → Source: GitHub Actions**.
2. Open `https://earndlife.github.io/status/` a few minutes later.
3. Optional, `status.earnd.life`: a `CNAME` record at Spaceship pointing at `earndlife.github.io`,
   then **Settings → Pages → Custom domain**, and add the domain to the footer link in
   `index.html` if wanted.
4. The waitlist's address in `components.json` is the function's public URL (the same one the
   site's bundle carries).

Whenever this folder changes here, run `bash status/publish.sh` again (no `--create`); the push
redeploys the page.

## Writing an incident

Copy `incidents/_template.md` to `incidents/YYYY-MM-DD-short-name.md` **in the public repository**
(the GitHub web editor works from a phone), fill the front matter, write what a reader would want
to know, commit to `main`. The next run, within 30 minutes, publishes it; `workflow_dispatch` runs
it now. Update by appending lines and moving `status` forward: investigating, identified,
monitoring, resolved (with a `resolved:` time). Who writes it and when is
`docs/incidents/INCIDENT_PROCESS.md` in the website repository.

## Running it here

```bash
node status/scripts/probe.mjs --components status/components.json --history /tmp/earnd-status-history.json --out /tmp/earnd-status-site
node status/scripts/build.mjs --root status --history /tmp/earnd-status-history.json --out /tmp/earnd-status-site
npx serve /tmp/earnd-status-site      # or open the folder with any static server
```

`site/` and `data/` are build outputs and are not committed here or mirrored.
