# Preset Document Templates: Source Research (Ohio-first)

Research notes for shipping a library of **pre-built, pre-filled document templates** in
Paralegix: where the source documents come from, what we are legally allowed to redistribute,
what competitors ship, and a jurisdiction-by-jurisdiction list of the roughly 10 documents that
actually get filed most often.

**Ohio is the recommended first jurisdiction** and gets the deep treatment in §2. Other
jurisdictions follow in §3 and §4.

> **Accuracy note.** Form numbers marked ✅ were checked against the issuing court's own site
> while writing this. Lists marked ⚠️ are drawn from general practice knowledge and need a pass
> against the live form index before anyone builds a template off them. Courts renumber and retire
> forms constantly (Texas repealed its Supreme Court protective-order forms outright in 2023, for
> example). Treat every form number here as a starting point, not a citation.

---

## 1. Short answer: is there "a site"?

There is no single site. There are four tiers, and a real product uses three of them.

| Tier | What it is | Cost | Can we redistribute? |
|---|---|---|---|
| **1. Issuing courts** | Each state's supreme court or AOC publishes its own mandatory forms. Federal courts publish AO, JS and B forms. | Free | Yes, see §6 |
| **2. Legal-aid automation** | Ohio Legal Help, Pro Bono Net's LawHelp Interactive, Suffolk LIT Lab's Document Assembly Line, TexasLawHelp. Guided interviews that fill Tier 1 forms; the interview logic is open source. | Free (MIT) | Yes, with attribution |
| **3. Aggregators** | Justia Legal Forms (free), US Legal Forms, Rocket Lawyer, Nolo, LawDepot. | Free to paid | **No**, proprietary |
| **4. Firm-side business docs** | Engagement letters, fee agreements, demand letters, releases. No court publishes these. | n/a | We author them |

**Recommendation:** build Tier 1 plus Tier 2 for court filings, author Tier 4 ourselves, and never
touch Tier 3 except as a competitive reference.

---

## 2. Ohio

### 2.1 Why Ohio is the best jurisdiction to build first

Three reasons, and the third is the one that matters technically.

1. **Deep statewide standardization.** The Supreme Court of Ohio promulgates mandatory standard
   forms for probate (Sup.R. 51), domestic relations and juvenile (Sup.R. 75), and protection
   orders (Sup.R. 10.01 and following). All 88 counties accept them. That is a far larger
   standardized surface than most states outside California.
2. **One central, well-organized index.** Everything lives under
   <https://www.supremecourt.ohio.gov/forms/all-forms/>, browsable by division, with a working
   search. No hunting across 88 county sites for the statewide layer.
3. **Ohio publishes Microsoft Word versions, not just flattened PDFs.** ✅ The domestic relations,
   juvenile and protection order forms are offered in **PDF and Word**, and the protection order
   forms additionally ship with Arabic, Chinese, French, Russian and Spanish translations plus ASL
   video. This is the big one: **Word forms drop straight into Paralegix's existing DOCX template
   pipeline** with `{placeholder}` substitution, with none of the AcroForm field-mapping work
   described in §8. Ohio lets us ship a real court-form library before we build the PDF filler.

The tradeoff: **Ohio has no statewide standardized general civil pleading set.** Standardization is
deep in probate, domestic relations, juvenile and protection orders, and thin in ordinary common
pleas civil litigation, where pleadings are attorney-drafted and each county supplies its own cover
sheets and praecipes. Plan coverage around that shape rather than fighting it.

### 2.2 Ohio sources

| Source | URL | What it covers |
|---|---|---|
| Supreme Court of Ohio, All Forms ✅ | <https://www.supremecourt.ohio.gov/forms/all-forms/> | The statewide hub. Probate, DR/juvenile, protection orders, court services |
| DR and juvenile standardized forms ✅ | <https://www.supremecourt.ohio.gov/forms/all-forms/domestic-relations-and-juvenile-standardized/1> | Affidavits 1 to 5, Forms 6 to 32 / UJF 1 to 11. PDF and Word |
| Probate forms ✅ | <https://www.supremecourt.ohio.gov/forms/all-forms/probate/5> | Forms 1.0 through 30.0 across 12 series |
| Protection order forms ✅ | <https://www.supremecourt.ohio.gov/courts/services-to-courts/domestic-violence-program/domestic-violence-protection-order-forms/> | 10.01, 10.02, 10.03, 10.04 series. PDF, Word, translations |
| Ohio Legal Help ✅ | <https://www.ohiolegalhelp.org/> | Nonprofit, free guided interactive forms. Record sealing (Opportunity Port), eviction, family |
| County courts ⚠️ | per-county | Local cover sheets, praecipes, standing orders, eviction and small claims packets |

