# Price Intelligence OS — read-only snapshot (published site)

This branch holds the **built** static site that GitHub Pages serves. It is generated, not written by hand:

```bash
npm run build:snapshot
```

on the code branch produces these files (`dist/pages`). The snapshot shows the app with the database as it stood
when it was taken; it is read-only and runs entirely in the visitor's browser. See "A read-only snapshot you can
open from a link" in the project README for what it contains and what was removed before publishing.

To take the page down: switch Pages off under *Settings → Pages*, then delete this branch.
