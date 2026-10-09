import { describe, expect, it } from 'vitest';
import { gamePitchToViewerPitch, gameYawToViewerYaw, viewerYawToGameYaw } from '../src/ui/panorama';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 10);

/**
 * Convention verified in the browser with the Khorinis harbour sample (docs/VIEWER_NOTES.md):
 * viewer yaw 0 = front face = north, viewer yaw +π/2 = right face = east, i.e. the viewer's yaw
 * grows clockwise from above, same as the manifest's degrees clockwise from north.
 */
describe('gameYawToViewerYaw', () => {
  it('north (0°) is the front-face centre, viewer yaw 0', () => close(gameYawToViewerYaw(0), 0));
  it('east (90°) is the right face, viewer yaw +π/2', () => close(gameYawToViewerYaw(90), Math.PI / 2));
  it('south (180°) is the back face, viewer yaw π', () => close(gameYawToViewerYaw(180), Math.PI));
  it('west (270°) is the left face, viewer yaw 3π/2', () => close(gameYawToViewerYaw(270), (3 * Math.PI) / 2));
  it('normalises to [0, 2π)', () => {
    close(gameYawToViewerYaw(360), 0);
    close(gameYawToViewerYaw(-90), (3 * Math.PI) / 2);
    close(gameYawToViewerYaw(450), Math.PI / 2);
  });
  it('links in opposite directions are π apart', () => {
    // Node 132 → 0 (251.68°) and node 0 → 132 (71.68°) from the sample manifest.
    const diff = Math.abs(gameYawToViewerYaw(251.68) - gameYawToViewerYaw(71.68));
    close(diff, Math.PI);
  });
  it('round-trips through viewerYawToGameYaw', () => {
    for (const deg of [0, 12.5, 90, 179.9, 251.68, 359]) close(viewerYawToGameYaw(gameYawToViewerYaw(deg)), deg);
  });
});

describe('gamePitchToViewerPitch', () => {
  it('converts degrees above the horizon to radians, sign preserved', () => {
    close(gamePitchToViewerPitch(0), 0);
    close(gamePitchToViewerPitch(45), Math.PI / 4);
    close(gamePitchToViewerPitch(-1.07), (-1.07 * Math.PI) / 180);
  });
});
