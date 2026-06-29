// Minimal type surface for the part of the Safelight extension API this
// extension uses. The authoritative definitions live in the host's
// src/extensions/types.ts; this is a focused, version-tolerant subset so the
// extension type-checks on its own. React is `any` — the host injects its own
// instance via api.react and we build UI with React.createElement.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Camera / photo metadata (subset of the host's CatalogPhoto / ExifData) ──

export interface ExifData {
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  lensMake?: string;
  lensSerial?: string;
  focalLength?: number;
  focalLength35mm?: number;
  aperture?: number;
  subjectDistance?: number;
  orientation?: number;
  [key: string]: unknown;
}

export interface CatalogPhoto {
  id: string;
  filename?: string;
  exif?: ExifData;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export type DevelopParams = Record<string, unknown>;
export interface EditState {
  params?: DevelopParams;
  paramBag?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Processing-stage contributions ─────────────────────────────────────────

export type GlslType =
  | "float" | "int" | "bool"
  | "vec2" | "vec3" | "vec4"
  | "ivec2" | "ivec3" | "ivec4"
  | "mat3" | "mat4" | "sampler2D";

export interface UniformDeclaration {
  key: string;
  glslType: GlslType;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}

export type ProcessingPhase =
  | "geometry" | "decode" | "noise-reduction" | "scene-linear"
  | "tone-map" | "display-adjust" | "effects" | "output-encode";

export interface StagePass {
  glsl: string;
  helpers?: string;
  iterations?: number;
  uniforms?: UniformDeclaration[];
}

export interface InterStageVariable {
  name: string;
  glslType: "float" | "vec2" | "vec3" | "vec4";
  producer?: string;
}

export interface ProcessingStageContribution {
  id: string;
  name: string;
  phase: ProcessingPhase;
  priority?: number;
  glsl: string;
  helpers?: string;
  uniforms: UniformDeclaration[];
  passes?: StagePass[];
  produces?: InterStageVariable[];
  consumes?: string[];
  after?: string[];
  mask?: { maskable: true; maskPhase: "linear" | "display" };
}

// ─── UI / lifecycle contributions ───────────────────────────────────────────

export interface PanelDockDefault {
  module: "library" | "develop";
  direction: "left" | "right";
  order?: number;
  width?: number;
  height?: number;
}

export interface PanelContribution {
  id: string;
  title: string;
  component: any;
  slot?: "develop-right" | "develop-left" | "none";
  order?: number;
  defaultDock?: PanelDockDefault;
  onReset?: () => void;
  headerAccessory?: any;
}

export type SettingsField =
  | { key: string; label: string; hint?: string; type: "boolean"; default: boolean }
  | { key: string; label: string; hint?: string; type: "number"; default: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; hint?: string; type: "string"; default: string; placeholder?: string }
  | { key: string; label: string; hint?: string; type: "select"; default: string; options: { value: string; label: string }[] };

export interface SettingsContribution {
  title?: string;
  fields: SettingsField[];
  order?: number;
  component?: any;
  keywords?: string[];
}

export interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<Partial<CatalogPhoto> | void>;
  onMetadataChange?(ctx: {
    photos: CatalogPhoto[];
    getEditState(id: string): Promise<EditState | null>;
  }): Promise<void>;
  onEditCommit?(ctx: { photo: CatalogPhoto; editState: EditState }): Promise<void>;
  onPhotoRemove?(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<void>;
}

export interface PresetImporterContribution {
  id: string;
  label: string;
  extensions: string[];
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}

export interface CursorContribution {
  id: string;
  css?: string;
  image?: string;
  hotspotX?: number;
  hotspotY?: number;
  fallback?: string;
}

// ─── Stores (zustand) ───────────────────────────────────────────────────────

export interface StoreApi<T> {
  (): T;
  getState(): T;
  setState(partial: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(listener: (state: T, prev: T) => void): () => void;
}

export interface DevelopStoreState {
  photoId: string | null;
  params: DevelopParams;
  paramBag: Record<string, unknown>;
  setParam(key: string, value: unknown): void;
  setDynParam(key: string, value: unknown): void;
  setDynParams(patch: Record<string, unknown>): void;
  commitEdit(label?: string): Promise<void> | void;
  [key: string]: unknown;
}

export interface CatalogStoreState {
  photos: CatalogPhoto[];
  [key: string]: unknown;
}

// ─── The scoped API handed to activate() ────────────────────────────────────

export interface SafelightAPI {
  version: 1;
  extensionId: string;
  react: any;
  registerProcessingStage(c: ProcessingStageContribution): void;
  unregisterProcessingStage(id: string): void;
  setStageTexture(
    stageId: string,
    key: string,
    tex: { data: Uint8Array | Float32Array; width: number; height: number; format: string; version: number } | null,
  ): void;
  registerPanel(c: PanelContribution): void;
  registerSettings(c: SettingsContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerPresetImporter(c: PresetImporterContribution): void;
  registerCursor(c: CursorContribution): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  components: Record<string, any>;
  ui?: {
    Button: any;
    Select: any;
    TextInput: any;
    NumberInput: any;
    TextArea: any;
    Toggle: any;
    SegmentedControl: any;
    Field: any;
    Section: any;
    Card: any;
    Badge: any;
    ProgressBar: any;
    Row: any;
    Stack: any;
    tokens: Record<string, string>;
  };
  stores: {
    useDevelopStore: StoreApi<DevelopStoreState>;
    useCatalogStore: StoreApi<CatalogStoreState>;
    [key: string]: any;
  };
  develop: {
    captureFrame(params: DevelopParams): Promise<ImageBitmap>;
    setCanvasCursor(cursor: string | CursorContribution | null, opts?: { priority?: number }): () => void;
    putPhotoData(key: string, data: Uint8Array | null): void;
    getPhotoData(key: string): Promise<Uint8Array | null>;
    [key: string]: any;
  };
  preferences: { open(sectionId?: string): void; close(): void; toggle(): void };
  navigation: { goTo(module: "library" | "develop"): void };
  [key: string]: any;
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
