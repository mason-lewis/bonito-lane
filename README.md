# Bonito Lane

A browser-based coastal residence simulation. Walk through the house and
neighborhood, operate doors and the elevator, and explore with Crew.
Neighborhood appearance and final house placement remain interpretations.

## GitHub Pages

In Settings → Pages, set the publishing source to **GitHub Actions**.
Pushes to `main` build and deploy at `/bonito-lane/`.

```sh
npm ci
npm run build:pages
npm run preview -- --base /bonito-lane/
```

Use the preview URL ending in `/bonito-lane/`. A public site exposes the
simulation geometry and runtime files to visitors.

## Render alternative

Create a Static Site connected to this repository, with root directory blank,
build command `npm ci && npm run build`, and publish directory `dist`.
Set `SKIP_INSTALL_DEPS=true` and `NODE_VERSION=22`. The included `render.yaml`
sets the same options for a Render Blueprint. No runtime secrets are required.

## Publication boundary

This repository contains only the simulation source, required runtime assets,
and deployment configuration. It excludes architectural drawings, reference
photographs, Blender authoring sources, source geographic datasets, HTML
reports, review pages, screenshots, local documentation, and credentials.
Exact address/GPS metadata and documentary model extras were removed from the
deployment copy. The original authoring project is kept separately.

`.gitignore` ignores everything except explicitly approved files.
`deployment-files.json` is the matching build allowlist. Both source and build
output are checked before publication. Do not force-add files or expand the
allowlist without reviewing their contents. Source maps are disabled.

To update models, regenerate this deployment folder with the original local
project's `tools/prepare_deployment.py`; do not copy the full authoring project.
Review the resulting Git diff, run the build, then commit and push.

## Attribution

Neighborhood road and building geometry is derived from New Hanover County,
North Carolina GIS. Neighbor heights, roofs, facades, planting, terrain, and
final house siting are interpretations. Geographic attribution does not assert
an open data license. The daylight HDR is Kloofendal 48d Partly Cloudy (Pure Sky)
by Greg Zaal and Jarod Guest, provided by Poly Haven under CC0.
Runtime dependencies retain their own licenses.
