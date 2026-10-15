import { UserRound, BriefcaseBusiness, Building2, Users, CalendarDays, type LucideIcon } from "lucide-react";

/** The firm/client/matter/date auto-fill catalog offered by `PlaceholderModal`
 *  and `OverlayFieldChipPopover`: the fixed set of fields every template
 *  (html/docx/overlay) can pull from without the user typing a custom one. */
export interface SuggestionGroup {
  label: string;
  icon: LucideIcon;
  fields: { id: string; description: string }[];
}

export const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "Client",
    icon: UserRound,
    fields: [
      { id: "client_name", description: "Full name" },
      { id: "client_first_name", description: "First name" },
      { id: "client_last_name", description: "Last name" },
      { id: "client_email", description: "Email address" },
      { id: "client_phone", description: "Phone number" },
      { id: "client_address", description: "Mailing address" },
      { id: "client_organization", description: "Company / organization" },
      { id: "client_preferred_contact_method", description: "Preferred contact method" },
      { id: "client_status", description: "Client status" },
    ],
  },
  {
    label: "Company",
    icon: Users,
    fields: [
      { id: "company_primary_contact_name", description: "Primary contact name" },
      { id: "company_billing_contact_name", description: "Billing contact name" },
      { id: "company_billing_contact_email", description: "Billing contact email" },
    ],
  },
  {
    label: "Matter",
    icon: BriefcaseBusiness,
    fields: [
      { id: "case_name", description: "Matter / matter name" },
      { id: "case_number", description: "Matter number" },
      { id: "case_reference_id", description: "Reference ID" },
      { id: "case_description", description: "Description" },
      { id: "case_status", description: "Status" },
      { id: "practice_area", description: "Practice area" },
      { id: "charge_code", description: "Charge code" },
      { id: "case_category", description: "Category" },
      { id: "lead_attorney", description: "Lead attorney name" },
    ],
  },
  {
    label: "Law Firm",
    icon: Building2,
    fields: [
      { id: "firm_name", description: "Firm name" },
      { id: "firm_address", description: "Street address" },
      { id: "firm_city", description: "City" },
      { id: "firm_state", description: "State" },
      { id: "firm_zip", description: "Postal code" },
      { id: "firm_full_address", description: "Full address (street, city, state, zip)" },
      { id: "firm_phone", description: "Phone number" },
      { id: "firm_email", description: "Email address" },
    ],
  },
  {
    label: "Date",
    icon: CalendarDays,
    fields: [
      { id: "date", description: `Today's date (${new Date().toLocaleDateString()})` },
      { id: "full_date", description: `Full date (${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })})` },
      { id: "year", description: `Current year (${new Date().getFullYear()})` },
      { id: "month", description: `Current month (${new Date().toLocaleDateString(undefined, { month: "long" })})` },
      { id: "day", description: `Day of month (${new Date().getDate()})` },
    ],
  },
];
