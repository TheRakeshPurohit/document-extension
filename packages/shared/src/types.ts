// ── Event Types ──

export type RecordedEventType =
  | 'click'
  | 'input'
  | 'select'
  | 'navigate'
  | 'submit'
  | 'modal';

export interface ClickMeta {
  elementTag: string;
  elementText: string;
  ariaLabel?: string;
  role?: string;
  selector: string;
  coordinates: { x: number; y: number };
  elementRect?: { x: number; y: number; width: number; height: number };
  viewportSize?: { width: number; height: number };
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  href?: string;
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
  elementRect?: { x: number; y: number; width: number; height: number };
  viewportSize?: { width: number; height: number };
  parentId?: string;
  listPosition?: string;
  scrollPosition?: { x: number; y: number };
}

export interface SelectMeta {
  fieldLabel: string;
  selectedOption: string;
  selector: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  breadcrumb?: string;
  elementRect?: { x: number; y: number; width: number; height: number };
  viewportSize?: { width: number; height: number };
  parentId?: string;
  listPosition?: string;
  scrollPosition?: { x: number; y: number };
}

export interface NavigateMeta {
  fromUrl: string;
  toUrl: string;
  newTitle: string;
}

export interface SubmitMeta {
  formName?: string;
  formAction?: string;
  fieldCount: number;
  nearestHeading?: string;
}

export interface ModalMeta {
  action: 'open' | 'close';
  dialogText?: string;
  selector?: string;
  nearestHeading?: string;
}

export type EventMetadata =
  | ClickMeta
  | InputMeta
  | SelectMeta
  | NavigateMeta
  | SubmitMeta
  | ModalMeta;

export interface DomEdit {
  selector: string;
  original: string;
  modified: string;
}

export interface RecordedEvent {
  id: string;
  type: RecordedEventType;
  timestamp: number;
  url: string;
  pageTitle: string;
  screenshotId?: string;
  altScreenshotId?: string;
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
  elementRect?: { x: number; y: number; width: number; height: number };
}

export interface Step {
  id: string;
  sessionId: string;
  sortOrder: number;
  title: string;
  description: string;
  screenshotId?: string;
  altScreenshotId?: string;
  sourceEventIds: string[];
  isEdited: boolean;
  subSteps?: SubStep[];
  mergeWithNextId?: string;
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
  | 'CAPTURE_SCREENSHOT';

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
