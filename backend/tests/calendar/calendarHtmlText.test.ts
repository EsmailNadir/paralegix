/**
 * Provider descriptions arrive as HTML: Outlook returns every body as HTML
 * (no `Prefer: outlook.body-content-type` header is sent), and Google returns
 * the HTML its web editor wrote once anyone formatted a description there.
 *
 * `cleanHtmlContent` is what turns either into the plain text a matter event's
 * notes, a task's description and an imported event's description hold. It
 * used to strip every tag, so the URL behind a Teams "Join the meeting now"
 * link vanished, the CSS in Outlook's `<head>` leaked into the notes, `<div>`
 * and `<li>` lines ran together, `&amp;lt;` was decoded twice, and numeric
 * entities stayed encoded.
 */
import { cleanHtmlContent } from '../../src/modules/calendar/shared/calendarHelpers';

const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);
const BULLET = String.fromCharCode(0x2022);

// The body Graph returns for a Teams meeting created in Outlook on the web,
// trimmed of repeated inline styles but structurally as sent.
const OUTLOOK_TEAMS_INVITE = `<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style type="text/css" style="display:none">
<!--
p
	{margin-top:0;
	margin-bottom:0}
-->
</style>
</head>
<body dir="ltr">
<div class="elementToProof" style="font-family:Aptos,Aptos_EmbeddedFont,Calibri,Helvetica,sans-serif;font-size:12pt;color:rgb(0,0,0)">
Agenda: settlement terms &amp; next steps</div>
<div class="elementToProof" style="font-family:Aptos;font-size:12pt">Bring the signed &#8220;release&#8221; &#x2022; v2</div>
<br>
<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>
<div class="me-email-text" lang="en-US" style="color:#252424;font-family:'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="margin-top:24px;margin-bottom:20px"><span style="font-size:24px;color:#252424">Microsoft Teams meeting</span></div>
<div style="margin-bottom:20px">
<div style="margin-top:0px;margin-bottom:0px;font-weight:bold"><span style="font-size:14px;color:#252424">Join on your computer, mobile app or room device</span></div>
<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjM4%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d&amp;btype=a&amp;role=a" class="me-email-headline" style="font-size:14px;text-decoration:underline;color:#6264a7" target="_blank" rel="noreferrer noopener">Join the meeting now</a>
</div>
<div style="margin-bottom:20px;margin-top:20px">
<div style="margin-bottom:4px"><span data-tid="meeting-code" style="font-size:14px;color:#252424">Meeting ID: <span style="font-size:16px;color:#252424">271 384 990 112</span></span><br>
<span style="font-size:14px;color:#252424">Passcode: </span><span style="font-size:16px;color:#252424">Xq7Bn2</span>
</div>
<div style="font-size:14px"><a href="https://www.microsoft.com/en-us/microsoft-teams/download-app" class="me-email-link" style="font-size:14px;text-decoration:underline;color:#6264a7">Download Teams</a> | <a href="https://www.microsoft.com/microsoft-teams/join-a-meeting" class="me-email-link" style="font-size:14px;text-decoration:underline;color:#6264a7">Join on the web</a></div>
</div>
</div>
<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>
</body>
</html>
`;

// A description formatted in the Google Calendar web editor, as the API
// returns it: no wrapper, `<br>` for line breaks, real list markup.
const GOOGLE_RICH_DESCRIPTION = '<b>Mediation prep</b><br>Topics:<ul><li>Damages &amp; offsets</li><li>Witness list</li></ul>'
  + 'Zoom: <a href="https://zoom.us/j/9988776655?pwd=abc">https://zoom.us/j/9988776655?pwd=abc</a><br><br>'
  + 'Notes: see <a href="https://drive.google.com/file/d/1AbC/view">the brief</a>';

