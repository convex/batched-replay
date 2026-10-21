// The racer's track, shared by the game (Racer.tsx) and the 3D view
// (RacerScene.tsx). Everything is in the original 1600x900 world, in px.
export const WIDTH = 1600;
export const HEIGHT = 900;

// A stadium: two straights joined by half circles. The middle of the track
// is every point RADIUS away from the line from (LEFT, MID_Y) to (RIGHT, MID_Y).
export const LEFT = 480;
export const RIGHT = 1120;
export const MID_Y = 450;
export const RADIUS = 300;
export const TRACK_WIDTH = 140;
export const TOP_Y = MID_Y - RADIUS;
// The start/finish line crosses the top straight. You drive clockwise.
export const LINE_X = 800;

// The middle of the track, `distance` px on from the start/finish line.
export const STRAIGHT = RIGHT - LEFT;
export const BEND = Math.PI * RADIUS;
export const LAP_LENGTH = 2 * STRAIGHT + 2 * BEND;
export function trackPoint(distance: number) {
  let d = (distance + LINE_X - LEFT) % LAP_LENGTH; // from the top left
  if (d < STRAIGHT) return { x: LEFT + d, y: TOP_Y, angle: 0 };
  d -= STRAIGHT;
  if (d < BEND) {
    const a = -Math.PI / 2 + d / RADIUS;
    const x = RIGHT + RADIUS * Math.cos(a);
    return { x, y: MID_Y + RADIUS * Math.sin(a), angle: a + Math.PI / 2 };
  }
  d -= BEND;
  if (d < STRAIGHT) return { x: RIGHT - d, y: MID_Y + RADIUS, angle: Math.PI };
  d -= STRAIGHT;
  const a = Math.PI / 2 + d / RADIUS;
  const x = LEFT + RADIUS * Math.cos(a);
  return { x, y: MID_Y + RADIUS * Math.sin(a), angle: a + Math.PI / 2 };
}
