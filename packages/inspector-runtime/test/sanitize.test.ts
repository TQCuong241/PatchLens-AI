import { describe, expect, it } from 'vitest';

import { extractElementText, redactSensitiveText, sanitizeElementHtml } from '../src/sanitize.js';

describe('Inspector DOM sanitization', () => {
  it('removes sensitive form controls and redacts captured text', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <section data-note="token=visible-token">
        <input type="password" value="password-value" />
        <input type="hidden" name="session" value="hidden-value" />
        <input name="csrf_token" value="csrf-value" />
        <p>Bearer bearer-value token=inline-value sk-abcdefghijklmnop</p>
      </section>
    `;
    const element = container.firstElementChild!;

    const sanitized = sanitizeElementHtml(element);

    expect(sanitized).not.toContain('password-value');
    expect(sanitized).not.toContain('hidden-value');
    expect(sanitized).not.toContain('csrf-value');
    expect(sanitized).not.toContain('bearer-value');
    expect(sanitized).not.toContain('inline-value');
    expect(sanitized).not.toContain('sk-abcdefghijklmnop');
    expect(sanitized).not.toContain('<input');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('returns no HTML for a sensitive root control', () => {
    const input = document.createElement('input');
    input.type = 'password';
    input.value = 'password-value';

    expect(sanitizeElementHtml(input)).toBe('');
  });

  it('redacts text extraction and standalone provider text', () => {
    const element = document.createElement('p');
    element.textContent = 'token=text-value Bearer bearer-value';

    expect(extractElementText(element)).toBe('token=[REDACTED] Bearer [REDACTED]');
    expect(redactSensitiveText('api_key=key-value')).toBe('api_key=[REDACTED]');
  });

  it('redacts session, signed URL, and provider credential patterns', () => {
    const link = document.createElement('a');
    const fakeGithubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
    link.setAttribute('data-session-id', 'session-value');
    link.href = 'https://example.test/file?X-Amz-Signature=signed-value';
    link.textContent = fakeGithubToken;

    const sanitized = sanitizeElementHtml(link);

    expect(sanitized).not.toContain('session-value');
    expect(sanitized).not.toContain('signed-value');
    expect(sanitized).not.toContain(fakeGithubToken);
    expect(sanitized).toContain('[REDACTED]');
  });
});
