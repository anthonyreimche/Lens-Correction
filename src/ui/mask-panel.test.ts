// The Masking panel's Lens Correction, rendered without React or a DOM:
// createElement builds a plain tree and useState keeps its slots across
// renders, so a click's state change shows on the next render.

import { beforeEach, describe, expect, it } from "vitest";
import type { DevelopStoreState, ParamScope, SafelightAPI, StoreApi } from "../types/safelight";
import { createLensMaskPanel } from "./mask-panel";

interface Element {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange(v: number): void;
  onCommit(): void;
}

const Slider = () => null;
const Button = () => null;
const SegmentedControl = () => null;

const VIG = "com.safelight.lens-correction.vignette";
const DF = "com.safelight.lens-correction.defringe";

function store<T>(initial: T): StoreApi<T> {
  let state = initial;
  return Object.assign(() => state, {
    getState: () => state,
    setState(patch: Partial<T> | ((s: T) => Partial<T>)) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    },
    subscribe: () => () => {},
  });
}

function findAll(node: unknown, test: (el: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((c) => findAll(c, test));
  if (!node || typeof node !== "object") return [];
  const el = node as Element;
  return [...(test(el) ? [el] : []), ...findAll(el.children, test)];
}

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" ? textOf((node as Element).children) : "";
}

/** The mask panel over a photo bag and a mask holding `maskBag`. */
function rig(maskBag: Record<string, unknown> = {}, photoBag: Record<string, unknown> = {}) {
  const commits: string[] = [];
  const develop = store<DevelopStoreState>({
    photoId: "p1",
    params: {},
    paramBag: photoBag,
    setParam: () => {},
    setDynParam: () => {},
    setDynParams: (patch) => develop.setState((s) => ({ paramBag: { ...s.paramBag, ...patch } })),
    commitEdit: (label) => void commits.push(label ?? ""),
  });
  const mask = store({ bag: maskBag });
  const scope: ParamScope = {
    maskId: "mask-1",
    getParam: (key) => mask.getState().bag[key],
    getParams: () => mask.getState().bag,
    setParams: (patch) => mask.setState((s) => ({ bag: { ...s.bag, ...patch } })),
    commit: (label) => void commits.push(`mask: ${label}`),
  };
  let slots: unknown[] = [];
  let cursor = 0;
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props: props ?? {},
      children,
    }),
    useState: <T>(init: T | (() => T)) => {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof init === "function" ? (init as () => T)() : init;
      return [slots[at] as T, (v: T) => void (slots[at] = v)];
    },
  };
  const api = {
    react,
    components: { Slider },
    ui: { Button, SegmentedControl },
    stores: { useDevelopStore: develop },
    develop: { useParamScope: () => scope },
  } as unknown as SafelightAPI;
  const Panel = createLensMaskPanel(api);
  const render = () => {
    cursor = 0;
    return Panel() as Element;
  };
  const sliders = () => findAll(render(), (e) => e.type === Slider).map((e) => e.props as unknown as SliderProps);
  const slider = (label: string) => sliders().find((s) => s.label === label)!;
  return { develop, mask, commits, render, sliders, slider, reset: () => (slots = []) };
}

describe("Lens Correction in a mask", () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig({ [`${VIG}.vigManual`]: -30, [`${DF}.dfAmount`]: 40 }, { [`${VIG}.vigManual`]: 10, [`${DF}.dfAmount`]: 5 });
  });

  it("shows the mask's vignetting and defringe, not the photo's", () => {
    expect(r.slider("Vignetting").value).toBe(-30);
    expect(r.slider("Defringe").value).toBe(40);
  });

  it("leaves out the lens profile, distortion, fringing and Auto CA, which a mask can't run", () => {
    const tree = r.render();
    expect(r.sliders().map((s) => s.label)).toEqual(["Vignetting", "Defringe"]);
    expect(findAll(tree, (e) => e.type === SegmentedControl)).toEqual([]);
    expect(textOf(tree)).not.toMatch(/Distortion|Fringing|Auto CA|Auto Crop|Profile|LCP/);
  });

  it("writes a slider to the mask, leaves the photo's values alone, and commits once", () => {
    const vignetting = r.slider("Vignetting");
    vignetting.onChange(25);
    vignetting.onCommit();
    expect(r.mask.getState().bag).toEqual({ [`${VIG}.vigManual`]: 25, [`${DF}.dfAmount`]: 40 });
    expect(r.develop.getState().paramBag).toEqual({ [`${VIG}.vigManual`]: 10, [`${DF}.dfAmount`]: 5 });
    expect(r.commits).toEqual(["mask: Lens Vignetting"]);
  });

  it("keeps the hue targets behind Advanced defringe, as the dock does", () => {
    const toggle = findAll(r.render(), (e) => e.type === Button && /Advanced defringe/.test(textOf(e)))[0];
    expect(r.sliders().map((s) => s.label)).not.toContain("Purple hue");
    (toggle.props.onClick as () => void)();
    expect(r.sliders().map((s) => s.label)).toEqual(["Vignetting", "Defringe", "Purple hue", "Green hue", "Hue radius"]);
    r.slider("Purple hue").onChange(280);
    expect(r.mask.getState().bag[`${DF}.dfPurpleHue`]).toBe(280);
  });

  it("starts an untouched mask at no change, with the dock's hue radius", () => {
    const fresh = rig();
    (findAll(fresh.render(), (e) => e.type === Button)[0].props.onClick as () => void)();
    expect(fresh.sliders().map((s) => [s.label, s.value])).toEqual([
      ["Vignetting", 0],
      ["Defringe", 0],
      ["Purple hue", 0],
      ["Green hue", 0],
      ["Hue radius", 50],
    ]);
  });
});
