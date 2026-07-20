# Changelog

The section for each version becomes the release notes on GitHub — see
`.github/workflows/build.yml`, which extracts it by heading and refuses to build
a release without one.

Headings must be exactly `## vX.Y.Z` to be found.

## v0.1.8

**Renaming a pin and importing a pack work on iPhone.** Both asked a question
through the browser's own text prompt, which iOS does not implement — it answered
"cancelled" instantly, every time, so renaming a waypoint quietly did nothing and
importing a pack from a file whose name we could not read just stopped. Neither
reported an error, because as far as the app could tell you had pressed cancel.

**Questions are now asked by the app itself.** v0.1.7 fixed confirmations that
were being skipped rather than shown; this replaces the last of the borrowed
machinery. Every yes/no and every "type a name" is now drawn by GridDown, looks
the same on a phone and a desktop, takes Enter and Escape, hands focus back where
it came from — and, unlike anything routed through the platform, is covered by
tests. The bug in v0.1.7 was invisible precisely because that path could not be
tested.

## v0.1.7

**Downloading a state is one file now.** It never was a file: the app rebuilt
each state on your phone out of a shared archive of the whole planet. Oregon
took 65,160 separate requests averaging 8 KB each, and most of the wait was
round trips, not data. All 52 states are now cut ahead of time and published as
finished packs, so downloading one is a single request. Oregon takes seconds.

**Downloads survive a dropped connection.** A half-gigabyte file over a phone
connection will be interrupted, so a download now resumes from the bytes already
on disk instead of starting over, and a retry re-sends only what was lost. Every
finished pack is checked against a fingerprint published alongside it before it
counts as installed; one that arrives damaged is discarded rather than kept.

**A fresh install opens on a real map.** v0.1.6 drew the states as outlines,
which was better than an empty screen but still not a map. The app now ships a
coarse map of the whole country — 11 MB — so a new install opens on real coast,
rivers and roads, and you can find the state you want before downloading it.

**Alaska builds at all.** It could not be prepared: it is fourteen times the
work of California, not through any fault of its own but because it genuinely is
that large that far north. It is now cut one zoom level shallower, which is a
quarter of the work. The map still zooms in; detail simply stops sharpening a
step earlier — a fair trade for Alaska existing.

**Every yes/no prompt was skipped, not shown.** Deleting a map pack, restoring a
backup of your pins and tracks, and installing an update all went ahead without
asking. The confirmation was being requested in a way that could never return an
answer, and the check treated "no answer yet" as yes — so the action always
proceeded and an error was logged after the fact. Plain messages were unaffected,
which is why nothing looked wrong. The restore is the one that mattered: it is
the guard standing in front of replacing every pin and track you have, and it
had stopped standing there.

**Interrupted downloads no longer leave hundreds of megabytes behind.** A
download that died partway left scrap that nothing would ever read or clean up —
323 MB of it on the machine this was found on. It is now cleared before a
download starts, so the space comes back before it is needed rather than after.

**The app icon has rounded corners** on Windows, Linux and macOS. iOS and
Android are left square on purpose: both round icons themselves, and a
pre-rounded image shows its own dark corners inside the system's mask.

_Also: fixed a packaged build made on a developer's machine swallowing their
local map and terrain data — 953 MB of app where 13 MB was correct — and the
app refusing to start in development at all since the pack builder was added._

## v0.1.6

**The app shows a map on first launch.** A new install has no map data — a
single state is hundreds of megabytes, so you choose what to download — and
until now that meant opening to an empty screen with a notice over it. It now
draws the states as outlines, so there is something to look at and something to
aim at. It costs no extra download: the outlines come from the state list the
app already ships.

**The bottom sheet moves properly.** It was animating its own height, which
relaid out the entire menu on every frame of a drag and felt rough. It now slides
instead, which never touches layout. The part you can grab went from a 4-pixel
line to a 30-pixel strip, plus the title bar.

**Menu items are tiles instead of a long list.** Two columns rather than one,
which roughly halves the length of the menu, with tap targets at Apple's 44-pixel
minimum.

**No hamburger button on phones.** The sheet is the control — drag it down to get
it out of the way, up to use it. The button did the same job as the gesture and
left a pill in the corner that collided with the map controls.

**Downloads are faster again, and this time it was measured.** Raising how many
requests run at once had barely helped. Giving each worker its own connection
took a Rhode Island download from 21.4 to 14.0 seconds. Sixteen at once is where
it stops helping — thirty-two is slower — and the benchmark that established
that ships as a test.

> **Correction (v0.1.7).** This entry originally blamed HTTP/2 multiplexing.
> That was wrong: HTTP/2 is not in this build at all, which `cargo tree` shows
> plainly and which nobody checked before publishing. The real cause was the
> blocking HTTP client — every client owns one background thread, so sixteen
> workers sharing one client funnelled sixteen "parallel" downloads through it.
> The fix and the numbers above are unchanged; only the explanation was wrong.
> See v0.1.7 for what the measurements eventually turned up.

## v0.1.5

**The menu now fits a phone.** It used to be a fixed panel pinned to the
top-left, which on a phone covered most of the screen and sat on top of the
scale bar and coordinates. On narrow screens it is now a sheet along the bottom:
drag it between a peek, half screen and nearly full, with the map visible above
it throughout. The ☰ button still means what it always did — the menu disappears
completely and leaves the small corner pill.

iPad and desktop are unchanged. The narrowest iPad is 744 px and the breakpoint
is 700, so only Split View ever sees the sheet.

**State downloads are much faster.** Every request used to wait for the one
before it, which a wired desktop hid and a phone did not: a phone's round trip is
several times longer, and that delay multiplied straight through. Two phases were
sequential — working out which tiles to fetch, which meant hundreds of directory
reads one at a time, and the download itself. Both now run six requests deep.

Fixed along the way:

- The rule meant to lift the scale bar clear of the sheet never applied, because
  MapLibre ships the same selector at the same specificity and loads later
- The sheet's heights used `dvh`, which needs Safari 15.4, in a build targeting
  iOS 14 — the sheet would have had no valid height at all there
- A second finger on the drag handle hijacked the drag and stranded the first

## v0.1.4

**The iOS app became real.** It compiles on every push against a macOS runner —
no Mac required — and a signed build now goes to TestFlight on demand, so it can
be installed on a real iPhone.

- The app ships as **GridDown**. The project was still named `tauri-app`
  underneath, and iOS takes the home-screen name from exactly there
- The `go-pmtiles` sidecar is gone. Extracting a state happens in-process, which
  iOS requires — it forbids spawning subprocesses — and takes 57 MB off every
  desktop build
- Build checks that fail loudly rather than quietly: the permission usage strings
  must survive into the built app, and the app icon must be ours and not Tauri's

## v0.1.3

- The compass reads true north, correcting for magnetic declination with NOAA's
  World Magnetic Model, offline
- US Forest Service roads and trails, colour-coded by what you may legally drive
  and marked where access is seasonal
- Teammate positions over Meshtastic LoRa radio, with no cell towers involved
- Printed map sheets carry a real MGRS grid, labelled in both margins
- The menu folded down from five sections to four, and Find now accepts a place
  name, a grid reference, coordinates, or one of your own saved pins