### 2.3 Ohio probate court, decedent's estate ✅ (verified against the Supreme Court index)

The highest-volume Ohio filing set. Every form below is a Supreme Court standard form accepted in
all 88 counties.

1. Form 1.0, Surviving Spouse, Children, Next of Kin, Legatees, and Devisees
2. Form 2.0, Application to Probate Will (with 2.1 Waiver of Notice, 2.2 Notice of Probate of Will,
   2.3 Entry Admitting Will to Probate, 2.4 Certificate of Service)
3. Form 4.0, Application for Authority to Administer Estate (with 4.2 Fiduciary's Bond, 4.3 Waiver
   of Right to Administer, 4.5 Entry Appointing Fiduciary and Letters of Authority)
4. Form 5.0 and 5.1, Application to Relieve Estate From Administration, and Assets and Liabilities
5. Form 5.10 and 5.11, Summary Release From Administration, and Entry Granting It
6. Form 6.0 and 6.1, Inventory and Appraisal, and Schedule of Assets
7. Form 7.0, Certification of Notice to Administrator of Medicaid Estate Recovery Program
8. Form 9.0 and 9.1, Application to Sell Personal Property, and Entry Authorizing Sale
9. Form 12.0 and 12.1, Application for Certificate of Transfer, and Certificate of Transfer (real
   estate)
10. Form 13.0 through 13.6, Fiduciary's Account, Receipts and Disbursements, Assets Remaining,
    Entry Approving and Settling Account, Certificate of Termination

Adjacent probate sets worth packaging separately: **Wrongful Death** (14.0 to 14.3), **Minor
Settlement** (22.0 to 22.7), **Change of Name** (21.0 to 21.14), **Adoption** (18.0 to 19.4).

### 2.4 Ohio probate court, guardianship ✅

1. Form 15.0, Next of Kin of Proposed Ward
2. Form 16.0, Application for Appointment of Guardian of Minor
3. Form 17.0, Application for Appointment of Guardian (an Alleged Incompetent)
4. Form 17.1, Statement of Expert Evaluation
5. Form 15.2 and 15.9, Fiduciary's Acceptance (Guardian), and Oath of Guardian
6. Form 15.3 and 15.4, Guardian's Bond, and Letters of Guardianship
7. Form 15.5, Guardian's Inventory
8. Form 15.7, Application for Authority to Expend Funds
9. Form 15.8, Guardian's Account
10. Form 17.7, Guardian's Report, plus Form 27.7 and 27.8, Annual Guardianship Plan (Person and
    Estate)

### 2.5 Ohio domestic relations, Uniform Domestic Relations Forms ✅

Adopted under Sup.R. 75. Offered in **PDF and Word**.

1. Affidavit 1, Affidavit of Basic Information, Income, and Expenses
2. Affidavit 2, Affidavit of Property and Debt
3. Affidavit 3, Parenting Proceeding Affidavit
4. Affidavit 4, Health Insurance Affidavit
5. Affidavit 5, Motion and Affidavit or Counter Affidavit for Temporary Orders Without Oral Hearing
6. Form 7, Complaint for Divorce with Children (Form 6 for the no-children version)
7. Form 11, Answer to Complaint for Divorce With Children (Forms 9 and 13 for counterclaim and
   reply)
8. Form 15, Judgment Entry, Decree of Divorce With Children (Form 14 without children)
9. Form 17 and 18, Petition for Dissolution of Marriage and Waiver of Service, and Decree of
   Dissolution
10. Form 19, Separation Agreement
11. Form 20 and 21, Shared Parenting Plan, and Parenting Plan
12. Form 31, Request for Service (Form 30, Waiver of Service of Summons)

Also published alongside these: Grandparent Power of Attorney, Caretaker Authorization Affidavit,
and the Civil Fee Waiver Affidavit and Order. ✅

### 2.6 Ohio juvenile court, Uniform Juvenile Forms ✅

