/**
 * UTBMS (Uniform Task-Based Management System) codes reference data.
 * Used for LEDES 1998B export formatting.
 *
 * Task codes: L-series (Litigation), P-series (Patent)
 * Activity codes: A-series
 * Expense codes: E-series
 */

export const TASK_CODES = [
  // Litigation
  { code: 'L110', label: 'Fact Investigation/Development' },
  { code: 'L120', label: 'Analysis/Strategy' },
  { code: 'L130', label: 'Experts/Consultants' },
  { code: 'L140', label: 'Document/File Management' },
  { code: 'L150', label: 'Budgeting' },
  { code: 'L160', label: 'Settlement/Non-Binding ADR' },
  { code: 'L190', label: 'Other Matter Assessment' },
  { code: 'L210', label: 'Pleadings' },
  { code: 'L220', label: 'Preliminary Injunctions/Provisional Remedies' },
  { code: 'L230', label: 'Court-Mandated Conferences' },
  { code: 'L240', label: 'Motions Practice' },
  { code: 'L250', label: 'Other Written Motions/Submissions' },
  { code: 'L310', label: 'Written Discovery' },
  { code: 'L320', label: 'Document Production' },
  { code: 'L330', label: 'Depositions' },
  { code: 'L340', label: 'Expert Discovery' },
  { code: 'L350', label: 'Discovery Motions' },
  { code: 'L390', label: 'Other Discovery' },
  { code: 'L410', label: 'Fact Witnesses' },
  { code: 'L420', label: 'Expert Witnesses' },
  { code: 'L430', label: 'Written Submissions' },
  { code: 'L440', label: 'Other Trial Preparation/Support' },
  { code: 'L450', label: 'Trial and Hearing Attendance' },
  { code: 'L460', label: 'Post-Trial Motions and Submissions' },
  { code: 'L510', label: 'Appellate Motions/Submissions/Briefs' },
  { code: 'L520', label: 'Appellate Oral Argument' },
  { code: 'L530', label: 'Other Appellate Work' },
  // Corporate/Transactional
  { code: 'C100', label: 'Fact Gathering' },
  { code: 'C200', label: 'Analysis/Advice' },
  { code: 'C300', label: 'Drafting/Reviewing Documents' },
  { code: 'C400', label: 'Negotiations' },
  { code: 'C500', label: 'Regulatory/Tax Advice' },
  { code: 'C600', label: 'Dispute Resolution' },
  { code: 'C700', label: 'Other Counseling/Advice' },
  // Patent
  { code: 'P100', label: 'Patentability/Validity Analysis' },
  { code: 'P200', label: 'Patent Application Preparation' },
  { code: 'P210', label: 'Patent Prosecution' },
  { code: 'P220', label: 'Responding to Office Actions' },
  { code: 'P230', label: 'Interferences/Oppositions/Post-Grant Reviews' },
  { code: 'P240', label: 'Maintenance Fees' },
  { code: 'P250', label: 'Patent Licensing/Assignment' },
  { code: 'P260', label: 'Patent Litigation' },
  { code: 'P280', label: 'Other Patent Work' },
];

export const ACTIVITY_CODES = [
  { code: 'A101', label: 'Plan and Prepare for' },
  { code: 'A102', label: 'Research' },
  { code: 'A103', label: 'Draft' },
  { code: 'A104', label: 'Review/Analyze' },
  { code: 'A105', label: 'Communicate (with client)' },
  { code: 'A106', label: 'Communicate (with opposing counsel)' },
  { code: 'A107', label: 'Communicate (other external)' },
  { code: 'A108', label: 'Communicate (internal firm)' },
  { code: 'A109', label: 'Appear for/Attend' },
  { code: 'A110', label: 'Manage Data/Files' },
  { code: 'A111', label: 'Other' },
  { code: 'A112', label: 'Travel' },
  { code: 'A113', label: 'Investigative/Fact Finding' },
  { code: 'A114', label: 'Strategy' },
];

export const EXPENSE_CODES = [
  { code: 'E101', label: 'Copying' },
  { code: 'E102', label: 'Outside Printing' },
  { code: 'E103', label: 'Word Processing' },
  { code: 'E104', label: 'Facsimile' },
  { code: 'E105', label: 'Telephone' },
  { code: 'E106', label: 'Online Research' },
  { code: 'E107', label: 'Delivery Services/Messengers' },
  { code: 'E108', label: 'Postage' },
  { code: 'E109', label: 'Local Travel' },
  { code: 'E110', label: 'Out-of-Town Travel' },
  { code: 'E111', label: 'Meals' },
  { code: 'E112', label: 'Court Fees' },
  { code: 'E113', label: 'Subpoena Fees' },
  { code: 'E114', label: 'Witness Fees' },
  { code: 'E115', label: 'Deposition Transcripts' },
  { code: 'E116', label: 'Trial Transcripts' },
  { code: 'E117', label: 'Trial Exhibits' },
  { code: 'E118', label: 'Litigation Support Vendors' },
  { code: 'E119', label: 'Expert Fees' },
  { code: 'E120', label: 'Investigation Fees' },
  { code: 'E121', label: 'Records Acquisition' },
  { code: 'E122', label: 'Court Reporter' },
  { code: 'E123', label: 'Other Professionals' },
];
