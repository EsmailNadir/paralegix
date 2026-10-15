export interface ScreenReaderUtterance {
  role: string;
  name: string;
  description?: string;
  state?: string[];
  spokenText: string;
}

/**
 * Computes the simulated VoiceOver/NVDA speech utterance for a given DOM element.
 */
export function narrateElement(el: HTMLElement | null): ScreenReaderUtterance | null {
  if (!el) return null;

  // Check aria-hidden
  if (el.closest('[aria-hidden="true"]')) {
    return null;
  }

  const role = el.getAttribute('role') || getDefaultRole(el);
  const name = computeAccessibleName(el);
  const description = computeAccessibleDescription(el);
  const states: string[] = [];

  // ARIA / HTML States
  if (el.getAttribute('aria-invalid') === 'true') {
    states.push('invalid entry');
  }
  if (el.getAttribute('aria-expanded') === 'true') {
    states.push('expanded');
  } else if (el.getAttribute('aria-expanded') === 'false') {
    states.push('collapsed');
  }
  if (el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true) {
    states.push('checked');
  } else if (el.getAttribute('aria-checked') === 'false' || (el as HTMLInputElement).checked === false && (el as HTMLInputElement).type === 'checkbox') {
    states.push('unchecked');
  }
  if (el.getAttribute('aria-selected') === 'true') {
    states.push('selected');
  }
  if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') {
    states.push('required');
  }
  if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') {
    states.push('dimmed');
  }

  // Construct spoken sentence in VoiceOver / NVDA speech order
  const parts: string[] = [];
  if (name) parts.push(name);
  if (states.length > 0) parts.push(states.join(', '));
  if (role) parts.push(role);
  if (description) parts.push(description);

  return {
    role,
    name,
    description: description || undefined,
    state: states.length > 0 ? states : undefined,
    spokenText: parts.join(', '),
  };
}

function getDefaultRole(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button': return 'button';
    case 'a': return el.hasAttribute('href') ? 'link' : '';
    case 'h1': return 'heading level 1';
    case 'h2': return 'heading level 2';
    case 'h3': return 'heading level 3';
    case 'h4': return 'heading level 4';
    case 'h5': return 'heading level 5';
    case 'h6': return 'heading level 6';
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio button';
      if (type === 'button' || type === 'submit') return 'button';
      return 'edit text';
    }
    case 'textarea': return 'edit text';
    case 'select': return 'pop up button';
    case 'dialog': return 'dialog';
    case 'main': return 'main landmark';
    case 'nav': return 'navigation landmark';
    case 'header': return 'banner landmark';
    case 'footer': return 'content information landmark';
    default: return '';
  }
}

function computeAccessibleName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const ariaLabelledby = el.getAttribute('aria-labelledby');
  if (ariaLabelledby) {
    const text = ariaLabelledby
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  // Associated label element
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label && label.textContent) return label.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.textContent) {
    return parentLabel.textContent.trim();
  }

  if (el.getAttribute('placeholder')) {
    return el.getAttribute('placeholder')!.trim();
  }

  // Text content fallback for buttons, links, headings
  const tag = el.tagName.toLowerCase();
  if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'p'].includes(tag)) {
    return (el.textContent || '').trim();
  }

  return '';
}

function computeAccessibleDescription(el: HTMLElement): string {
  const ariaDescribedby = el.getAttribute('aria-describedby');
  if (ariaDescribedby) {
    return ariaDescribedby
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');
  }
  return '';
}
