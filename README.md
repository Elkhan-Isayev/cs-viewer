# CS Viewer — watch CS 1.6 demos in third person, in the browser

A from-scratch engine that decodes a **GoldSrc `.dem` recording** and plays it back in
the browser with WebGL: the real map, the real player models, and a camera that follows
any player **over the shoulder**.

No game install needed to *watch*, no plugins, no server. Everything runs client-side.

---

## Quick start — watch the sample match

The whole thing takes about five minutes. There is a real 72-minute match on `de_inferno`
published with this repo, so you can see it working before pointing it at your own
recordings.

### 1. Get the code

```bash
git clone https://github.com/Elkhan-Isayev/cs-viewer.git
cd cs-viewer
npm install
```

You need **Node 20 or newer** (`node -v` to check).

### 2. Get the game content

The viewer draws the actual map and the actual player models, so it needs those files.
They are Valve's, so they are **not** in this repo — you supply them from your own copy
of the game. Pick whichever applies to you:

**If you have Counter-Strike 1.6 installed** (the usual case):

```bash
npm run assets -- --game "/path/to/Half-Life"
```

Point `--game` at the folder that *contains* a `cstrike` folder. Typical locations:

| OS | Path |
|---|---|
| Windows | `C:\Program Files (x86)\Steam\steamapps\common\Half-Life` |
| macOS | `~/Library/Application Support/Steam/steamapps/common/Half-Life` |
| Linux | `~/.steam/steam/steamapps/common/Half-Life` |

