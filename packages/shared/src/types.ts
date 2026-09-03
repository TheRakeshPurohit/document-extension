// ── Event Types ──

export type RecordedEventType =
  | 'click'
  | 'input'
  | 'select'
  | 'navigate'
  | 'submit'
  | 'modal'
  | 'screenshot';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParentContext {
  selector: string;
  tag: string;
  role?: string;
  name: string;
  text?: string;
  rect?: Rect;
  landmark?: string;
}

export interface ElementStates {
  expanded?: boolean;
  pressed?: boolean;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  current?: string;
}

export type AfterOutcomeKind =
  | 'expanded'
  | 'collapsed'
  | 'navigated'
  | 'submitted'
  | 'toggled'
  | 'opened-dialog'
  | 'unknown';

export interface AfterOutcome {
  outcome: AfterOutcomeKind;
  states?: ElementStates;
  openOverlayName?: string;
  newUrl?: string;
  newHeading?: string;
}

export interface HighlightSpec {
  rect: Rect;
  number?: number;
  skip?: boolean;
}

export interface ClickMeta {
  elementTag: string;
  elementText: string;
  ariaLabel?: string;
  role?: string;
  selector: string;
  coordinates: { x: number; y: number };
  elementRect?: Rect;
  viewportSize?: { width: number; height: number };
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  href?: string;
  target?: string;
  title?: string;
  parentText?: string;
  fieldLabel?: string;
  breadcrumb?: string;
  tooltipText?: string;
  inputValue?: string;
  parentId?: string;
  parentName?: string;
  listPosition?: string;
  nearbyText?: string;
  viewportHint?: string;
  semanticClasses?: string;
  inEphemeralUI?: boolean;
  scrollPosition?: { x: number; y: number };
  skipHighlight?: boolean;
  accessibleName?: string;
  accessibleDescription?: string;
  parent?: ParentContext;
  states?: ElementStates;
  afterOutcome?: AfterOutcome;
  themeCapture?: 'dual' | 'same';
  pageHeading?: string;
  openOverlays?: string[];
  buttonType?: string;
}

export interface InputMeta {
  fieldLabel: string;
  fieldType: string;
  value: string;
  selector: string;
  placeholder?: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  breadcrumb?: string;
  elementRect?: Rect;
  viewportSize?: { width: number; height: number };
  parentId?: string;
  parentName?: string;
  parentText?: string;
  parent?: ParentContext;
  listPosition?: string;
  scrollPosition?: { x: number; y: number };
  tooltipText?: string;
  viewportHint?: string;
  nearbyText?: string;
  semanticClasses?: string;
  accessibleName?: string;
  accessibleDescription?: string;
  states?: ElementStates;
  pageHeading?: string;
  openOverlays?: string[];
  skipHighlight?: boolean;
}

export interface SelectMeta {
  fieldLabel: string;
  selectedOption: string;
  selector: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  breadcrumb?: string;
  elementRect?: Rect;
  viewportSize?: { width: number; height: number };
  parentId?: string;
  parentName?: string;
  parentText?: string;
  parent?: ParentContext;
  listPosition?: string;
  scrollPosition?: { x: number; y: number };
  tooltipText?: string;
  viewportHint?: string;
  nearbyText?: string;
  semanticClasses?: string;
  accessibleName?: string;
  accessibleDescription?: string;
  states?: ElementStates;
  pageHeading?: string;
  openOverlays?: string[];
  skipHighlight?: boolean;
}

export interface NavigateMeta {
  fromUrl: string;
  toUrl: string;
  newTitle: string;
  pageHeading?: string;
  openOverlays?: string[];
  themeCapture?: 'dual' | 'same';
}

export interface SubmitMeta {
  formName?: string;
  formAction?: string;
  fieldCount: number;
  nearestHeading?: string;
  selector?: string;
  elementRect?: Rect;
  viewportSize?: { width: number; height: number };
  accessibleName?: string;
  parent?: ParentContext;
  pageHeading?: string;
  openOverlays?: string[];
  breadcrumb?: string;
}

