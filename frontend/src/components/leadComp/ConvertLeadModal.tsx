"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { useNavigation } from "@/contexts/NavigationContext";
import MatterPracticeAreaField from "@/components/matterComp/matterForm/MatterPracticeAreaField";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import leadsService from "@/services/leads.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { Lead } from "@/types";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import ClientOrganizationAutocomplete from "@/components/clientComp/ClientOrganizationAutocomplete";
import { track } from "@/lib/analytics/analytics";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  lead: Lead;
  onAfter?: () => Promise<void> | void;
};

const CLIENT_TYPE_OPTIONS: DropdownOption[] = [
  { label: "Person", value: "person" },
  { label: "Organization", value: "company" },
];

export default function ConvertLeadModal({ open, onClose, lawFirmId, lead, onAfter }: Props) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  // Mounted closed on the lead pages, so the practice areas load on open.
  const { practiceAreas, loading: paLoading, createPracticeArea } = usePracticeAreas(lawFirmId, open);

  const [createMatter, setCreateMatter] = useState(true);
  const [name, setName] = useState("");
  const [practiceAreaId, setPracticeAreaId] = useState("");
  const [clientType, setClientType] = useState<"person" | "company">("person");
  // The organization a company conversion goes into: typed (a new one, or an
  // existing one matched by name on the server) or picked from the firm's
  // organizations, which pins it by id until the name is edited again.
  const [organizationName, setOrganizationName] = useState("");
  const [organizationClientId, setOrganizationClientId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asCompany = clientType === "company";
  const orgName = organizationName.trim();
  const missingOrganization = asCompany && !orgName;

  useSeedOnOpen(open, () => {
    setCreateMatter(true);
    setName(lead.name ? `${lead.name} Matter` : "");
    setPracticeAreaId("");
    setClientType("person");
    setOrganizationName((lead.organization || "").trim());
    setOrganizationClientId(null);
    setError(null);
    setSubmitting(false);
  });

  useResetAfterClose(open, () => {
    setError(null);
    setSubmitting(false);
  });

  const handleSubmit = async () => {
    if (createMatter && !name.trim()) {
      setError("Matter name is required");
      return;
    }
    if (missingOrganization) {
      setError("Organization is required");
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const result = await leadsService.convertLead(lawFirmId, lead.id, {
        createMatter,
        clientType,
        ...(asCompany
          ? organizationClientId ? { organizationClientId } : { organizationName: orgName }
          : {}),
        name: createMatter ? name.trim() : undefined,
        practiceAreaId: createMatter ? practiceAreaId || undefined : undefined,
      });
      track("lead_converted", {
        client_type: clientType,
        created_matter: createMatter,
        has_practice_area: Boolean(practiceAreaId),
      });
      await onAfter?.();
      onClose();
      if (result.matterId) {
        navigate(`/lawfirm/${lawFirmId}/matters/${result.matterId}`);
      } else if (result.clientId) {
        navigate(`/lawfirm/${lawFirmId}/clients/${result.clientId}`);
      }
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to convert lead");
      // Only a failure re-enables the form here. On success the dialog is
      // closing, and `useResetAfterClose` clears the flag once it is gone, so the
      // button does not revert to "Convert" while it fades.
      setSubmitting(false);
    }
  };

  // Opened from the lead dialog as well as from the lead page, so it always
  // stacks: above the dialog when there is one, harmlessly when there is not.
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      stacked
      showClose={false}
      dismissible={!submitting}
      title="Convert to Client"
      subtitle={
        <>
          {!asCompany
            ? `Creates a client from ${lead.name || "this lead"}`
            : organizationClientId
              ? `Adds ${lead.name || "this lead"} to ${orgName}`
              : `Creates an organization client from ${orgName || "the organization you name"}`}
          {createMatter ? " and opens a new matter." : "."}
        </>
      }
      bodyClassName="px-6 py-4 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || (createMatter && !name.trim()) || missingOrganization}
          >
            {submitting ? "Converting…" : "Convert"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

      <Dropdown
        label="Client Type"
        value={clientType}
        onChange={(v) => setClientType(v as "person" | "company")}
        options={CLIENT_TYPE_OPTIONS}
        portal
      />

      {asCompany && (
        <div>
          <FieldLabel htmlFor={`${fieldIds}-organization`}>Organization *</FieldLabel>
          <ClientOrganizationAutocomplete
            id={`${fieldIds}-organization`}
            lawFirmId={lawFirmId}
            value={organizationName}
            onChange={(value) => {
              setOrganizationName(value);
              setOrganizationClientId(null);
            }}
            onSelectCompany={(company) => setOrganizationClientId(company.id)}
            placeholder="Search or name an organization"
            maxLength={200}
          />
          <p className="mt-1 text-xs text-on-surface-muted">
            {organizationClientId
              ? `${lead.name || "This lead"} joins this organization's contacts.`
              : "Pick an existing organization, or type a name to create one."}
          </p>
        </div>
      )}

      <Checkbox
        checked={createMatter}
        onChange={setCreateMatter}
        label="Also create a matter"
        description="Uncheck to convert to a client only. You can add a matter later."
      />

      {createMatter && (
        <>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-name`}>Matter name *</FieldLabel>
            <TextInput
              id={`${fieldIds}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Matter name"
              required
            />
          </div>

          <MatterPracticeAreaField
            value={practiceAreaId}
            onChange={setPracticeAreaId}
            practiceAreas={practiceAreas}
            loading={paLoading}
            createPracticeArea={createPracticeArea}
            firmId={lawFirmId}
          />
        </>
      )}
    </Modal>
  );
}