Numbered as both UDRF and UJF, since they are shared between divisions.

1. UJF 1 / Form 22, Parenting Judgment Entry
2. UJF 2 / Form 23, Complaint for Parentage, Allocation of Parental Rights and Responsibilities and
   Parenting Time
3. UJF 3 / Form 24, Motion for Contempt, Affidavit, and Instructions for Service
4. UJF 4 / Form 25, Show Cause Order and Notice
5. UJF 5 / Form 26, Motion for Change of Parenting Time (Companionship and Visitation)
6. UJF 6 / Form 27, Motion for Change of Parental Rights and Responsibilities (Custody)
7. UJF 7 / Form 28, Motion for Change of Child Support, Medical Support, Tax Exemption, or Other
   Child-related Expenses
8. UJF 8 / Form 29, Explanation of Health Care Bills
9. UJF 9 / Form 30, Waiver of Service of Summons
10. UJF 10 / Form 31, Request for Service, and UJF 11 / Form 32, Motion to Intervene

### 2.7 Ohio protection orders ✅ (Sup.R. 10.01 and following)

Courts must use these forms or substantially similar ones. PDF and Word, with translations.

1. Form 10.01-A, General Information About Domestic Violence Protection Orders ✅
2. Form 10.01-D, Petition for Domestic Violence Civil Protection Order (R.C. 3113.31) ✅
3. DVCPO Ex Parte Order (10.01 series) ⚠️
4. DVCPO Full Hearing Order (10.01 series) ⚠️
5. Consent Agreement and DVCPO (10.01 series) ⚠️
6. Modified DVCPO (10.01 series) ⚠️
7. Form 10.01-P, Petition for Dating Violence Civil Protection Order ✅
8. Form 10.01-Q and 10.01-R, DTCPO Ex Parte and Full Hearing ✅
9. Form 10.02-A, Domestic Violence Temporary Protection Order (criminal, DVTPO) ✅
10. Form 10.04-A, Notice Concerning Possession or Purchase of Firearms ✅

The 10.03 series covers civil stalking and sexually-oriented-offense protection orders (CSPO), and
is a separate package worth shipping. ⚠️

### 2.8 Ohio common pleas, general civil ⚠️

No statewide standardized set. These are attorney-drafted pleadings plus per-county administrative
forms, which means Paralegix templates here are **firm templates with merge fields**, not
reproductions of official forms. That is arguably easier, not harder.

1. Complaint (contract, personal injury, foreclosure) with jury demand
2. Civil Case Designation / Cover Sheet (county-specific, required at filing)
3. Praecipe for Service / Instructions for Service to Clerk
4. Summons (issued by the Clerk under Civ.R. 4)
5. Answer with affirmative defenses
6. Counterclaim, cross-claim, third-party complaint
7. Motion for Summary Judgment with supporting affidavit (Civ.R. 56)
8. Notice of Deposition and Subpoena Duces Tecum (Civ.R. 45)
9. Standard discovery sets: interrogatories, requests for production, requests for admission
10. Notice of Dismissal (Civ.R. 41), Agreed Judgment Entry, Certificate of Judgment for lien

Ohio's Rules of Civil Procedure carry an Appendix of Forms that some courts follow, but it is not
an enforced statewide form set the way probate and DR are. ⚠️

### 2.9 Ohio municipal court, eviction and small claims ⚠️

