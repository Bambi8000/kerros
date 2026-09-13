# Kerros

Kerros designs sliced lamps: build a form, cut it into material layers, add
assembly features, nest the parts and export laser-ready DXF files.

## Browser release

GitHub Pages target: **https://bambi8000.github.io/kerros/**.

The `Publish GitHub Pages` workflow verifies and builds `main`, then publishes
only `dist/`. Enable **Settings → Pages → Source → GitHub Actions** in the
repository before the first deployment. The site is public; repository
visibility is a separate setting. The browser build contains the application
code and static assets, not repository documentation or saved lamp projects.

All modelling and file processing run in the browser. Use **Save project** to
keep a `.kerros.json` file and **Open project…** to continue it later; refreshing
the page resets the in-memory workspace. Exports use browser downloads.
Imported meshes and SVG outlines must be located again after opening a project.

The workflow uses Node.js 24, installs the lockfile with `npm ci`, and runs the
complete `npm run verify` before uploading anything. A failed check or build
prevents deployment. Manual runs publish only from `main`.

To inspect the Pages build locally:

```sh
GITHUB_PAGES=true npm run verify
GITHUB_PAGES=true npm run preview -- --port 5180 --strictPort
```

Open `http://localhost:5180/kerros/`. Ordinary local development uses
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
