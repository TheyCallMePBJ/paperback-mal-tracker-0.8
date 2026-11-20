# Paperback MAL Tracker (0.8)

A working [MyAnimeList](https://myanimelist.net/) tracker extension for [Paperback](https://paperback.moe/) **0.8** (the App Store version).

Based on the MyAnimeList tracker from [Paperback-iOS/extensions](https://github.com/Paperback-iOS/extensions) (GPL-3.0), with these fixes:

- **Login no longer expires after ~16 days**: the token refresh looped forever and sent a malformed request
- **Chapter sync works**: chapters without a volume number were rejected by MAL
- **Sync never lowers your progress**, keeps "Completed" entries as they are, and marks a title completed when you read its last chapter
- Search works with `&`, `#` and `?` in the query
- The edit form shows the right re-read count and reports failed saves
- A "Last Sync" row in the tracker settings shows what the last sync did

## Install

1. Open **https://theycallmepbj.github.io/paperback-mal-tracker-0.8/** on your iPhone/iPad and tap **Add to Paperback**,
   or add `https://theycallmepbj.github.io/paperback-mal-tracker-0.8` as a repository manually in **Settings → Extensions**.
2. If you have the official MyAnimeList tracker (from "Default extensions") installed, uninstall it first: both use the same ID.
3. In **Settings → Extensions → MAL Tracker (0.8)**, tap **GET** next to MyAnimeList.
4. Open the MyAnimeList extension and tap **Login with MyAnimeList**.

## Development

```sh
npm ci
npm run lint
npm run bundle   # build into bundles/
npm run serve    # serve locally; add http://<your-lan-ip>:8080 as a repository in Paperback
```

Set `SHOW_DEBUG_TOOLS` in `src/MyAnimeList/MyAnimeList.ts` to `true` for debug rows in the tracker settings (token expiry, force refresh, last search).

Pushes to `main` are built and published to GitHub Pages by `.github/workflows/publish.yml`.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
