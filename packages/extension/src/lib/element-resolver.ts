export interface ElementInfo {
  tag: string;
  text: string;
  ariaLabel?: string;
  role?: string;
  selector: string;
  fieldLabel?: string;
  fieldType?: string;
  placeholder?: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  href?: string;
  title?: string;
  inputValue?: string;
  parentText?: string;
  breadcrumb?: string;
  tooltipText?: string;
  parentId?: string;
  parentName?: string;
  listPosition?: string;
  nearbyText?: string;
  viewportHint?: string;
  semanticClasses?: string;
}

function getAriaLabel(el: Element): string | undefined {
  return el.getAttribute('aria-label') || undefined;
}

const SKIP_TAGS = new Set(['svg', 'img', 'input', 'select', 'textarea', 'script', 'style', 'noscript']);

function getTextContent(el: Element): string {
  let result = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && SKIP_TAGS.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    result += walker.currentNode.textContent || '';
    if (result.length > 130) break;
  }
  const text = result.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}

function getDirectText(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function getAssociatedLabel(el: Element): string | undefined {
  const id = el.getAttribute('id');
  if (id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return (label.textContent || '').trim();
    } catch { /* invalid selector */ }
  }

  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, select, textarea').forEach((c) => c.remove());
    const text = (clone.textContent || '').trim();
    if (text) return text;
  }

  for (const attr of ['aria-labelledby', 'aria-describedby']) {
    const ids = el.getAttribute(attr);
    if (ids) {
      const labels = ids.split(/\s+/).map((refId) => document.getElementById(refId)?.textContent?.trim()).filter(Boolean);
      if (labels.length > 0) return labels.join(' ');
    }
  }

  const prev = el.previousElementSibling;
  if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
    const text = (prev.textContent || '').trim();
    if (text && text.length < 60) return text;
  }

  return undefined;
}

function getFieldType(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) return el.type || 'text';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  return undefined;
}

function getPlaceholder(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.placeholder || undefined;
  }
  return undefined;
}

function getNearestHeading(el: Element): string | undefined {
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 8) {
    const heading: Element | null = current.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    if (heading && heading !== el) {
      const text = (heading.textContent || '').trim();
      if (text && text.length < 80) return text;
    }

    const ariaLabel = current.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 80 && current !== el) return ariaLabel;

    current = current.parentElement;
    depth++;
  }
  return undefined;
}

function getSectionContext(el: Element): { sectionLabel?: string; containerRole?: string } {
  const landmarkRoles = new Set([
    'navigation', 'banner', 'main', 'complementary', 'contentinfo',
    'form', 'search', 'dialog', 'toolbar', 'menu', 'menubar', 'tablist',
  ]);
  const semanticTags: Record<string, string> = {
    nav: 'navigation', header: 'header', footer: 'footer', main: 'main content',
    aside: 'sidebar', form: 'form', dialog: 'dialog', menu: 'menu',
  };

  let current: Element | null = el.parentElement;
  let depth = 0;
  while (current && depth < 10) {
    const role = current.getAttribute('role');
    if (role && landmarkRoles.has(role)) {
      const label = current.getAttribute('aria-label') || '';
      return { sectionLabel: label || undefined, containerRole: role };
    }

    const tag = current.tagName.toLowerCase();
    if (tag in semanticTags) {
      const label = current.getAttribute('aria-label') || '';
      return { sectionLabel: label || undefined, containerRole: semanticTags[tag] };
    }

    current = current.parentElement;
    depth++;
  }
  return {};
}

// --- Stable Selector Generation ---

const DYNAMIC_ID_RE = /[:.\[\]]/;
const FRAMEWORK_ID_RE = /^(radix-|react-|rc-|headlessui-|mui-|chakra-|mantine-|__next|ember\d|:r)/i;

function isStableId(id: string): boolean {
  if (!id || id.length > 80) return false;
  if (FRAMEWORK_ID_RE.test(id)) return false;
  if (DYNAMIC_ID_RE.test(id)) return false;
  if (/^\d/.test(id)) return false;
  if (/[0-9a-f]{8,}/i.test(id)) return false;
  return true;
}

