# Changelog

The section for each version becomes the release notes on GitHub — see
`.github/workflows/build.yml`, which extracts it by heading and refuses to build
a release without one.

Headings must be exactly `## vX.Y.Z` to be found.

## v0.1.10

**The legend on the map is readable, and stays out of the way.** It shipped in
v0.1.9 with near-invisible text and, on a phone, floating on top of the menu.
Now it has proper light text in the app's own font, and sits behind the menu so
raising the menu covers it.

**The map turns to face the way you're pointing.** A new button by the zoom
controls: tap it and the map rotates so your heading is up, following as you
turn, like orienting a paper map. It uses the compass only — no continuous GPS —
so it costs almost no battery, and one more tap puts north back up.

**The menu fits its content.** With the legend moved onto the map, the bottom
sheet was left with a big empty gap under it that showed the map through. It now
ends right at the last item. The menu is either up or minimized to its handle;
drag or flick between the two.

**The map controls match the app.** The zoom and locate buttons in the corner
were plain white boxes; they're now dark with green icons like everything else.

**The two "add" buttons line up.** Add terrain and Add forest roads under an
installed map pack were different shapes and colours; they're now the same
button, told apart by colour alone.

## v0.1.9

**How do I get there is easier to use.** Start and destination are now two clear
slots. Tapping either opens one picker that searches the towns in your map pack,
lists your saved pins to reuse, and lets you drop on a point on the map or your
own location — instead of the old scatter of buttons. Your pins are finally
explained where you'd look for them.

**The legend is on the map, not buried in the menu.** A small card in the
corner, which you can collapse to just its title. Its public-land and forest-road
rows still appear and disappear with those overlays.

**Recording a track tells you what's happening.** While it runs you see the
distance, point count and time so far, and that it keeps recording if you close
the panel. Finished tracks now show their length and date, with a button to
frame them on the map — so you can actually find what you recorded.

**Searching moves the menu out of the way.** Pick a place and the bottom sheet
drops down so you can see where the map jumped to, instead of it hiding behind
the menu.

**The update button is gone on iPad, as it should be.** iPhone and iPad update
through the App Store, so a check-for-updates button never belonged there. It was
showing on iPad because iPadOS pretends to be a desktop; it's now decided by what
the app actually is, not what the browser claims.

**Top buttons clear the notch.** The zoom and locate controls no longer hide
under the clock and battery on the status bar, where they couldn't be tapped.

**The Map packs list is tidier.** A pack that's downloading extras keeps its name
and controls on one line, with the downloads shown as a clean list below.

## v0.1.8

**The map shows up before you download anything.** A fresh install opened on a
grey screen: the bundled overview map of the whole country was there, and simply
never drew. Downloaded states were fine, which is what made it look like the
overview map was missing rather than unreadable.

The two are loaded by different machinery, and only one of them could serve a
map. A map pack is read in pieces — a few kilobytes at a time, wherever you have
scrolled to — and asking for a piece of the bundled copy returned the whole
11 MB file instead, which the reader refuses rather than guess at. Downloaded
packs were always read by the part that handles pieces properly; the bundled one
now goes the same way.

It never showed up in development because the development server does support
reading files in pieces. It only breaks in a real build, which is why it took
running it on a phone to find.

**The compass stops spinning the wrong way past north.** Walking through north
sent the needle almost the whole way around backwards, then unwound it again
coming back. The needle is turned by handing an angle to the browser, and 359°
to 1° is a difference of minus 358 unless you say otherwise. It now always takes
the shorter turn — two degrees, in the direction you actually turned.

**The menu scrolls at the half-open position.** Pulled halfway up, everything
below the fold was unreachable without dragging the sheet all the way open. The
sheet is full height and slides rather than resizes, so the lower half was
genuinely off the bottom of the screen, and the menu had no idea it needed to
scroll. It is now told how much of it is actually on screen.

**The sheet moves better.** A quick flick now carries it to the next position
instead of springing back — a fast throw barely moves the sheet before your
finger leaves it, so it used to look like the gesture had been ignored. And the
animation now lasts as long as the distance deserves, rather than one fixed
duration that was slow for a nudge and abrupt for a full-height throw.

**The four buttons along the top are the same size.** Night vision was a
half-inch taller than its neighbours, left over from when it was a full-width
button with a label on it. The whole row is now one size, and a touch-sized one.

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
