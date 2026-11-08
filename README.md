# GoodTimes

A full-screen photo and video slideshow for a folder of files, on a local disk or a network share. It sorts everything by date and location, groups the files into events, and shows them in changing layouts. You configure it in `settings.yaml`; there is no settings UI.

## Run

```
npm install
npm start                          # uses ./settings.yaml
npm start -- D:\path\to\my.yaml    # or a specific settings file (.yaml or .json)
npm run scan                       # headless: list the events it finds, no window
```

Settings come from two files in the same folder:

- **`settings.yaml`** holds the shared options (checked in). Every option is documented in that file.
- **`settings.local.yaml`** holds this computer's options: `sources`, `recursive`, `display.screen` and `display.fullscreen`. It isn't checked in. GoodTimes won't start without it, and the error message shows a sample to copy. Anything in it overrides `settings.yaml`.

## Keys

| Key | Action |
|---|---|
| `Esc` / `Q` | Quit |
| `Space` | Pause / resume |
| `→` / `N` | Change something now |
| `Enter` / `L` | Switch to a new layout now |
| `↓` / `E` | Skip to the next event |

## How it works

- **Dates** come from EXIF `DateTimeOriginal` first. If that's missing, the slideshow uses a date in the filename (`IMG_20230514_…`, `PXL_…`, `2023-05-14 …`), then the file's own date. For MP4/MOV videos it reads the camera's metadata, including phone video location.
- **Albums:** each folder directly inside a source folder is an album, such as a trip or holiday. Its photos play together as one block, placed in the timeline by when the trip started, and are never mixed with other photos. Folders nested deeper count as part of their album. Captions show the album name. In `shuffle-events` order, an album is shown a few days at a time (`grouping.albumVisit`) and continues where it left off on later visits.
- **Events:** within an album, and among the loose photos in the source folder itself, files sorted by date are split into a new event whenever there's a gap longer than `maxGapHours` or the GPS position moves more than `maxDistanceKm`. This usually gives one event per day or outing. One layout only shows photos from the same event.
- **Layouts** are picked at random by weight, with a preference for layouts whose slot shapes suit the next photos. For example, a run of portrait photos makes the three-column layout more likely. Each photo goes into the slot it fits best. Photos and videos are never cropped or zoomed; they are always shown whole.
- **Updates:** every `interval` seconds the slideshow changes all, some or one of the photos on screen (`updateMode` weights). After `layoutDuration` it switches to a new layout. The switch either moves the whole screen at once or builds the new layout up photo by photo.
- **Videos** play muted by default. A video isn't replaced until it finishes, or until `maxSeconds` has passed.
- **Caching:** metadata is cached in `.goodtimes-cache.json`, so restarting on a large network share is fast. The folders are rescanned every `rescanMinutes`.

## Notes

- HEIC/HEIF photos aren't supported by Chromium. Export them as JPEG, or set your phone to save "Most Compatible".
- AVI/WMV and some MKV codecs won't play. MP4 (H.264/H.265), MOV, WebM and AV1 do.
- Place names in captions need `geocoding.enabled: true`. This looks up one approximate coordinate per event on OpenStreetMap. Without it, captions show the date only.
- Dev helpers: `--windowed`, `--capture=<folder>` (saves a screenshot every 2s), `--quit-after=<seconds>`.