function buildAnchoredPath(el: Element): string | null {
  const segments: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < 6) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const id = current.getAttribute('id');
    if (id && isStableId(id)) {
      segments.unshift(`#${CSS.escape(id)}`);
      return segments.join(' > ');
    }

    const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
    if (testId) {
      segments.unshift(`[data-testid="${CSS.escape(testId)}"]`);
      return segments.join(' > ');
    }

    const parentEl: Element | null = current.parentElement;
    if (parentEl) {
      const siblings = Array.from(parentEl.children).filter((c) => c.tagName === current!.tagName);
      if (siblings.length === 1) {
        segments.unshift(tag);
      } else {
        const index = siblings.indexOf(current) + 1;
        segments.unshift(`${tag}:nth-child(${index})`);
      }
    } else {
      segments.unshift(tag);
    }

    current = parentEl;
    depth++;
  }
  return null;
}

export function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();

  const id = el.getAttribute('id');
  if (id && isStableId(id)) return `#${CSS.escape(id)}`;

  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length < 60) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;

  const role = el.getAttribute('role');
  // Only return a role-anchored selector when the role is GLOBALLY unique on
  // the page (otherwise `[role="button"]` would match every button-role
  // element). Falls through to the parent-relative path when ambiguous.
  if (role) {
    try {
      const matches = document.querySelectorAll(`[role="${CSS.escape(role)}"]`);
      if (matches.length === 1 && matches[0] === el) {
        return `[role="${CSS.escape(role)}"]`;
      }
    } catch { /* invalid role string */ }
  }

  const parent = el.parentElement;
  if (parent) {
    const anchorPath = buildAnchoredPath(el);
    if (anchorPath) return anchorPath;

    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName
    );
    const parentSel = buildSelectorShallow(parent);
    if (siblings.length === 1) {
      return `${parentSel} > ${tag}`;
    }
    const index = siblings.indexOf(el) + 1;
    return `${parentSel} > ${tag}:nth-child(${index})`;
  }

  return tag;
}

function buildSelectorShallow(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute('id');
  if (id && isStableId(id)) return `#${CSS.escape(id)}`;

  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length < 60) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;

  // tag + role disambiguates among multiple roles of the same kind on the page,
  // and nth-child below disambiguates within the same parent.
  const role = el.getAttribute('role');
  const parent = el.parentElement;
  if (!parent) {
    return role ? `${tag}[role="${CSS.escape(role)}"]` : tag;
  }

  const baseSel = role ? `${tag}[role="${CSS.escape(role)}"]` : tag;
  const siblings = Array.from(parent.children).filter(
    (c) => c.tagName === el.tagName
  );
  if (siblings.length === 1) return baseSel;
  const index = siblings.indexOf(el) + 1;
  return role ? `${baseSel}:nth-child(${index})` : `${tag}:nth-child(${index})`;
}