**If you don't have the game installed**, the sibling project
[cs16-web](https://github.com/Elkhan-Isayev/cs16-web) builds a `valve.zip` for you
(it downloads it from Valve's own anonymous SteamCMD servers). Once it exists:

```bash
npm run assets -- --zip "/path/to/valve.zip"
```

Either way you should see:

```
Maps:
  maps/de_inferno.bsp                               6123 KiB
    0 of its textures live outside the .bsp
Per-map texture packs:
  de_inferno: fully self-contained, no texture pack needed
Player models:
  models/player/terror/terror.mdl                   2286 KiB
  ...
Wrote 44 files to public/assets/
```

That is ~27 MB, extracted once. It is deliberately frugal: most CS maps embed their own
textures in the `.bsp`, so the script checks what a map is actually missing and builds a
small per-map `.wad` for just those, instead of shipping `halflife.wad` (37 MB).

### 3. Get the sample demo

```bash
npm run sample
```

This downloads the example recording (49 MB) into `public/demos/demo.dem`.

> Prefer to grab it by hand? It is on the
> [releases page](https://github.com/Elkhan-Isayev/cs-viewer/releases) as
> `de_inferno-sample.dem` — save it as `public/demos/demo.dem`.

### 4. Start it

```bash
npm run dev
```

Open **http://localhost:5180**.

### 5. Watch

Click **“Play the bundled demo”** on the start screen. It decodes in well under a second
and starts playing from round one, following the first player in third person.

Then:

- pick anyone from the **roster on the right** to follow them instead,
- **drag** to swing the camera around them, **scroll** to pull back or move in,
- press **`2`** for that player's own eyes, **`3`** to detach and fly around with `WASD`,
- **drag the scrubber** to jump anywhere in the 72 minutes, or set the speed to `4×`
  and skim.

---

## Watching your own demos

**Record one in-game.** Open the console in CS 1.6 and type:

```
record mymatch
```

Play. Type `stop` when done. The file lands in your `cstrike/` folder as `mymatch.dem`.
HLTV/GOTV recordings work too — the sample one is exactly that.

**Watch it.** Just **drag the `.dem` file onto the page**. No copying, no config.

**If the demo is on a different map**, extract that map first, then reload and drop the
file again:

```bash
npm run assets -- --game "/path/to/Half-Life" --map de_dust2
```

The viewer reads the map name out of the demo itself, so if it is missing you get a
message telling you the exact command to run.

---

## Controls

| | |
|---|---|
| `Space` | play / pause |
| `←` `→` | ±5 seconds |
| `,` `.` | previous / next player |
| `1` `2` `3` | third person / player eyes / free camera |
| drag | orbit the camera (chase) or look around (free) |
| scroll | zoom the chase camera |
| `WASD` `Q` `E` `Shift` | fly, in free camera |

---

## What it does

| | |
|---|---|
| 🎥 **Third-person camera** | Chase camera behind any player, with mouse orbit and zoom. It traces the map's collision hulls, so it never ends up inside a wall. |
| 👁 **Two more views** | First-person (down the player's own aim) and a detached free-fly camera. |
| 🗺 **The actual map** | The `.bsp` is parsed and rendered with its own textures and **baked lightmaps**, packed into a single atlas. |
| 🧍 **The actual player models** | Half-Life studio models (`.mdl`), GPU-skinned, with the legs driven by the walk cycle and the torso by the aiming animation. |
| ⏯ **Full transport** | Play/pause, scrub, 0.25×–8× speed, jump between players. |
| 📋 **Match context** | Live roster by team, kill feed, round outcomes — all recovered from the demo's own network messages. |

A 49 MB, 72-minute HLTV recording decodes in **~400 ms** on a laptop, off the main thread
in a Web Worker: 141,797 frames, 14 players, 662 kills, 54 rounds.

---

## How it works

### The demo container

A GoldSrc demo is a 544-byte header, a directory at the end of the file, and a stream of
frames. Netmsg frames carry a **464-byte** fixed block before their payload — that block
is `float timestamp` + `ref_params_t` (232) + `usercmd_t` (52) + `movevars_t` (132) +
`vec3 view` (12) + `int viewmodel` (4) + seven netchan sequence ints (28).

Walking the container is exact: on the sample recording the parser consumes all 141,797
frames and lands precisely on the directory offset, with the type-1 frame count matching
the directory's own `70897`.

### The network stream

Inside each netmsg payload is a packed sequence of `[id][body]` server messages with no
length prefixes, so **one mis-sized body desynchronises everything after it**. All 59
message types are therefore parsed or exactly skipped, including the bit-packed ones
(`svc_packetentities`, `svc_event`, `svc_resourcelist`) that switch into bit mode
mid-message and round back up to a byte boundary at the end.

Entity state is **delta-compressed against a layout the server itself describes** at
connect time via `svc_deltadescription`. Those descriptions are themselves delta-encoded,
bootstrapped from one hardcoded table. Decoding them recovers the real field names and
bit widths — `origin[0]` at 21 bits with divisor 128, `gaitsequence`, `blending[0]`, and
so on — which is what makes player positions and animations readable at all.

### HLTV recordings

An HLTV proxy has no local client to describe, so it emits `svc_clientdata` as a **bare
marker with no body**. Parsing a normal client-data block there swallows the next message
and desyncs the packet. The viewer detects the stream kind from `svc_hltv` and frames the
message accordingly; POV demos still get the full parse.

(Consequence: HLTV demos also have an all-zero `democmdinfo`, so there is no recorded eye
position to borrow. Every camera in this viewer is reconstructed from entity deltas.)

### Rendering

- **Map** — BSP v30 faces are grouped by texture into one batch each, with texture UVs
  from `texinfo` and a second UV set into a 2048² lightmap atlas (shelf-packed, with the
  border bled outward so filtering cannot sample a neighbouring face). A small shader
  multiplies albedo by the lightmap with GoldSrc's overbright factor.
- **Players** — studio models become `THREE.SkinnedMesh`. Studio vertices live in their
  own bone's local space, so the inverse bind matrices are identities; letting three.js
  derive them from the rest pose would apply the pose twice. Bone rotations use GoldSrc's
  `AngleQuaternion`, which is three.js's **`ZYX`** Euler order.
- **Animation** — the engine transmits `frame` as 0–255 across a sequence, and splits the
  body: `gaitsequence` drives the legs, `sequence` the torso. The viewer reproduces that
  split at the `Bip01 Spine` bone. The gait *phase* is not transmitted, so it is driven
  from ground speed.
- **Camera collision** — the chase camera traces the map's clip hull (hull 3, the small
  one) with the engine's own `SV_RecursiveHullCheck`, and pulls in when blocked.

### Coordinates

GoldSrc is Z-up, three.js is Y-up: `(x, y, z) → (x, z, -y)`, a −90° rotation about X that
preserves handedness. A Quake yaw of 0 faces +X, which is the default camera's −Z rotated
by `yaw − 90°`.

---

## Verifying it without a GPU

The rendering path can be exercised entirely from the command line, which is how it was
built and how it stays honest.

```bash
npm run check                          # parse map + every model, assert the results
npm run inspect -- public/demos/demo.dem   # summarise a demo: players, kills, rounds
npm run still -- --time 2400           # software-rasterise one frame to preview.png
```

`npm run still` drives the **real** camera rig, map geometry and studio skinning, then
rasterises through a small z-buffered triangle filler and writes a PNG. It is how an
inverted camera yaw and a wrong Euler order were both caught — each looks fine to a type
checker and obviously wrong in a picture.

```bash
npm run still -- --time 2400 --mode third-person --player 7 --out shot.png
```

---

## Project layout

```
src/
  core/          BitReader (LSB-first, GoldSrc MSG_ReadBits) + ByteReader
  demo/
    container.ts header, directory, frame walking
    delta.ts     delta-description bootstrap + struct decoding
    messages.ts  all 59 svc_* messages
    replay.ts    delta stream -> per-player sample tracks, kills, rounds
    track.ts     flat typed-array sample storage
    worker.ts    decodes off the main thread
  bsp/           BSP v30 parse, miptex/WAD3, lightmap atlas, clip-hull tracing
  mdl/           studio model parse + skinning
  render/        camera rig, player actors, scene, coordinate conversion
  main.ts        UI and playback clock
scripts/
  extract-assets.mjs  pull map/models from an install or valve.zip
  lib/source.mjs      directory / ZIP64 content sources
  check-assets.mjs    headless pipeline assertions
  parse-demo.mjs      CLI demo summary
  render-preview.mjs  software-rendered still
  probe-demo.mjs      low-level parser diagnostics
```

## Troubleshooting

**“Map … is not in public/assets/maps”** — you have not extracted that map yet. Run the
`npm run assets` command from the message.

**`npm run assets` says it cannot find game content** — pass `--game` (an installed
Counter-Strike, the folder containing `cstrike`) or `--zip` (a `valve.zip`).

**The page is black after loading** — check the browser console. Most likely WebGL is
disabled or unavailable; the viewer needs it.

**Players show as coloured capsules** — the player model failed to load. Re-run
`npm run assets`; the console names the missing file.

## Limits

- **Weapons are not drawn in players' hands.** The weapon model index is decoded, but
  attaching it correctly needs the studio attachment points; a wrongly-placed gun looks
  worse than none. The current weapon shows in the kill feed instead.
- **No sounds, muzzle flashes, grenades or bomb entities.** Non-player entities are
  decoded but not sampled or drawn — `recordSample` in `src/demo/replay.ts` is the place
  to extend.
- **Skyboxes are skipped** (`sky*` faces are not drawn), so outdoor areas show the
  background colour.
- **Only demo protocol 5 / network protocol 48** — CS 1.6 and Half-Life era GoldSrc.
  CS:GO and CS2 demos are a completely different (protobuf) format.
- Round markers come from `TextMsg` tokens, so they reflect what the server broadcast;
  scores are not reconstructed.

## Credits

- **Counter-Strike** and **Half-Life** — game, maps, models and all related assets are
  © **Valve Corporation**. This project is not affiliated with or endorsed by Valve, and
  ships no Valve content; `npm run assets` reads from a copy you already have.
- The demo/network format work was cross-checked against
  **[hlviewer.js](https://github.com/skyrim/hlviewer.js)** by Stefan Stojkovic (MIT),
  which was invaluable for confirming the entity-delta bit layout.
- Sibling project **[cs16-web](https://github.com/Elkhan-Isayev/cs16-web)** runs the same
  game playably in a browser via Xash3D FWGS, and can build the `valve.zip` this reads.

## Disclaimer

Provided **“as is”, without warranty of any kind**. An unofficial, hobby/educational tool
for reviewing recordings. You are responsible for ensuring your use complies with Valve's
EULA and any applicable law.

MIT licensed — see [LICENSE](LICENSE).
