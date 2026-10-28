// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The panel a local-adjustment mask adds from the Masking panel's Adjust tab.
// A mask runs the vignetting and defringe stages again inside it, on top of
// the photo's correction, so it carries its own manual vignetting and defringe,
// under the dock's labels and ranges. The lens profile, distortion, chromatic
// aberration and Auto CA stay the photo's: distortion and CA run before mask
// coverage is known, and Auto CA measures the whole photo.

import type { SafelightAPI } from "../types/safelight";
import { STAGE } from "../params";

interface MaskSlider {
  label: string;
  key: string;
  min: number;
  max: number;
  dflt: number;
}

const VIGNETTING: MaskSlider = { label: "Vignetting", key: `${STAGE.vignette}.vigManual`, min: -100, max: 100, dflt: 0 };
const DEFRINGE: MaskSlider = { label: "Defringe", key: `${STAGE.defringe}.dfAmount`, min: 0, max: 100, dflt: 0 };
const HUES: MaskSlider[] = [
  { label: "Purple hue", key: `${STAGE.defringe}.dfPurpleHue`, min: 0, max: 360, dflt: 0 },
  { label: "Green hue", key: `${STAGE.defringe}.dfGreenHue`, min: 0, max: 360, dflt: 0 },
  { label: "Hue radius", key: `${STAGE.defringe}.dfRadius`, min: 1, max: 120, dflt: 50 },
];

/** Every stage key the mask panel writes. */
export const MASK_KEYS: readonly string[] = [VIGNETTING, DEFRINGE, ...HUES].map((s) => s.key);

export function createLensMaskPanel(api: SafelightAPI) {
  const React = api.react;
  const h = React.createElement;

  function LensMaskPanel() {
    const scope = api.develop.useParamScope();
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    const values = scope.getParams();

    const slider = (s: MaskSlider) => {
      const value = values[s.key];
      return h(api.components.Slider, {
        key: s.label,
        label: s.label,
        value: typeof value === "number" ? value : s.dflt,
        min: s.min,
        max: s.max,
        step: 1,
        onChange: (v: number) => scope.setParams({ [s.key]: v }),
        onCommit: () => scope.commit(`Lens ${s.label}`),
      });
    };

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 1 } },
      slider(VIGNETTING),
      slider(DEFRINGE),
      h(
        api.ui!.Button,
        { variant: "ghost", size: "sm", full: true, onClick: () => setAdvancedOpen(!advancedOpen) },
        (advancedOpen ? "▾ " : "▸ ") + "Advanced defringe",
      ),
      advancedOpen ? HUES.map(slider) : null,
    );
  }

  return LensMaskPanel;
}