function getParentText(el: Element): string | undefined {
  try {
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 4) {
      if (isStrongInteractive(parent)) {
        const text = getDirectText(parent);
        if (text && text.length > 0 && text.length < 80) return text;
        const ariaLabel = parent.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.length < 80) return ariaLabel;
      }
      parent = parent.parentElement;
      depth++;
    }
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getBreadcrumb(el: Element): string | undefined {
  try {
    const parts: string[] = [];
    let current: Element | null = el.parentElement;
    let depth = 0;

    while (current && depth < 8) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      let label = current.getAttribute('aria-label');
      if (!label) {
        const role = current.getAttribute('role');
        if (role && ['navigation', 'toolbar', 'menu', 'menubar', 'dialog', 'tablist', 'banner', 'main', 'complementary', 'form', 'search'].includes(role)) {
          label = role.charAt(0).toUpperCase() + role.slice(1);
        }
      }
      if (!label) {
        const semanticMap: Record<string, string> = { nav: 'Navigation', header: 'Header', footer: 'Footer', main: 'Main', aside: 'Sidebar', form: 'Form', dialog: 'Dialog' };
        if (tag in semanticMap) label = semanticMap[tag];
      }
      if (!label) {
        const id = current.getAttribute('id');
        if (id && isStableId(id) && id.length < 30) {
          label = id.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
          label = label.charAt(0).toUpperCase() + label.slice(1);
        }
      }

      if (label && !parts.includes(label)) {
        parts.unshift(label);
      }
      current = current.parentElement;
      depth++;
    }

    return parts.length > 0 ? parts.join(' > ') : undefined;
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getTooltipText(el: Element): string | undefined {
  try {
    const title = el.getAttribute('title');
    if (title && title.length < 100) return title;
    const tooltip = el.getAttribute('data-tooltip') || el.getAttribute('data-tip');
    if (tooltip && tooltip.length < 100) return tooltip;
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getParentId(el: Element): string | undefined {
  try {
    let current = el.parentElement;
    let depth = 0;
    while (current && depth < 6) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      const id = current.getAttribute('id');
      if (id && isStableId(id)) return id;
      current = current.parentElement;
      depth++;
    }
  } catch { /* detached or cross-origin */ }
  return undefined;
}

const LIST_ITEM_ROLES = new Set(['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'tab', 'listitem']);
const LIST_CONTAINER_TAGS = new Set(['ul', 'ol', 'menu']);
const LIST_CONTAINER_ROLES = new Set(['list', 'listbox', 'menu', 'menubar', 'tablist', 'tree', 'group']);

function getListPosition(el: Element): string | undefined {
  try {
    let item: Element | null = el;
    let depth = 0;
    while (item && depth < 4) {
      const tag = item.tagName.toLowerCase();
      const role = item.getAttribute('role');
      if (tag === 'li' || (role && LIST_ITEM_ROLES.has(role))) break;
      item = item.parentElement;
      depth++;
    }
    if (!item) return undefined;

    const container = item.parentElement;
    if (!container) return undefined;

    const cTag = container.tagName.toLowerCase();
    const cRole = container.getAttribute('role');
    if (!LIST_CONTAINER_TAGS.has(cTag) && !(cRole && LIST_CONTAINER_ROLES.has(cRole))) return undefined;

    const itemTag = item.tagName.toLowerCase();
    const itemRole = item.getAttribute('role');
    const siblings = Array.from(container.children).filter((c) => {
      if (c.tagName.toLowerCase() === itemTag) return true;
      const r = c.getAttribute('role');
      return r !== null && itemRole !== null && r === itemRole;
    });

    const index = siblings.indexOf(item) + 1;
    if (index < 1 || siblings.length < 2) return undefined;
    return `${index} of ${siblings.length}`;
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getNearbyText(el: Element): string | undefined {
  try {
    const prev = el.previousElementSibling;
    if (prev) {
      const t = (prev.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 50) return t;
    }
    const next = el.nextElementSibling;
    if (next) {
      const t = (next.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 50) return t;
    }
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getParentName(el: Element): string | undefined {
  try {
    let current = el.parentElement;
    let depth = 0;
    while (current && depth < 6) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      const ariaLabel = current.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.length < 80) return ariaLabel;

      if (isStrongInteractive(current) || ['nav', 'aside', 'section', 'header', 'footer', 'form', 'dialog'].includes(tag)) {
        const text = getDirectText(current);
        if (text && text.length > 1 && text.length < 60) return text;
      }

      const id = current.getAttribute('id');
      if (id && isStableId(id) && id.length < 40) {
        const humanized = id.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
        if (humanized.length > 1) return humanized;
      }

      current = current.parentElement;
      depth++;
    }
  } catch { /* detached or cross-origin */ }
  return undefined;
}

function getViewportHint(el: Element): string | undefined {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return undefined;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const horiz = cx < vw * 0.25 ? 'left' : cx > vw * 0.75 ? 'right' : 'center';
    const vert = cy < vh * 0.25 ? 'top' : cy > vh * 0.75 ? 'bottom' : 'middle';

    if (horiz === 'left' && vert !== 'top' && vert !== 'bottom') return 'left panel';
    if (horiz === 'right' && vert !== 'top' && vert !== 'bottom') return 'right panel';
    if (vert === 'top' && horiz === 'center') return 'top of the page';
    if (vert === 'bottom' && horiz === 'center') return 'bottom of the page';
    if (vert === 'top' && horiz === 'left') return 'top-left area';
    if (vert === 'top' && horiz === 'right') return 'top-right area';
    if (vert === 'bottom' && horiz === 'left') return 'bottom-left area';
    if (vert === 'bottom' && horiz === 'right') return 'bottom-right area';
    return undefined;
  } catch { return undefined; }
}

const NOISE_CLASS_RE = /^(css-|_|jsx-|sc-|tw-|svelte-|ng-|chakra-|mu[iI]|emotion-|cl-|rs-)/;
const HEX_CLASS_RE = /[0-9a-f]{6,}/i;

function getSemanticClasses(el: Element): string | undefined {
  try {
    const classes = Array.from(el.classList).filter((c) => {
      if (c.length > 40 || c.length < 3) return false;
      if (NOISE_CLASS_RE.test(c)) return false;
      if (HEX_CLASS_RE.test(c)) return false;
      if (/^\d/.test(c)) return false;
      return true;
    });
    if (classes.length === 0) return undefined;
    return classes.slice(0, 3).join(', ');
  } catch { return undefined; }
}

export function resolveElement(el: Element): ElementInfo {
  const { sectionLabel, containerRole } = getSectionContext(el);

  const info: ElementInfo = {
    tag: el.tagName.toLowerCase(),
    text: getTextContent(el),
    ariaLabel: getAriaLabel(el),
    role: el.getAttribute('role') || undefined,
    selector: buildSelector(el),
    fieldLabel: getAssociatedLabel(el),
    fieldType: getFieldType(el),
    placeholder: getPlaceholder(el),
    nearestHeading: getNearestHeading(el),
    sectionLabel,
    containerRole,
    title: el.getAttribute('title') || undefined,
  };

  if (el.tagName === 'A') {
    info.href = (el as HTMLAnchorElement).href;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const isSensitive = info.fieldType === 'password' || SENSITIVE_ATTRS.test(info.fieldLabel || '') || SENSITIVE_ATTRS.test(el.name || '') || SENSITIVE_ATTRS.test(el.getAttribute('autocomplete') || '');
    info.inputValue = isSensitive ? '••••••' : el.value;
  }
  if (el instanceof HTMLSelectElement) {
    info.inputValue = el.options[el.selectedIndex]?.text || el.value;
  }

  if (!info.text) {
    const directText = getDirectText(el);
    if (directText) {
      info.text = directText;
    } else {
      const img = el.querySelector('img[alt]') as HTMLImageElement | null;
      if (img) {
        info.text = img.alt;
      } else {
        const svgTitle = el.querySelector('svg title');
        if (svgTitle) {
          info.text = svgTitle.textContent || '';
        } else {
          const ariaDesc = el.getAttribute('aria-label') || el.getAttribute('title');
          if (ariaDesc) info.text = ariaDesc;
        }
      }
    }
  }

  try {
    info.parentText = getParentText(el);
    info.breadcrumb = getBreadcrumb(el);
    info.tooltipText = getTooltipText(el);
    info.parentId = getParentId(el);
    info.parentName = getParentName(el);
    info.listPosition = getListPosition(el);
    info.nearbyText = getNearbyText(el);
    info.viewportHint = getViewportHint(el);
    info.semanticClasses = getSemanticClasses(el);
  } catch { /* safe fallback */ }

  return info;
}

const SENSITIVE_ATTRS = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

// --- Interactive Element Detection ---

const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'summary', 'details',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'checkbox', 'radio', 'switch', 'option', 'combobox', 'listbox',
  'slider', 'spinbutton', 'treeitem', 'gridcell', 'row',
]);

const POPUP_INDICATORS = new Set([
  'aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected',
]);

export function isStrongInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;

  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  if (el.getAttribute('tabindex') !== null) return true;

  for (const attr of POPUP_INDICATORS) {
    if (el.hasAttribute(attr)) return true;
  }

  if (el.hasAttribute('onclick') || el.hasAttribute('data-action')) return true;

  if ((el as HTMLElement).contentEditable === 'true') return true;

  if (tag.includes('-') && el.hasAttribute('role')) return true;

  return false;
}

export function isInteractiveElement(el: Element): boolean {
  if (isStrongInteractive(el)) return true;

  try {
    if (window.getComputedStyle(el).cursor === 'pointer') return true;
  } catch { /* cross-origin or detached */ }

  let ancestor = el.parentElement;
  let depth = 0;
  while (ancestor && depth < 5) {
    const aTag = ancestor.tagName.toLowerCase();
    if (aTag === 'a' || aTag === 'button') return true;
    const aRole = ancestor.getAttribute('role');
    if (aRole && INTERACTIVE_ROLES.has(aRole)) return true;
    ancestor = ancestor.parentElement;
    depth++;
  }

  return false;
}