export interface ModalMeta {
  action: 'open' | 'close';
  dialogText?: string;
  selector?: string;
  nearestHeading?: string;
  accessibleName?: string;
  elementRect?: Rect;
  viewportSize?: { width: number; height: number };
  pageHeading?: string;
  openOverlays?: string[];
  themeCapture?: 'dual' | 'same';
}

export interface ScreenshotMeta {
  label?: string;
  pageHeading?: string;
  openOverlays?: string[];
  themeCapture?: 'dual' | 'same';
  skipHighlight?: boolean;
  viewportSize?: { width: number; height: number };
  scrollPosition?: { x: number; y: number };
}

export type EventMetadata =
  | ClickMeta
  | InputMeta
  | SelectMeta
  | NavigateMeta
  | SubmitMeta
  | ModalMeta
  | ScreenshotMeta;

export interface DomEdit {
  selector: string;
  original: string;
  modified: string;
  kind?: 'text' | 'hide';
}

export interface RecordedEvent {
  id: string;
  type: RecordedEventType;
  timestamp: number;
  url: string;
  pageTitle: string;
  /** Raw before-click light screenshot (canonical) */
  screenshotId?: string;
  /** Raw before-click dark screenshot */
  altScreenshotId?: string;
  /** Raw after-click light screenshot */
  afterScreenshotId?: string;
  /** Raw after-click dark screenshot */
  afterAltScreenshotId?: string;
  metadata: EventMetadata;
  domEdits?: DomEdit[];
}

// ── Session ──

export interface Session {
  id: string;
  title: string;
  startUrl: string;
  createdAt: number;
  updatedAt: number;
}

// ── Step ──

export interface SubStep {
  title: string;
  description: string;
  elementRect?: Rect;
}

export interface Step {
  id: string;
  sessionId: string;
  sortOrder: number;
  title: string;
  description: string;
  /** Primary annotated before (light) — kept for export/editor compat */
  screenshotId?: string;
  /** Primary annotated before (dark) */
  altScreenshotId?: string;
  /** Raw before light (clean) */
  beforeLightId?: string;
  /** Raw before dark (clean) */
  beforeDarkId?: string;
  /** Raw after light */
  afterLightId?: string;
  /** Raw after dark */
  afterDarkId?: string;
  sourceEventIds: string[];
  isEdited: boolean;
  subSteps?: SubStep[];
  mergeWithNextId?: string;
  themeCapture?: 'dual' | 'same';
  highlights?: HighlightSpec[];
}

// ── API Request/Response Shapes ──

export interface CreateSessionRequest {
  title?: string;
  startUrl: string;
}

export interface BatchEventsRequest {
  events: RecordedEvent[];
}

export interface UpdateStepsRequest {
  steps: Array<{
    id: string;
    sortOrder: number;
    title: string;
    description: string;
  }>;
  deletedStepIds?: string[];
}

export interface SessionEdit {
  selector: string;
  original: string;
  modified: string;
  kind: 'text' | 'hide';
  url?: string;
}

// ── Extension Messages ──

export type ExtensionMessageType =
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'CANCEL_RECORDING'
  | 'RECORDING_STATE'
  | 'EVENT_CAPTURED'
  | 'SET_SKIP_HIGHLIGHT'
  | 'ENTER_EDIT_MODE'
  | 'EXIT_EDIT_MODE'
  | 'TOGGLE_THEME'
  | 'PAUSE_CAPTURE'
  | 'RESUME_CAPTURE'
  | 'HIDE_TOOLBAR'
  | 'SHOW_TOOLBAR'
  | 'GET_STATE'
  | 'CAPTURE_SCREENSHOT'
  | 'CAPTURE_AFTER'
  | 'FLUSH_DOM_EDITS';

export interface ExtensionMessage {
  type: ExtensionMessageType;
  payload?: unknown;
}

export interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  eventCount: number;
  startedAt: number | null;
  editMode: boolean;
  theme: 'system' | 'light' | 'dark';
}
