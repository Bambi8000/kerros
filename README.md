# Kerros

Kerros designs sliced lamps: build a form, cut it into material layers, add
assembly features, nest the parts and export laser-ready DXF files.

For a three-direction lattice, add a source shape and choose **Grid · X / Y / Z**
in the feature-tree footer. Set each family's plane count and spacing in the
inspector; select a plane to change its offset or inspect its cut parts. X/Y
uprights use cross slots and horizontal Z cells use glued tabs. Horizontal
pieces include visible assembly gaps. Read the assembly checks and dry-fit an
XYZ coupon before cutting a full lamp. See `docs/KERROS-GRID-PLAN.md` for scope.

## Browser release

GitHub Pages: **https://bambi8000.github.io/kerros-web/**.

The source repository `Bambi8000/kerros` is public. The separate deployment
repository `Bambi8000/kerros-web` contains only the compiled `dist/` contents and
`.nojekyll`, and serves its `main` branch root through GitHub Pages. The existing
site URL is unchanged. The browser build contains the application code and
static assets, not repository documentation or saved lamp projects.

All modelling and file processing run in the browser. Use **Save project** to
keep a `.kerros.json` file and **Open project…** to continue it later; refreshing
the page resets the in-memory workspace. Exports use browser downloads.
Imported meshes and SVG outlines must be located again after opening a project.

The `Verify browser release` workflow uses Node.js 24, installs the
lockfile with `npm ci`, runs the complete `npm run verify`, and saves a Pages
artifact. It runs on pushes to `main` and manual dispatches. It does not publish
to the separate repository or hold credentials for it.

To release an update, run `GITHUB_PAGES=true npm run verify` from the intended
source commit and read every named check. In a separate clone of
`Bambi8000/kerros-web`, replace the generated site with those verified `dist/`
contents, preserving `.git` and `.nojekyll`. Inspect the staged file list, then
commit and push its `main` branch using the maintainer's GitHub login. Do not
copy source files or source Git history into that deployment repository. Pages
deploys after the public branch is updated; a source push alone does not change
the live site.

To inspect the Pages build locally:

```sh
GITHUB_PAGES=true npm run verify
GITHUB_PAGES=true npm run preview -- --port 5180 --strictPort
```

Open `http://localhost:5180/kerros-web/`. Ordinary local development uses
`npm run dev` at `http://localhost:5180/`; native builds keep their root path.

## Development template notes

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
