export interface NoteTemplate {
  id: string;
  label: string;
  noteType: string;
  subject: string;
  content: string;
  description: string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'blank',
    label: 'Blank Note',
    noteType: 'general',
    subject: '',
    content: '',
    description: 'Start with a blank note'
  },
  {
    id: 'phone-call',
    label: 'Phone Call',
    noteType: 'phone-call',
    subject: 'Phone Call - ',
    content: `<p><strong>Call Details:</strong></p>
<ul>
  <li>Date/Time: </li>
  <li>Duration: </li>
  <li>Participants: </li>
</ul>
<p><strong>Discussion Summary:</strong></p>
<p></p>
<p><strong>Action Items:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Follow-up Required:</strong></p>
<p></p>`,
    description: 'Template for documenting phone calls'
  },
  {
    id: 'client-meeting',
    label: 'Client Meeting',
    noteType: 'meeting',
    subject: 'Meeting with Client -',
    content: `<p><strong>Meeting Details:</strong></p>
<ul>
  <li>Date/Time: </li>
  <li>Location: </li>
  <li>Attendees: </li>
</ul>
<p><strong>Agenda:</strong></p>
<p></p>
<p><strong>Discussion Notes:</strong></p>
<p></p>
<p><strong>Decisions Made:</strong></p>
<p></p>
<p><strong>Action Items:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Follow-up Required:</strong></p>
<p></p>`,
    description: 'Template for client meeting notes'
  },
  {
    id: 'court-appearance',
    label: 'Court Appearance',
    noteType: 'court',
    subject: 'Court Appearance - ',
    content: `<p><strong>Court Details:</strong></p>
<ul>
  <li>Date: </li>
  <li>Time: </li>
  <li>Court: </li>
  <li>Judge: </li>
  <li>Matter Number: </li>
</ul>
<p><strong>Appearance Type:</strong></p>
<p></p>
<p><strong>Summary of Proceedings:</strong></p>
<p></p>
<p><strong>Rulings/Orders:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Next Steps:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Next Court Date:</strong></p>
<p></p>`,
    description: 'Template for court appearance notes'
  },
  {
    id: 'research',
    label: 'Legal Research',
    noteType: 'research',
    subject: 'Research: ',
    content: `<p><strong>Research Topic:</strong></p>
<p></p>
<p><strong>Research Question:</strong></p>
<p></p>
<p><strong>Sources Reviewed:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Key Findings:</strong></p>
<ol>
  <li></li>
</ol>
<p><strong>Relevant Matter Law:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Conclusion/Recommendation:</strong></p>
<p></p>`,
    description: 'Template for legal research notes'
  },
  {
    id: 'internal-memo',
    label: 'Internal Memo',
    noteType: 'internal',
    subject: 'Internal Memo: ',
    content: `<p><strong>To:</strong> </p>
<p><strong>From:</strong> </p>
<p><strong>Date:</strong> </p>
<p><strong>Re:</strong> </p>
<hr>
<p><strong>Summary:</strong></p>
<p></p>
<p><strong>Details:</strong></p>
<p></p>
<p><strong>Recommendations:</strong></p>
<ul>
  <li></li>
</ul>`,
    description: 'Template for internal team memos'
  },
  {
    id: 'email-summary',
    label: 'Email Summary',
    noteType: 'communication',
    subject: 'Email Summary - ',
    content: `<p><strong>Email Details:</strong></p>
<ul>
  <li>From: </li>
  <li>To: </li>
  <li>Date: </li>
  <li>Subject: </li>
</ul>
<p><strong>Summary:</strong></p>
<p></p>
<p><strong>Key Points:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Action Required:</strong></p>
<p></p>`,
    description: 'Template for summarizing important emails'
  },
  {
    id: 'document-review',
    label: 'Document Review',
    noteType: 'document-review',
    subject: 'Document Review: ',
    content: `<p><strong>Document Information:</strong></p>
<ul>
  <li>Document Name: </li>
  <li>Document Type: </li>
  <li>Date Received: </li>
  <li>Reviewed By: </li>
</ul>
<p><strong>Summary:</strong></p>
<p></p>
<p><strong>Key Findings:</strong></p>
<ol>
  <li></li>
</ol>
<p><strong>Issues/Concerns:</strong></p>
<ul>
  <li></li>
</ul>
<p><strong>Recommendations:</strong></p>
<p></p>`,
    description: 'Template for document review notes'
  }
];

export const getTemplate = (id: string): NoteTemplate | undefined => {
  return NOTE_TEMPLATES.find(template => template.id === id);
};
