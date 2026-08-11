import { PATCHLENS_PROTOCOL_LIMITS } from '@patchlens-ai/agent-protocol';

const sensitivePattern =
  /(authorization|cookie|credential|csrf|password|private[-_]?key|secret|session|signature|token|api[-_]?key)/i;
const removableTags = new Set(['script', 'style', 'template', 'noscript']);

export function sanitizeElementHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  if (shouldRemoveElement(clone)) {
    return '';
  }

  for (const node of [...clone.querySelectorAll('*')]) {
    if (shouldRemoveElement(node)) {
      node.remove();
    }
  }

  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    sanitizeAttributes(node);
    sanitizeFormValue(node);
  }
  sanitizeTextNodes(clone);

  return clone.outerHTML.slice(0, PATCHLENS_PROTOCOL_LIMITS.htmlLength);
}

export function extractElementText(element: Element): string {
  return redactSensitiveText(element.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PATCHLENS_PROTOCOL_LIMITS.textLength);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
      '[REDACTED_CREDENTIAL]',
    )
    .replace(
      /\b(authorization|cookie|credential|csrf|token|password|private[_-]?key|secret|session(?:[_-]?id)?|signature|access[_-]?key|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/gi, 'file:///[REDACTED_PATH]');
}

function sanitizeAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name === 'data-patchlens-source') {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name.startsWith('on') || name === 'srcdoc') {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (name === 'value' || sensitivePattern.test(name)) {
      element.setAttribute(attribute.name, '[redacted]');
      continue;
    }

    const redacted = redactSensitiveText(attribute.value);
    if (redacted !== attribute.value) {
      element.setAttribute(attribute.name, redacted);
    }
  }
}

function sanitizeFormValue(element: Element): void {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea' || tagName === 'select') {
    element.textContent = '';
  }
}

function shouldRemoveElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (removableTags.has(tagName)) {
    return true;
  }
  if (!['input', 'textarea', 'select'].includes(tagName)) {
    return false;
  }

  const type = element.getAttribute('type')?.toLowerCase();
  if (type === 'hidden' || type === 'password') {
    return true;
  }
  return ['name', 'id', 'autocomplete'].some((attribute) =>
    sensitivePattern.test(element.getAttribute(attribute) ?? ''),
  );
}

function sanitizeTextNodes(node: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      child.textContent = redactSensitiveText(child.textContent ?? '');
      continue;
    }
    sanitizeTextNodes(child);
  }
}
