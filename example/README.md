# Example app

Demos of `@convex-dev/batched-replay`, switched by `#cursors`, `#drawing`,
`#racer` and `#marble` in the URL (the menu at the top right), plus `#tilt`, the
phone half of the marble, which is opened from its QR code and has no menu. Each
is the same component with its own `exposeApi` and `value`: the only real
difference is what it sends.

- **Cursors** (`src/Cursors.tsx`, `convex/cursors.ts`): open it in two tabs and
  move the mouse. A slider sets the sender's `flushMs`.
- **Drawing** (`src/Drawing.tsx`, `convex/drawing.ts`): a shared board that
  replays everything drawn so far, then everyone else's strokes live, with a
  timelapse. `onAppend` copies finished strokes into the app's own `strokes`
  table, shown in the Strokes sidebar, which survives "Clear board".
- **Ghost racer** (`src/Racer.tsx`, `convex/racer.ts`, drawn in 3D by
  `src/RacerScene.tsx`): a little race track. Arrow keys or WASD drive; everyone
  else's car plays back a little behind. Each lap is its own stream,
  `<player>:<lap start time>`, and the sample that crosses the line carries the
  lap time, which `onAppend` keeps in the `laps` table. Your best lap's stream
  is replayed with `useHistory` as a faded ghost, from the moment you cross the
  line.
- **Tilt marble** (`src/Marble.tsx` on a laptop, `src/Tilt.tsx` on a phone,
  `convex/tilt.ts`): the phone sends its tilt, and the laptop plays it back and
  rolls a marble round a maze with it. The marble page shows "Control this from
  your phone" with a QR code of its own URL ending `#tilt`, so a phone always
  pairs with the deployment you're looking at; once a phone is sending, it
  shrinks to "Phone connected". However the phone is held when the sensor starts
  counts as level (people hold a phone tilted towards them), and "Set level"
  makes the current tilt level again. The phone switches between 250 ms and 50
  ms flushes, to feel the difference while steering.

## Hosted demo

