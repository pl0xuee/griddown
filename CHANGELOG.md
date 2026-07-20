# Changelog

The section for each version becomes the release notes on GitHub — see
`.github/workflows/build.yml`, which extracts it by heading and refuses to build
a release without one.

Headings must be exactly `## vX.Y.Z` to be found.

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
requests run at once had barely helped, and the reason was not the server: the
HTTP client negotiates HTTP/2, which multiplexes every request onto a single
connection, so all the workers queued behind one window. Given real connections
instead, a Rhode Island download went from 21.4 to 14.0 seconds. Sixteen at once
is where it stops helping — thirty-two is slower — and the benchmark that
established that ships as a test.

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
