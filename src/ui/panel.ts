// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The develop panel + manual lens picker, built with React.createElement off
// api.react (runtime bundles can't use JSX/Tailwind). Controls use the shared
// core UI kit (api.ui) for parity with the rest of the app; remaining inline
// styles use theme CSS variables, plus api.components.{Panel,Slider}.

import type { SafelightAPI } from "../types/safelight";
import type { LensState, LensMode } from "../params";
import type { LensfunLens } from "../db/types";
import {
  getUIStore,
  updateState,
  pickLens,
  runAutoCa,
  clearAutoCa,
  importLcp,
} from "../controller";
import { loadLensDb, getCachedLensDb } from "../db/loader";

const MODES: { value: LensMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "profile", label: "Profile" },
  { value: "manual", label: "Manual" },
];

const SOURCE_LABEL: Record<string, string> = {
  lensfun: "Lensfun",
  embedded: "Embedded",
  lcp: "Adobe LCP",
  manual: "Manual",
};

export function createLensPanel(api: SafelightAPI) {
  const React = api.react;
  const h = React.createElement;
  const ui = api.ui;
  const useUI = getUIStore();
  const commit = (label: string) =>
    void api.stores.useDevelopStore.getState().commitEdit(label);

  // ── Small themed primitives ──
  const text = {
    color: "var(--color-text-primary)",
    fontSize: 11,
  } as const;
  const subtext = {
    color: "var(--color-text-secondary)",
    fontSize: 11,
  } as const;

  function ModeToggle(props: { mode: LensMode }) {
    return h(ui!.SegmentedControl, {
      value: props.mode,
      onChange: (v: string) => updateState({ mode: v as LensMode }, "Lens Mode"),
      options: MODES,
      size: "sm",
    });
  }

  function Toggle(props: { label: string; checked: boolean; onChange: () => void }) {
    return h(
      "label",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          ...text,
          cursor: "pointer",
          userSelect: "none",
          padding: "1px 0",
        },
      },
      h("input", {
        type: "checkbox",
        checked: props.checked,
        onChange: props.onChange,
        style: { width: 12, height: 12, accentColor: "var(--color-accent)" },
      }),
      props.label,
    );
  }

  function FallbackSlider(props: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (v: number) => void;
    onCommit: () => void;
  }) {
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 1, padding: "1px 0" } },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", ...subtext } },
        h("span", null, props.label),
        h("span", null, String(Math.round(props.value))),
      ),
      h("input", {
        type: "range",
        min: props.min,
        max: props.max,
        step: props.step,
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChange(Number(e.target.value)),
        onMouseUp: props.onCommit,
        onTouchEnd: props.onCommit,
        style: { width: "100%", accentColor: "var(--color-accent)" },
      }),
    );
  }

  const Slider = (api.components && api.components.Slider) || FallbackSlider;

  function slider(
    label: string,
    key: keyof LensState,
    value: number,
    min: number,
    max: number,
  ) {
    return h(Slider, {
      key: label,
      label,
      value,
      min,
      max,
      step: 1,
      onChange: (v: number) => updateState({ [key]: v } as Partial<LensState>),
      onCommit: () => commit(`Lens ${label}`),
    });
  }

  // ── Manual lens picker dialog ──
  function PickerDialog(props: { onClose: () => void }) {
    const [query, setQuery] = React.useState("");
    const [db, setDb] = React.useState(getCachedLensDb() ?? ([] as LensfunLens[]));

    React.useEffect(() => {
      if (db.length === 0) void loadLensDb().then(setDb);
    }, []);

    const filtered = React.useMemo(() => {
      if (!query.trim()) return db.slice(0, 60);
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      return db
        .filter((l: LensfunLens) => {
          const t = `${l.maker} ${l.model}`.toLowerCase();
          return tokens.every((tok: string) => t.includes(tok));
        })
        .slice(0, 60);
    }, [query, db]);

    const groups = React.useMemo(() => {
      const m = new Map<string, LensfunLens[]>();
      for (const l of filtered) {
        const arr = m.get(l.maker) ?? [];
        arr.push(l);
        m.set(l.maker, arr);
      }
      return [...m.entries()];
    }, [filtered]);

    return h(
      "div",
      {
        onClick: (e: { target: unknown; currentTarget: unknown }) => {
          if (e.target === e.currentTarget) props.onClose();
        },
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0,0,0,0.5)",
        },
      },
      h(
        "div",
        {
          style: {
            width: 400,
            maxHeight: 500,
            display: "flex",
            flexDirection: "column",
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
          },
        },
        h(
          "div",
          { style: { padding: 8, borderBottom: "1px solid var(--color-border)" } },
          h(ui!.TextInput, {
            value: query,
            onChange: (v: string) => setQuery(v),
            placeholder: "Search lenses…",
            // TextInput forwards native input attrs, so focus-on-open + the
            // accessible name are preserved through the kit.
            autoFocus: true,
            "aria-label": "Search lenses",
          }),
        ),
        h(
          "div",
          { style: { flex: 1, overflowY: "auto", padding: 4 } },
          db.length === 0
            ? h("div", { style: { ...subtext, textAlign: "center", padding: 16 } }, "Loading lens database…")
            : filtered.length === 0
              ? h("div", { style: { ...subtext, textAlign: "center", padding: 16 } }, `No lenses matching "${query}"`)
              : groups.map(([maker, lenses]: [string, LensfunLens[]]) =>
                  h(
                    "div",
                    { key: maker, style: { marginBottom: 4 } },
                    h(
                      "div",
                      {
                        style: {
                          ...subtext,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          padding: "2px 4px",
                        },
                      },
                      maker,
                    ),
                    lenses.map((l: LensfunLens) =>
                      h(
                        ui!.Button,
                        {
                          key: l.id,
                          variant: "ghost",
                          size: "sm",
                          full: true,
                          onClick: () => {
                            pickLens(l.id, `${l.maker} ${l.model}`);
                            props.onClose();
                          },
                        },
                        h(
                          "span",
                          { style: { display: "flex", width: "100%", textAlign: "left" } },
                          h("span", null, l.model),
                          l.focalMin > 0
                            ? h(
                                "span",
                                { style: { marginLeft: 6, color: "var(--color-text-muted)" } },
                                l.focalMin === l.focalMax
                                  ? `${l.focalMin}mm`
                                  : `${l.focalMin}-${l.focalMax}mm`,
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
        ),
        h(
          "div",
          { style: { padding: 8, borderTop: "1px solid var(--color-border)", display: "flex", justifyContent: "space-between" } },
          h(
            ui!.Button,
            {
              variant: "ghost",
              size: "sm",
              onClick: () => {
                updateState({ lensId: null, pref: "auto" }, "Auto Lens");
                props.onClose();
              },
            },
            "Auto-detect",
          ),
          h(ui!.Button, { variant: "ghost", size: "sm", onClick: props.onClose }, "Cancel"),
        ),
      ),
    );
  }

  // ── The panel ──
  function LensPanel() {
    if (!api.ui)
      return h(
        "div",
        { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } },
        "Update Safelight to use this panel.",
      );
    const state = useUI((s: { state: LensState }) => s.state);
    const detectedName = useUI((s: { detectedName: string | null }) => s.detectedName);
    const source = useUI((s: { source: string | null }) => s.source);
    const status = useUI((s: { status: string | null }) => s.status);
    const busy = useUI((s: { busy: boolean }) => s.busy);
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    const lcpInputRef = React.useRef(null);

    const profileBlock =
      state.mode === "profile"
        ? h(
            "div",
            { key: "profile", style: { display: "flex", flexDirection: "column", gap: 4, padding: "0 2px" } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 4, ...subtext } },
              h(
                "span",
                { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: detectedName || "" },
                detectedName || "No lens detected",
              ),
              source
                ? h(
                    "span",
                    {
                      style: {
                        fontSize: 9,
                        padding: "1px 4px",
                        borderRadius: 3,
                        background: "var(--color-surface-2)",
                        color: "var(--color-text-muted)",
                      },
                    },
                    SOURCE_LABEL[source] ?? source,
                  )
                : null,
              h(
                ui!.Button,
                { variant: "ghost", size: "sm", onClick: () => setPickerOpen(true), title: "Choose lens manually" },
                "Edit",
              ),
              h(
                ui!.Button,
                {
                  variant: "ghost",
                  size: "sm",
                  onClick: () => lcpInputRef.current && lcpInputRef.current.click(),
                  title: "Import an Adobe Lens Profile (.lcp)",
                },
                "LCP",
              ),
              h("input", {
                ref: lcpInputRef,
                type: "file",
                accept: ".lcp",
                style: { display: "none" },
                onChange: (e: { target: { files: FileList | null; value: string } }) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  if (f) void importLcp(f);
                },
              }),
            ),
            !detectedName
              ? h(
                  "div",
                  { style: { fontSize: 10, fontStyle: "italic", color: "var(--color-text-muted)" } },
                  "No matching profile found. Click Edit to select a lens.",
                )
              : null,
            h(Toggle, { label: "Distortion", checked: state.distortionEnabled, onChange: () => updateState({ distortionEnabled: !state.distortionEnabled }, "Lens Toggle") }),
            h(Toggle, { label: "Chromatic Aberration", checked: state.caEnabled, onChange: () => updateState({ caEnabled: !state.caEnabled }, "Lens Toggle") }),
            h(Toggle, { label: "Vignetting", checked: state.vignetteEnabled, onChange: () => updateState({ vignetteEnabled: !state.vignetteEnabled }, "Lens Toggle") }),
            h(Toggle, { label: "Auto Crop", checked: state.autoCrop, onChange: () => updateState({ autoCrop: !state.autoCrop }, "Lens Toggle") }),
          )
        : null;

    const sliderBlock =
      state.mode !== "off"
        ? h(
            "div",
            { key: "sliders", style: { display: "flex", flexDirection: "column", gap: 1 } },
            slider("Distortion", "distortion", state.distortion, -100, 100),
            state.mode === "manual" ? slider("Fringing", "chromaticAberration", state.chromaticAberration, 0, 100) : null,
            slider("Defringe", "defringe", state.defringe, 0, 100),
            state.mode === "manual" ? slider("Vignetting", "vignetting", state.vignetting, -100, 100) : null,
          )
        : null;

    const autoCaBlock =
      state.mode !== "off"
        ? h(
            "div",
            { key: "autoca", style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 0" } },
            h(
              ui!.Button,
              { variant: "ghost", size: "sm", disabled: busy, onClick: () => void runAutoCa(), title: "Estimate chromatic aberration from the image" },
              busy ? "Analyzing…" : "Auto CA",
            ),
            state.caAuto
              ? h(ui!.Button, { variant: "ghost", size: "sm", onClick: clearAutoCa }, "Clear")
              : null,
          )
        : null;

    const advancedBlock =
      state.mode !== "off"
        ? h(
            "div",
            { key: "adv", style: { display: "flex", flexDirection: "column", gap: 1 } },
            h(
              ui!.Button,
              {
                variant: "ghost",
                size: "sm",
                full: true,
                onClick: () => setAdvancedOpen(!advancedOpen),
              },
              (advancedOpen ? "▾ " : "▸ ") + "Advanced defringe",
            ),
            advancedOpen
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 1 } },
                  slider("Purple hue", "defringePurpleHue", state.defringePurpleHue, 0, 360),
                  slider("Green hue", "defringeGreenHue", state.defringeGreenHue, 0, 360),
                  slider("Hue radius", "defringeRadius", state.defringeRadius, 1, 120),
                )
              : null,
          )
        : null;

    const statusLine = status
      ? h("div", { key: "status", style: { fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 } }, status)
      : null;

    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 4 } },
      h(ModeToggle, { mode: state.mode }),
      profileBlock,
      sliderBlock,
      autoCaBlock,
      advancedBlock,
      statusLine,
      pickerOpen ? h(PickerDialog, { onClose: () => setPickerOpen(false) }) : null,
    );

    const Panel = api.components && api.components.Panel;
    return Panel
      ? h(Panel, { title: "Lens Correction", defaultOpen: false }, body)
      : h(
          "div",
          { style: { padding: 6 } },
          h("div", { style: { ...subtext, fontWeight: 600, marginBottom: 4 } }, "Lens Correction"),
          body,
        );
  }

  return LensPanel;
}