describe('cleanHtmlContent', () => {
  it('returns an empty string for nothing', () => {
    expect(cleanHtmlContent(null)).toBe('');
    expect(cleanHtmlContent(undefined)).toBe('');
    expect(cleanHtmlContent('')).toBe('');
  });

  describe('an Outlook Teams invite', () => {
    const text = cleanHtmlContent(OUTLOOK_TEAMS_INVITE);

    it('keeps the join link target beside its text', () => {
      expect(text).toContain(
        'Join the meeting now (https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjM4%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d&btype=a&role=a)',
      );
    });

    it('drops the stylesheet in the head', () => {
      expect(text).not.toMatch(/margin-top|margin-bottom|<!--/);
      expect(text.startsWith('Agenda: settlement terms & next steps')).toBe(true);
    });

    it('puts each block on its own line', () => {
      const lines = text.split('\n');
      expect(lines).toContain('Agenda: settlement terms & next steps');
      expect(lines).toContain('Microsoft Teams meeting');
      expect(lines).toContain('Join on your computer, mobile app or room device');
      expect(lines).toContain('Meeting ID: 271 384 990 112');
      expect(lines).toContain('Passcode: Xq7Bn2');
    });

    it('decodes numeric entities, decimal and hex', () => {
      expect(text).toContain(`Bring the signed ${LEFT_QUOTE}release${RIGHT_QUOTE} ${BULLET} v2`);
    });

    it('keeps inline links on one line with their targets', () => {
      expect(text).toContain(
        'Download Teams (https://www.microsoft.com/en-us/microsoft-teams/download-app) | Join on the web (https://www.microsoft.com/microsoft-teams/join-a-meeting)',
      );
    });

    it('leaves no tags and no runs of more than one blank line', () => {
      expect(text).not.toMatch(/<[^>]+>/);
      expect(text).not.toMatch(/\n{3,}/);
    });
  });

  describe('a Google rich description', () => {
    it('turns breaks and list items into lines and bullets', () => {
      expect(cleanHtmlContent(GOOGLE_RICH_DESCRIPTION)).toBe([
        'Mediation prep',
        'Topics:',
        '- Damages & offsets',
        '- Witness list',
        'Zoom: https://zoom.us/j/9988776655?pwd=abc',
        '',
        'Notes: see the brief (https://drive.google.com/file/d/1AbC/view)',
      ].join('\n'));
    });
  });

  it('writes a link whose text is its own address once', () => {
    expect(cleanHtmlContent('<a href="https://example.com/">https://example.com</a>')).toBe('https://example.com');
    expect(cleanHtmlContent('<a href="mailto:clerk@court.gov">clerk@court.gov</a>')).toBe('clerk@court.gov');
  });

  it('writes the bare address of a link with no text', () => {
    expect(cleanHtmlContent('Dial in: <a href="https://meet.example.com/x"></a>')).toBe('Dial in: https://meet.example.com/x');
  });

  it('does not surface a script link target', () => {
    expect(cleanHtmlContent('<a href="javascript:alert(1)">Open</a>')).toBe('Open');
  });

  it('numbers ordered list items and indents a nested list', () => {
    expect(cleanHtmlContent('<ol><li>File motion<ul><li>Exhibit A</li></ul></li><li>Serve</li></ol>')).toBe([
      '1. File motion',
      '  - Exhibit A',
      '2. Serve',
    ].join('\n'));
  });

  it('decodes each entity exactly once', () => {
    // `&amp;lt;` is the text "&lt;", not "<": decoding twice changes what was written.
    expect(cleanHtmlContent('<p>Use &amp;lt;b&amp;gt; for bold &lt; 5 &amp; &#39;ok&#39; &nbsp;done</p>')).toBe(
      'Use &lt;b&gt; for bold < 5 & \'ok\'  done',
    );
  });

  it('drops script and title text', () => {
    expect(cleanHtmlContent('<html><head><title>Invite</title><script>var x = 1;</script></head><body><div>Hello</div></body></html>')).toBe('Hello');
  });

  it('separates table cells and rows', () => {
    expect(cleanHtmlContent('<table><tr><td>Judge</td><td>Hon. Lee</td></tr><tr><td>Room</td><td>4B</td></tr></table>')).toBe(
      'Judge Hon. Lee\nRoom 4B',
    );
  });

  it('keeps the blank line between paragraphs Exchange writes for a plain-text body', () => {
    const exchange = '<html><head></head><body><div class="PlainText">Client: Acme<br>\r\n<br>\r\nHearing: Status<br>\r\n<br>\r\n(Matter event from Paralegix)</div></body></html>';
    expect(cleanHtmlContent(exchange)).toBe('Client: Acme\n\nHearing: Status\n\n(Matter event from Paralegix)');
  });

  it('leaves plain text alone: its line breaks, and characters that only look like markup', () => {
    const plain = 'Fees < $500 & costs\n\nBring: exhibits\nCall 555-0100';
    expect(cleanHtmlContent(plain)).toBe(plain);
  });

  it('keeps the line breaks of text that carries only inline markup', () => {
    expect(cleanHtmlContent('First line\nSee <a href="https://x.test/doc">the doc</a>')).toBe(
      'First line\nSee the doc (https://x.test/doc)',
    );
  });
});
