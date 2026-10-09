# public/ui

`public/ui/gothic/` holds the Gothic II UI assets the client uses as `/ui/gothic/...`: menu frames and backdrop, logos,
painted maps and their thumbnails, bitmap font atlases and the web fonts traced from them, the site icons and the
link-preview image. They are extracted from the game, which belongs to THQ Nordic / Piranha Bytes, so the folder is
not in the repository (it is git-ignored). Build it from your own copy of Gothic II:

```sh
GOTHIC2_DIR="/path/to/Gothic II" npm run assets
```

`npm run build` copies this folder into `dist/ui` and stops with a pointer to `npm run assets` while it is missing.
See the README section "Reproduce from your own copy of the game" and `tools/build_assets.sh`.