The same app runs as a public demo at
[https://helpful-wren-102.ap-southeast-2.convex.site](https://helpful-wren-102.ap-southeast-2.convex.site),
served from its own Convex deployment by the
[static hosting component](https://www.npmjs.com/package/@convex-dev/static-hosting)
(mounted in `convex/convex.config.ts`). It's HTTPS, so the phone half of the
tilt marble works straight away.

To deploy it, from the root of the repo:

```sh
npm run deploy:demo
```

That builds the component (`dist`, which the example imports), deploys the
backend with `npx convex deploy -y`, then
`npx @convex-dev/static-hosting deploy --skip-convex` builds the page with
`npm run build:demo` and the production `VITE_CONVEX_URL`, and uploads
`example/dist`. The demo lives in the `batched-replay-demo` project in the
Convex DevX team (`cvx-devx`), on the `sydney` production deployment (region
`aws-ap-southeast-2`). Deploy with `CONVEX_DEPLOY_KEY` set to a deploy key for
that deployment, so both `npx convex deploy` and the upload go to Sydney:

```sh
npx convex deployment token create demo-deploy --deployment sydney --save-env ~/.config/batched-replay-demo/deploy.env
CONVEX_DEPLOY_KEY="$(sed -n 's/^CONVEX_DEPLOY_KEY=//p' ~/.config/batched-replay-demo/deploy.env)" npm run deploy:demo
```

The key contains a `|`, so read it like this rather than sourcing the file.

Anyone can open it and there's no sign-in, so it has some limits:

- **Rate limits** (`convex/limits.ts`, with `@convex-dev/rate-limiter`): each
  stream key gets 100 appends a second for cursors (the slider goes down to a 16
  ms flush), 40 for tilt (50 ms at its fastest) and 10 for drawing and the racer
  (250 ms). A rate limited append throws, and the sender retries a little later.
  A batch can carry at most 500 samples.
- **Drawing**: a cron (`convex/crons.ts`) clears the board once nobody has drawn
  on it for 10 minutes, the same way "Clear board" does. The Strokes gallery
  keeps the current board's strokes and the newest 100 before it.
- **Racer**: a lap's batches are kept for a day. A player keeps their newest 20
  laps (and always their best), and laps are deleted after 20 hours, before
  their history expires, so a ghost never points at a lap that's gone.
- **Cursors and tilt** keep their batches for 10 minutes.
- **Housekeeping**: pens left on earlier boards and rate limit documents more
  than an hour old are deleted by the crons too.

## Recording the racer

`#racer?autodrive=1` drives itself round the middle of the track, one lap every
7 s, placed by the wall clock rather than by physics. So two windows on the same
computer go round in step without talking to each other, and every lap crosses
the line at the same moment. Options:

- `lane=-1` or `lane=1`: drive 35 px outside or inside the middle, so two cars
  don't sit on top of each other.
- `offset=60`: be 60 ms ahead of the clock (negative for behind).
- `lapMs=7500`: take 7.5 s a lap instead of 7.
- `camera=tv`, `camera=chase` or `camera=finish`: where the 3D view looks from
  (the TV, Chase and Finish buttons in the HUD switch it too). TV, the default,
  is a high broadcast view of the whole track; Chase follows behind your car;
  Finish is low and side-on at the line, like a photo-finish camera. Your car
  has a yellow arrow over it.
- `ghost=0`: hide your ghost. With autodrive every lap is the same, so the ghost
  sits right on your car and makes it glow.
- `color=%233b82f6`: paint your car in any CSS colour (`%23` is `#`). It's sent
  with your samples, so other windows draw your car in it too.

For the photo finish, open two windows side by side, one car blue and one
orange, with no ghosts:

```text
http://localhost:5173/#racer?autodrive=1&lane=-1&offset=40&camera=finish&ghost=0&color=%233b82f6
http://localhost:5173/#racer?autodrive=1&lane=1&camera=finish&ghost=0&color=%23f97316
```

Both cross the line 40 ms apart, but each draws its own car with no delay and
the other about 330 ms behind, so each window shows its own car in front. Use a
fresh window (or tab) for each car: the player id is kept in `sessionStorage`.
After the first timed lap, the ghost replays your best lap. With every lap the
same length it runs right under your own car, so to show it off, do a lap or two
at the default 7 s, then reload the same tab with `&lapMs=7600`: the ghost of
the 7 s lap pulls ahead as you go round. The ghost is a glowing glass copy of
your car with a trail behind it, easiest to see with `camera=chase` or the
default `camera=tv`.

## Using a real phone for the tilt demo

Browsers only give a page the tilt sensor over HTTPS (iOS also asks for
permission, from the "Use the tilt sensor" button). An HTTPS page can only talk
to Convex over `wss://`, so a local `ws://` backend from
`npx convex dev --local` won't work from the phone. What does work:

- The [hosted demo](#hosted-demo), which is already HTTPS.
- A Convex cloud dev deployment (its URL is already `https://`/`wss://`), plus
  the Vite dev server behind an HTTPS tunnel (Cloudflare Tunnel, ngrok,
  Tailscale Funnel) that the phone opens.
- Or a cloud dev deployment plus Vite's own HTTPS dev server (`server.https`
  with a certificate the phone trusts, for example from `mkcert`, or
  `@vitejs/plugin-basic-ssl` and accepting the warning), opened on the laptop's
  LAN address with `vite --host`.

Then open `#marble` on the laptop and scan its QR code with the phone (the URL,
ending `#tilt`, is under it too, to type in). Tap "Use the tilt sensor" holding
the phone however is comfortable: that's level, and "Set level" re-zeroes it.
Without a sensor (on a laptop, or under Playwright), the tilt page says it's the
phone half, and takes arrow keys or dragging on the round pad instead.

Run it from the root of the repo:

```sh
npm run dev
npm run dev:frontend
```

The component also needs an app that uses it to run codegen, which is the other
reason this is here.
