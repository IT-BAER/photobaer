// File > File Info > Camera Data: the EXIF values of the opened file as labelled, formatted rows.
import { t } from '@lingui/core/macro';
import { formatNumber } from '../i18n/numbers.ts';

export interface CameraRow { key: string; label: string; value: string }

// "n/d" or a plain number; NaN when damaged.
const num = (v: string) => { const [n, d] = v.split('/').map(Number); return d === undefined ? n : d ? n / d : NaN; };

function code(v: string, names: Record<number, string>): string { return names[Number(v)] ?? v; }

function gps(v: string): string {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(v);
  return m ? `${m[1]}° ${formatNumber(Number(m[2]), 4)}′ ${m[3]}` : v;
}

// [key, label, value formatter]; the row order of the tab.
function fields(c: Record<string, string>): [string, string, (v: string) => string][] {
  const unit = (u: string, d = 1) => (v: string) => { const x = num(v); return isFinite(x) ? `${formatNumber(x, d)} ${u}` : v; };
  const fstop = (v: string) => { const x = num(v); return isFinite(x) && x > 0 ? `f/${formatNumber(x, 1)}` : v; };
  return [
    ['Make', t`Make`, String], ['Model', t`Model`, String], ['BodySerialNumber', t`Serial Number`, String],
    ['LensMake', t`Lens Make`, String], ['LensModel', t`Lens`, String],
    ['DateTimeOriginal', t`Date Time Original`, v => v.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')],
    ['ExposureTime', t`Exposure Time`, v => {
      const x = num(v);
      return !isFinite(x) || x <= 0 ? v : x < 1 ? `1/${Math.round(1 / x)} s` : `${formatNumber(x, 1)} s`;
    }],
    ['FNumber', t`F-Stop`, fstop],
    ['ExposureProgram', t`Exposure Program`, v => code(v, {
      0: t`Not defined`, 1: t`Manual`, 2: t`Normal program`, 3: t`Aperture priority`, 4: t`Shutter priority`,
      5: t`Creative program`, 6: t`Action program`, 7: t`Portrait mode`, 8: t`Landscape mode`,
    })],
    ['ISOSpeedRatings', t`ISO Speed Ratings`, v => `ISO ${v}`],
    ['ExposureBiasValue', t`Exposure Bias Value`, unit('EV', 2)],
    ['MaxApertureValue', t`Max Aperture Value`, v => { const x = num(v); return isFinite(x) ? fstop(String(2 ** (x / 2))) : v; }],
    ['FocalLength', t`Focal Length`, unit('mm')],
    ['FocalLengthIn35mmFilm', t`Focal Length in 35mm Film`, unit('mm')],
    ['MeteringMode', t`Metering Mode`, v => code(v, {
      0: t`Unknown`, 1: t`Average`, 2: t`Center-weighted average`, 3: t`Spot`, 4: t`Multi-spot`, 5: t`Pattern`, 6: t`Partial`, 255: t`Other`,
    })],
    ['LightSource', t`Light Source`, v => code(v, {
      0: t`Unknown`, 1: t`Daylight`, 2: t`Fluorescent`, 3: t`Tungsten`, 4: t`Flash`, 9: t`Fine weather`, 10: t`Cloudy`, 11: t`Shade`, 255: t`Other`,
    })],
    ['Flash', t`Flash`, v => { const x = Number(v); return Number.isInteger(x) ? (x & 1 ? t`Fired` : t`Did not fire`) : v; }],
    ['WhiteBalance', t`White Balance`, v => code(v, { 0: t`Auto`, 1: t`Manual` })],
    ['ExposureMode', t`Exposure Mode`, v => code(v, { 0: t`Auto`, 1: t`Manual`, 2: t`Auto bracket` })],
    ['PixelXDimension', t`Pixel Dimension X`, unit('px', 0)], ['PixelYDimension', t`Pixel Dimension Y`, unit('px', 0)],
    ['Orientation', t`Orientation`, v => code(v, {
      1: t`Normal`, 2: t`Flip Horizontal`, 3: t`Rotate 180°`, 4: t`Flip Vertical`, 5: t`Flip Horizontal, Rotate 90° CCW`,
      6: t`Rotate 90° CW`, 7: t`Flip Horizontal, Rotate 90° CW`, 8: t`Rotate 90° CCW`,
    })],
    ['ColorSpace', t`Color Space`, v => code(v, { 1: 'sRGB', 65535: t`Uncalibrated` })],
    ['GPSLatitude', t`Latitude`, gps], ['GPSLongitude', t`Longitude`, gps],
    ['GPSAltitude', t`Altitude`, v => { const x = num(v); return isFinite(x) ? `${formatNumber(c.GPSAltitudeRef === '1' ? -x : x, 1)} m` : v; }],
    ['Software', t`Software`, String],
  ];
}

/** The rows of the Camera Data tab for the non-empty values of `camera`, in the tab's fixed order. */
export function cameraRows(camera: Record<string, string>): CameraRow[] {
  return fields(camera).filter(([k]) => camera[k]).map(([key, label, f]) => ({ key, label, value: f(camera[key]) }));
}