High volume, and almost entirely per-court. Franklin County Municipal Court is the exemplar and
publishes its eviction packet directly (<https://www.fcmcclerk.com/clerk/civil>). ✅

1. Three-Day Notice to Leave Premises (R.C. 1923.04), served before filing
2. Complaint for Eviction, Forcible Entry and Detainer, First Cause (possession) ✅
3. Second Cause (back rent and damages), usually pled in the same complaint
4. Praecipe for service, with bailiff and certified mail options
5. Answer to eviction complaint
6. Motion for Continuance / Motion to Set Aside Default
7. Writ of Restitution and set-out request
8. Small Claims Complaint (jurisdictional limit is per-court)
9. Motion to Transfer from Small Claims to the Regular Docket
10. Post-judgment collection: Certificate of Judgment, 15-day demand letter, Affidavit and Order
    for Wage Garnishment, Bank Attachment

Note ⚠️: Franklin County changed its eviction process to require landlord testimony, which is
exactly the kind of local-practice drift that makes a maintained library valuable and a stale one
dangerous.

### 2.10 Ohio criminal and record sealing ⚠️

Mostly county forms, with Ohio Legal Help providing free guided versions through **Opportunity
Port** ✅.

Application for Sealing of Record of Conviction (R.C. 2953.32), Application for Sealing After
Dismissal or Not Guilty (R.C. 2953.52), Application for Expungement, Certificate of Qualification
for Employment (CQE), Motion for Early Termination of Community Control, Motion to Modify Fines and
Costs, Waiver of Speedy Trial, Motion for Judicial Release, Motion to Suppress, Entry of Plea.

### 2.11 Ohio county overlays ⚠️

Ohio has 88 counties. Each Court of Common Pleas has general, domestic relations, probate and
juvenile divisions, and municipal courts sit underneath. Local rules add cover sheets, standing
orders and division-specific forms on top of the statewide layer.

Coverage priority by population and filing volume:

| County | Seat | Notes |
|---|---|---|
| Franklin | Columbus | Municipal court publishes its own eviction and civil packets ✅ |
| Cuyahoga | Cleveland | Largest common pleas docket; Clerk publishes local civil forms |
| Hamilton | Cincinnati | Clerk of Courts publishes self-help forms including record sealing ✅ |
| Summit | Akron | Separate DR division forms |
| Montgomery | Dayton | |
| Lucas | Toledo | |
| Butler, Stark, Lorain, Warren | | Next tier by volume |

### 2.12 Ohio build order

1. **Probate decedent's estate** (§2.3). Highest volume, fully standardized, statewide.
2. **Domestic relations UDRF** (§2.5). Word source files, so it ships fastest.
3. **Protection orders** (§2.7). Word source files, translations included.
4. **Juvenile UJF** (§2.6) and **guardianship** (§2.4).
5. **Common pleas civil** (§2.8) as firm templates with merge fields.
6. **Franklin and Cuyahoga county overlays**, then eviction and small claims (§2.9).

---

## 3. Other jurisdictions

### 3.1 Federal, U.S. District Court civil ✅

Source: <https://www.uscourts.gov/forms-rules/forms>. Uniform nationally, so one build covers all
94 districts, minus each district's local forms.

1. JS 44, Civil Cover Sheet
2. AO 440, Summons in a Civil Action
3. AO 398 / 399, Notice of Lawsuit and Request to Waive Service, and Waiver of Service
4. AO 85, Notice, Consent, and Reference of a Civil Action to a Magistrate Judge
5. AO 88 / 88A / 88B, Subpoena (hearing or trial, deposition, documents)
6. AO 239, Application to Proceed Without Prepaying Fees (long form)
7. Pro Hac Vice application (district-local)
8. Rule 26(f) Report / Joint Discovery Plan (district-local)
9. AO 133, Bill of Costs
10. AO 450, Judgment in a Civil Action

### 3.2 Federal, U.S. Bankruptcy Court ✅

1. B 101, Voluntary Petition for Individuals
2. B 106 Summary plus Schedules A/B through J
3. B 107, Statement of Financial Affairs for Individuals
4. B 121, Statement About Your Social Security Numbers
5. B 122A-1 / 122C-1, Chapter 7 and Chapter 13 Means Test Calculation
6. B 108, Statement of Intention for Individuals Filing Under Chapter 7
7. B 113, Chapter 13 Plan
8. B 410, Proof of Claim
9. B 427, Cover Sheet for Reaffirmation Agreement
10. B 2030, Disclosure of Compensation of Attorney for Debtor

### 3.3 California Superior Court, civil ✅

Source: <https://courts.ca.gov/forms-rules>, the best-structured library in the country after
Ohio's for our purposes, though the forms are AcroForm PDFs rather than Word.

1. CM-010, Civil Case Cover Sheet
2. SUM-100, Summons
3. PLD-C-001 / PLD-PI-001, Complaint (Contract, Personal Injury)
4. POS-010, Proof of Service of Summons
5. POS-030 / POS-040, Proof of Service by First-Class Mail
6. MC-030 / MC-031, Declaration and Attached Declaration
7. CIV-110, Request for Dismissal
8. CM-110, Case Management Statement
9. CIV-100, Request for Entry of Default
10. MC-050, Substitution of Attorney

### 3.4 California Superior Court, family law ⚠️

FL-100 Petition ✅, FL-110 Summons, FL-115 Proof of Service, FL-120 Response, FL-140 and FL-142
Declaration of Disclosure and Schedule of Assets and Debts, FL-150 Income and Expense Declaration,
FL-105 UCCJEA Declaration, FL-300 Request for Order, FL-341 Custody and Visitation Order
Attachment, FL-180 Judgment.

### 3.5 California Superior Court, probate ⚠️

DE-111 Petition for Probate, DE-121 Notice of Petition to Administer Estate, DE-147 Duties and
Liabilities of Personal Representative, DE-140 Order for Probate, DE-150 Letters, DE-157 Notice of
Administration to Creditors, DE-160 Inventory and Appraisal, DE-172 Creditor's Claim, DE-260 Report
of Sale, DE-295 Ex Parte Petition for Final Discharge.

### 3.6 Los Angeles County local ⚠️

LACIV 109 Civil Case Cover Sheet Addendum ✅ (required by Local Rule 2.3 on every new civil filing),
LACIV 190 Stipulation to ADR, LACIV 229 Stipulation for Early Organizational Meeting ✅, LACIV 271
Voluntary Efficient Litigation Stipulations, LACIV 175 Notice of Case Assignment, LACIV 132
Application to Appear as Counsel Pro Hac Vice, LACIV 105 Peremptory Challenge (CCP 170.6), LAFL 320
Family Law Stipulation and Order, informal discovery conference forms, Personal Injury Court status
conference orders. Index: <https://www.lacourt.ca.gov/pages/lp/fo-forms>

### 3.7 New York Supreme Court, civil ⚠️ (UCS-840 series ✅)

Source: <https://www.nycourts.gov/forms/>. The site blocks automated fetching, so download manually.

1. UCS-840, Request for Judicial Intervention, plus 840A general, 840C commercial, 840F foreclosure
   and 840M matrimonial addenda ✅
2. Summons with Notice, or Summons and Complaint
3. Notice of Appearance
4. Affidavit of Service
5. Notice of Motion plus supporting Affirmation
6. Order to Show Cause
7. Preliminary Conference Stipulation and Order
8. Note of Issue / Certificate of Readiness
9. Stipulation of Discontinuance
10. Judgment and Notice of Entry

New York's uncontested divorce packet is a separate high-volume set: UD-1 Summons with Notice, UD-2
Verified Complaint, UD-6 Affidavit of Plaintiff, UD-9 Findings of Fact, UD-10 Judgment of Divorce,
UD-11 Part 130 Certification, UD-13 Uncontested Divorce RJI ✅, Child Support Worksheet, Notice of
Entry, DOH-2168 Certificate of Dissolution. ⚠️

### 3.8 Texas district and county courts ⚠️

Source: <https://www.txcourts.gov/forms/> plus <https://texaslawhelp.org>. Thin statewide, heavy at
the county and JP level.

1. Civil Case Information Sheet (statewide, required at filing)
2. Original Petition (divorce, debt claim, personal injury)
3. Citation request
4. Return of Service / Affidavit of Service
5. Original Answer, General Denial
6. Waiver of Service
7. Standing and Temporary Orders (county-specific)
8. Final Decree of Divorce (Supreme Court uncontested set, no children and no property) ✅
9. Income Withholding for Support (OAG form)
10. Statewide standardized Protective Order forms (OCA, mandatory since 2023, replacing the
    repealed Supreme Court set) ✅

Justice-of-the-peace practice (eviction, small claims up to $20k) is separate and high volume:
Petition for Eviction, Notice to Vacate, Answer, Writ of Possession, Small Claims Petition. See the
[TJCTC forms library](https://www.tjctc.org/tjctc-resources/forms.html).

### 3.9 Florida Circuit Court, family ⚠️ (12.9xx numbering ✅)

Florida publishes these in **RTF as well as PDF**, so like Ohio it templatizes cleanly.

1. 12.901(b)(1), Petition for Dissolution with Dependent or Minor Children ✅
2. 12.901(b)(2), Petition for Dissolution with Property but No Children
3. 12.902(b) and (c), Family Law Financial Affidavit, short and long form ✅
4. 12.902(d), UCCJEA Affidavit ✅
5. 12.902(e), Child Support Guidelines Worksheet ✅
6. 12.902(f)(1), Marital Settlement Agreement ✅
7. 12.902(j), Notice of Social Security Number ✅
8. 12.910(a), Summons: Personal Service on an Individual
9. 12.903(a), Answer, or Answer and Counterpetition
10. 12.990(c), Final Judgment of Dissolution of Marriage

### 3.10 Illinois Circuit Court ⚠️ (statewide standardized set ✅)

Appearance, Complaint (Small Claims, Eviction, Divorce), Summons, Proof of Service, Fee Waiver
Application, Motion plus Notice of Motion, Financial Affidavit, Petition for Dissolution of
Marriage, Eviction Order, Order of Protection petition. All from the
[approved statewide standardized forms](https://www.illinoiscourts.gov/documents-and-forms/approved-forms/),
which every circuit must accept.

Cook County adds a local layer ⚠️: Civil Division Action Cover Sheet, CCG Appearance, CCM 751 Small
Claims Summons ✅, Eviction Summons, Alias Summons, Affidavit of Service, Notice of Motion, CCG
Order, Wage Deduction Notice, Certificate of Attorney. Index:
<https://services.cookcountyclerkofcourt.org/forms/>

---

## 4. The next tier of states ⚠️

Each has an AOC forms portal with an equivalent top 10, worth scoping after Ohio and the big five.
Two stand out as unusually well-organized and would be easy follow-ups:

- **Michigan** ✅ has the **SCAO** set, arguably the cleanest numbering scheme in the country: `MC`
  general use (MC 01 Summons, MC 10 Judgment), `DC` district court, `CC` circuit court, `FOC`
  Friend of the Court (FOC 100 Domestic Relations Judgment Information), `PC` probate. All courts
  must accept SCAO-approved forms. Indexes at
  <https://www.courts.michigan.gov/scao-forms/>.
- **North Carolina** ✅ has the `AOC-CV` civil, `AOC-CVM` small claims, `AOC-E` estates, `AOC-SP`
  special proceedings and `AOC-CR` criminal series, all indexed at
  <https://www.nccourts.gov/documents/forms>. AOC-CV-100 Civil Summons and AOC-CV-102 Alias and
  Pluries Summons are the highest-volume items.

| State | Portal | Highest-volume set |
|---|---|---|
| Arizona (Maricopa) | azcourts.gov, superiorcourt.maricopa.gov | Family law, eviction, probate |
| Georgia (Fulton) | georgiacourts.gov | Domestic relations, dispossessory |
| Washington (King) | courts.wa.gov/forms | Mandatory statewide family and civil pattern forms |
| New Jersey | njcourts.gov/forms | Special civil part, landlord-tenant |
| Pennsylvania (Philadelphia) | pacourts.us | Orphans' court, civil cover sheets |
| Massachusetts | mass.gov/courtforms | Probate and family, housing court |
| Nevada (Clark) | nvcourts.gov | Family, eviction |
| Indiana | in.gov/courts/forms | Protection orders, small claims |

---

## 5. Firm-side documents (no court publishes these, we author them)

Jurisdiction-agnostic, high value, and the fastest thing to ship because there is no form-number
maintenance burden. Fee agreements are the exception: contingency-fee terms and required
disclosures are governed by each state's Rules of Professional Conduct, so those need per-state
variants. For an Ohio-first launch that means checking the Ohio Rules of Professional Conduct 1.5.

1. Engagement and retainer agreement (hourly, flat fee, contingency)
2. Non-engagement letter and declination letter
3. Conflict waiver and joint representation consent
4. Client intake questionnaire
5. Fee agreement amendment
6. Demand letter (pre-litigation)
7. Settlement agreement and general release
8. Litigation hold notice
9. Discovery sets: interrogatories, requests for production, requests for admission
10. Deposition notice and subpoena duces tecum
11. Authorization for release of records (HIPAA-compliant variant)
12. Closing and file-transfer letter, with record-retention notice
13. Trust and IOLTA documents: trust receipt, disbursement authorization, three-way reconciliation
    cover sheet (ties into the existing trust module)

---

## 6. Licensing, read before shipping

This is my read of the landscape, not vetted advice. Confirm with counsel before launch.

- **Federal government works** are uncopyrightable by statute (17 U.S.C. § 105). AO, JS and B forms
  are safe.
- **State court forms** are not automatically public domain, since § 105 covers federal employees
  only. But the **government edicts doctrine** (*Georgia v. Public.Resource.Org*, 2020) holds that
  works created by judges and legislators in their official law-making capacity cannot be
  copyrighted, and forms *promulgated by a supreme court as mandatory* sit squarely in that
  reasoning. Ohio's are promulgated by the Supreme Court of Ohio under the Rules of
  Superintendence, published free in editable Word format, and explicitly intended for use by
  litigants and courts statewide, which is about as favorable a fact pattern as exists.
- **Do not scrape or re-host Tier 3.** US Legal Forms, Rocket Lawyer, Nolo and LawDepot content is
  proprietary and their terms of service forbid it. Same for competitor form libraries.
- **UPL and disclaimers.** Shipping filled-in legal documents to firms is fine, since the firm is
  the lawyer. Still worth a per-template "verify against current local rules before filing" notice
  plus a visible `last verified` date. Stale form versions get rejected at the clerk's window and
  that becomes our support burden.
- **Attribution.** MIT-licensed Document Assembly Line content requires the license notice to
  travel with it.

---

## 7. What competitors ship

- **Clio Draft** (formerly Lawyaw), automated fillable court forms for all 50 states, populated
  from matter data, sold as a separate product alongside Clio Manage.
- **Smokeball**, native automated court form library, same pitch.
- **Gavel / Documate**, document automation platform where firms build their own.
- Everyone else (MyCase, PracticePanther, Filevine) ships generic document automation and leans on
  integrations for actual court forms.

Court-form automation is a paid upsell at Clio and a differentiator at Smokeball. Bundling even a
good Ohio-only starter set into Paralegix is a real wedge, but the moat is maintenance, not initial
coverage.

---

## 8. What this means for the Paralegix templates module

The current module (`templates` and `template_folders`, see [Templates](/templates/overview))
handles HTML and DOCX with `{placeholder}` fields and repeaters.

**Ohio's Word forms fit that pipeline today.** The DR, juvenile and protection order forms can be
uploaded as DOCX, have their blanks converted to `{placeholder}` fields, and ship without any new
fill engine. That is the entire argument for going Ohio-first.

Two gaps remain for everything else.

1. **Fillable-PDF (AcroForm) filling is a different mechanism.** Most states' forms, including
   California's and Ohio's own probate set, are AcroForm PDFs with fixed field names. You fill named
   fields and flatten, you do not do text substitution. That is a new fill path plus a per-form
   field-mapping table (`pdf_field_name` to Paralegix data path).
2. **Versioning and staleness.** Every form carries a revision date and courts reject superseded
   revisions. A shipped library needs `form_version` and `last_verified_at` per template, plus some
   way to detect upstream changes.

Also worth deciding early: are preset templates **firm-owned rows** copied into each firm on
signup, or a **global catalog** the firm references and can fork? The latter is the only version
that stays maintainable, and it changes the schema (a global `template_catalog` table separate from
the per-firm `templates` table), plus a jurisdiction dimension on the catalog so an Ohio firm does
not see California forms.

Suggested sequencing:

- **Phase 1**, the 13 firm-side documents in §5. No court dependency, immediate value, exercises
  the merge-field system.
- **Phase 2**, Ohio DR, juvenile and protection orders (§2.5 to §2.7). Word sources, no new fill
  engine needed.
- **Phase 3**, build the AcroForm fill path, then Ohio probate (§2.3, §2.4).
- **Phase 4**, federal civil and bankruptcy (§3.1, §3.2). Uniform nationally, so one build covers
  every district.
- **Phase 5**, California, then FL, NY, TX, IL, with county overlays for Franklin, Cuyahoga, LA and
  Cook.

---

## 9. Open questions

- Ship **blank** court forms, or **pre-filled** from matter and client data? Pre-filled is the whole
  value proposition but requires the field-mapping work in §8.
- Is Ohio actually where our customers are? The Word-format argument is strong, but if the early
  firm base is elsewhere, California-first plus the AcroForm work may be the better trade.
- Buy vs. build: license an existing form library, or maintain our own? Maintenance is the real
  cost.
- Do we need per-state fee-agreement variants at launch, or is Ohio RPC 1.5 plus a "check your
  state's rules" note acceptable for v1?
- Does an integration with Clio Draft or a forms vendor make more sense than owning this?
