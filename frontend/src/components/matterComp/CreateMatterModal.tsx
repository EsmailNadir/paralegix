"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Users } from "lucide-react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";

import CategoryTreeSelect from "@/components/ui/CategoryTreeSelect";
import MattersService from "@/services/matters.service";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import useCourts from "@/hooks/courtHooks/useCourts";
import { useAuth } from "@/hooks/useAuth";
import ErrorNotification from "@/components/ErrorNotification";
import ErrorToast from "@/components/ui/ErrorToast";
import ConflictCheckBanner from "@/components/matterComp/ConflictCheckBanner";
import MatterPracticeAreaField from "@/components/matterComp/matterForm/MatterPracticeAreaField";
import MatterCourtField from "@/components/matterComp/matterForm/MatterCourtField";
import MatterMemberPicker from "@/components/matterComp/matterForm/MatterMemberPicker";
import MatterClientPicker from "@/components/matterComp/matterForm/MatterClientPicker";

import { useDuplicateNameCheck, useEntityByIds } from "@/hooks/useEntityLookup";
import { validateRequiredFields, ValidationField } from "@/utils/formValidation";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import type { PreferredContactMethod, User } from "@/types";
import UpgradePrompt, { parsePlanLimitError } from "@/components/subscriptionComp/UpgradePrompt";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { PlanLimitErrorDetails } from "@/types/subscription";
import FormStepIndicator from "@/components/ui/FormStepIndicator";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import FieldLabel from "@/components/ui/FieldLabel";
import ClientFields from "@/components/clientComp/ClientFields";
import TextInput from "@/components/ui/TextInput";
import Textarea from "@/components/ui/Textarea";
import StepModalFooter from "@/components/ui/StepModalFooter";
import { track } from "@/lib/analytics/analytics";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  users: User[];
  onAfter?: () => Promise<void> | void;
  initialClientId?: string;
};

type ClientInput = {
  id?: string;
  clientId?: string;
  name: string;
  email?: string;
  phone?: string;
  organization?: string;
  /**
   * 'company' when this row is an ORGANIZATION client. Its legal name lives in
   * `name` and `organization` stays empty, so the conflict check has to be told
   * which of its two search sets that name belongs in.
   */
  clientType?: 'person' | 'company';
  address?: string;
  preferredContactMethod?: string;
  inviteToPortal?: boolean;
};

const MATTER_STEPS = [
  { label: "Clients" },
  { label: "Matter Details" },
  { label: "Team" },
];

export default function CreateMatterModal({ open, onClose, lawFirmId, users, onAfter, initialClientId }: Props) {
  const fieldIds = useId();
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  // matter fields
  const [title, setTitle] = useState("");
  const [matterNumber, setMatterNumber] = useState("");
  const [description, setDescription] = useState("");
  const [practiceAreaId, setPracticeAreaId] = useState<string>("");
  const [category, setCategory] = useState("");
  const [courtId, setCourtId] = useState<string>("");
  const [leadUserIds, setLeadUserIds] = useState<string[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [allMembersInitialized, setAllMembersInitialized] = useState(false);

  // structured clients
  const [clients, setClients] = useState<ClientInput[]>([]);

  const initialClientAddedRef = useRef(false);

  // new client form
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClient, setNewClient] = useState<ClientInput>({
    name: "", email: "", phone: "", organization: "", address: "", preferredContactMethod: "none",
  });
  const [savingNewClient, setSavingNewClient] = useState(false);
  const [newClientError, setNewClientError] = useState<string | null>(null);

  // state
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  useResetAfterClose(open, () => {
    setNewClientError(null);
    setInlineError(null);
  });
  const [planLimitDetails, setPlanLimitDetails] = useState<PlanLimitErrorDetails | null>(null);
  // Set when the matter was created but its team could not be added. Shown as a
  // toast outside the dialog, so it outlives the modal closing on success.
  const [teamNotice, setTeamNotice] = useState<string | null>(null);
  const titleId = useId();

  // data
  const firmId = (lawFirmId ?? "").trim();
  // Mounted closed wherever it is offered, so the practice area picker's list
  // loads when the modal first opens (the cache key is shared).
  const { practiceAreas, loading: paLoading, error: paError, createPracticeArea } = usePracticeAreas(firmId, open);
  // Mounted closed on every page that offers it, so the court picker's list
  // loads when the modal first opens (the cache key is shared).
  const { courts, loading: courtsLoading, createCourt } = useCourts(firmId, open);
  const { user: currentUser } = useAuth();
  const hasBlockingError = !!paError;
  const firmMissing = !firmId;
  const { duplicate: duplicateMatter } = useDuplicateNameCheck("matters", firmId, title, { enabled: open });
  const { duplicate: duplicateNewClient } = useDuplicateNameCheck("clients", firmId, newClient.name, {
    enabled: open && showNewClientForm,
  });

  const reset = () => {
    setCurrentStep(1);
    setMaxStepReached(1);
    setTitle("");
    setMatterNumber("");
    setDescription("");
    setPracticeAreaId("");
    setCategory("");
    setCourtId("");
    setLeadUserIds([]);
    setMemberUserIds([]);
    setClients([]);
    setShowNewClientForm(false);
    setNewClient({ name: "", email: "", phone: "", organization: "", address: "", preferredContactMethod: "none", inviteToPortal: false });
    setSavingNewClient(false);
    setNewClientError(null);
    setInlineError(null);
    setAllMembersInitialized(false);
  };

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets modal form state when it closes
      reset();
      initialClientAddedRef.current = false;
    }
  }, [open]);

  // Seeds initialClientId on every open, once the server lookup resolves it.
  // The lookup is cached after the first open, so this keys on `open` as well
  // as the result: a second open sees the same result and must still seed.
  const { items: initialClientItems } = useEntityByIds("clients", firmId, initialClientId ? [initialClientId] : []);
  useEffect(() => {
    if (!open || !initialClientId || initialClientAddedRef.current) return;
    const item = initialClientItems.find((i) => i.id === initialClientId);
    if (item) {
      initialClientAddedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the initial client once the server resolves it
      setClients([{
        id: `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        clientId: item.id,
        name: item.label,
        email: typeof item.sublabel === "string" ? item.sublabel : "",
        phone: "",
        organization: "",
        address: "",
        preferredContactMethod: "none",
      }]);
    }
  }, [open, initialClientItems, initialClientId]);

  // Initialize the creator as the sole member and lead. Additional team access
  // is selected deliberately in the Team stage.
  useEffect(() => {
    if (open && users.length > 0 && !allMembersInitialized && currentUser?.uid) {
      // Default the creator to lead when the modal opens; other members can be
      // toggled as additional leads in the team list.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes member/lead selection when the modal opens and users load
      setLeadUserIds([currentUser.uid]);

      setMemberUserIds([currentUser.uid]);
      setAllMembersInitialized(true);
    }
  }, [open, users, allMembersInitialized, currentUser?.uid]);

  const addedClientIds = clients.map((c) => c.clientId).filter((id): id is string => !!id);

  const addExistingClient = (existing: { id: string; name: string; email: string; clientType?: 'person' | 'company' | null }) => {
    setClients((prev) => [
      ...prev,
      {
        id: `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        clientId: existing.id,
        name: existing.name,
        email: existing.email,
        clientType: existing.clientType ?? undefined,
        phone: "",
        organization: "",
        address: "",
        preferredContactMethod: "none",
      },
    ]);
  };

  const openNewClientForm = () => {
    setShowNewClientForm(true);
    setNewClient({ name: "", email: "", phone: "", organization: "", address: "", preferredContactMethod: "none", inviteToPortal: false });
    setNewClientError(null);
  };

  const cancelNewClientForm = () => {
    setShowNewClientForm(false);
    setNewClient({ name: "", email: "", phone: "", organization: "", address: "", preferredContactMethod: "none", inviteToPortal: false });
    setNewClientError(null);
  };

  const saveNewClient = async () => {
    if (!newClient.name.trim()) {
      setNewClientError("Client name is required.");
      return;
    }
    if (newClient.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newClient.email.trim())) {
      setNewClientError("Please enter a valid email address.");
      return;
    }
    if (savingNewClient) return;

    try {
      setSavingNewClient(true);
      setNewClientError(null);

      const contactMethod = newClient.preferredContactMethod;
      const validContactMethods = ["email", "phone", "sms", "portal"];

      const { default: clientsService } = await import("@/services/clients.service");
      const result = await clientsService.createClient(firmId, {
        name: newClient.name.trim(),
        email: newClient.email?.trim() || undefined,
        phone: newClient.phone?.trim() || undefined,
        organization: newClient.organization?.trim() || undefined,
        address: newClient.address?.trim() || undefined,
        // "None" goes out as null so the client is stored with no preference;
        // leaving the field out would take the server's 'email' default.
        preferredContactMethod: contactMethod && validContactMethods.includes(contactMethod) ? (contactMethod as PreferredContactMethod) : null,
        portalInvitePending: newClient.inviteToPortal === true && !!newClient.email?.trim(),
      });

      const savedName = newClient.name.trim();
      const savedEmail = newClient.email?.trim() || "";

      // Add to selected clients list
      setClients((prev) => [
        ...prev,
        {
          id: `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          clientId: result.clientId,
          name: savedName,
          email: savedEmail,
          phone: newClient.phone?.trim() || "",
          organization: newClient.organization?.trim() || "",
          address: newClient.address?.trim() || "",
          preferredContactMethod: newClient.preferredContactMethod || "none",
        },
      ]);

      cancelNewClientForm();
      if (result.portalStatus === "invite_failed") {
        // The client exists and is queued; only the invite email failed.
        setInlineError("The client was added, but the portal invite email could not be sent. Resend the invite from the client's page.");
      }
    } catch (err) {
      setNewClientError(getErrorMessage(err, "Failed to save client. Please try again."));
    } finally {
      setSavingNewClient(false);
    }
  };

  const removeClient = (index: number) => {
    setClients((prev) => prev.filter((_, i) => i !== index));
  };

  const addMember = (userId: string) => {
    if (!memberUserIds.includes(userId)) {
      setMemberUserIds((prev) => [...prev, userId]);
    }
  };

  const removeMember = (userId: string) => {
    // The current user always stays on the team. Removing anyone else also clears
    // their lead status so a lead can't linger without being a member.
    if (userId === currentUser?.uid) {
      return;
    }
    setMemberUserIds((prev) => prev.filter((id) => id !== userId));
    setLeadUserIds((prev) => prev.filter((id) => id !== userId));
  };

  // Toggle a team member's lead (responsible-attorney) status. Any number of
  // members can be leads.
  const toggleLead = (userId: string) => {
    setLeadUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const toggleAllMembers = () => {
    if (memberUserIds.length === users.length) {
      // All are selected, deselect all but the current user, and drop lead status
      // from anyone no longer on the team.
      const requiredIds = users
        .filter((user) => user.uid === currentUser?.uid)
        .map((user) => user.uid);
      setMemberUserIds(requiredIds);
      setLeadUserIds((prev) => prev.filter((id) => requiredIds.includes(id)));
    } else {
      // Not all are selected, select all
      setMemberUserIds(users.map(user => user.uid));
    }
  };

  const submit = async () => {
    if (firmMissing) {
      setInlineError("Unable to create matter. Please refresh the page and try again.");
      return;
    }
    if (submitting) return;

    // Validate required fields
    const validationFields: ValidationField[] = [
      { name: 'title', value: title, required: true, label: 'Title' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setInlineError(validationError);
      return;
    }

    try {
      setSubmitting(true);
      setInlineError(null);

      const payload: any = {
        lawFirmId: firmId,
        name: title.trim(),
        matterNumber: matterNumber.trim() || undefined,
        description: description.trim(),
        category: category.trim() || undefined,
      };

      if (practiceAreaId) {
        const paName = practiceAreas.find((p) => p.id === practiceAreaId)?.name ?? null;
        payload.practiceAreaId = practiceAreaId.trim();
        payload.practiceAreaName = paName;
      }

      if (courtId) {
        const courtData = courts.find((c) => c.id === courtId);
        payload.courtId = courtId.trim();
        payload.courtName = courtData?.name ?? null;
      }

      if (clients.length) {
        payload.clients = clients.map((c) => ({
          ...c,
          name: c.name.trim(),
          email: c.email?.trim() || "",
          phone: c.phone?.trim() || "",
          organization: c.organization?.trim() || "",
          address: c.address?.trim() || "",
          preferredContactMethod:
            c.preferredContactMethod && c.preferredContactMethod !== "none"
              ? c.preferredContactMethod
              : undefined,
        }));
      }

      // Send the full lead set to the create endpoint. When it's empty the backend
      // defaults the creator to the sole lead.
      if (leadUserIds.length > 0) {
        payload.leadUserIds = leadUserIds;
      }

      const createRes = await MattersService.createMatter(payload);

      // Add members (always include current user + selected members)
      const allMemberIds = [...memberUserIds];
      if (currentUser?.uid && !allMemberIds.includes(currentUser.uid)) {
        allMemberIds.push(currentUser.uid);
      }

      if (allMemberIds.length > 0) {
        try {
          await MattersService.addMembers({
            lawFirmId: firmId,
            matterId: createRes.matterId,
            targetUserIds: allMemberIds,
          });
        } catch (memberErr) {
          // The matter exists, so the wizard still finishes (staying open would
          // invite a second create). The firm is told the team was not added.
          setTeamNotice(
            `The matter was created, but its team could not be added: ${getErrorMessage(memberErr, "Failed to add members")}. Add them from the matter's Team tab.`,
          );
        }
      }

      track("matter_created", {
        client_count: clients.length,
        team_member_count: allMemberIds.length,
        has_practice_area: Boolean(practiceAreaId),
        has_court: Boolean(courtId),
        has_category: Boolean(category.trim()),
      });

      // The caller closes the modal, often after awaiting a refresh, and closing
      // empties the form. Emptying it here instead would flip the wizard back
      // to a blank first step while that refresh is still running.
      await onAfter?.();
    } catch (err) {
      const limitDetails = parsePlanLimitError(err);
      if (limitDetails) {
        setPlanLimitDetails(limitDetails);
      } else {
        setInlineError(getErrorMessage(err, "Failed to create matter. Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const continueToNextStep = () => {
    setInlineError(null);

    if (currentStep === 2) {
      const validationError = validateRequiredFields([
        { name: "title", value: title, required: true, label: "Title" },
      ]);
      if (validationError) {
        setInlineError(validationError);
        return;
      }
    }

    setCurrentStep((step) => {
      const next = Math.min(step + 1, MATTER_STEPS.length);
      setMaxStepReached((max) => Math.max(max, next));
      return next;
    });
  };

  return (
    <>
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!submitting && !savingNewClient}
      labelledBy={titleId}
      lockScroll
      size="2xl"
      height="steps"
      footerAlign="between"
      showClose={false}
      bodyClassName={null}
      footer={
        // The banners sit directly above the buttons, so a failed save is read
        // where the user just clicked and not scrolled out of view in the body.
        <div className="w-full">
          <ErrorNotification
            error={hasBlockingError ? paError : null}
            compact
            className="mb-3"
          />
          <ErrorNotification
            error={inlineError}
            onClose={() => setInlineError(null)}
            compact
            className="mb-3"
          />
          <div className="flex items-center justify-between gap-2">
            <StepModalFooter
              currentStep={currentStep}
              stepCount={MATTER_STEPS.length}
              onCancel={onClose}
              onBack={() => setCurrentStep((step) => step - 1)}
              onContinue={continueToNextStep}
              continueDisabled={firmMissing || (currentStep === 2 && !title.trim())}
              busy={submitting || savingNewClient}
              submit={{
                onClick: submit,
                loading: submitting,
                disabled: submitting || hasBlockingError || firmMissing || !title.trim(),
                label: submitting ? "Creating..." : "Create",
              }}
            />
          </div>
        </div>
      }
    >
          <div className="flex items-center justify-between px-6 py-4 border-b border-outline">
            <h2 id={titleId} className="text-lg font-semibold text-on-surface">Create a New Matter</h2>
          </div>

          <FormStepIndicator
            steps={MATTER_STEPS}
            currentStep={currentStep}
            maxStepReached={maxStepReached}
            onStepClick={setCurrentStep}
            disabled={submitting || savingNewClient}
          />

          <div className="flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar px-6 py-5 space-y-5">
            {currentStep === 2 && <>
            {/* title */}
            <div>
              <FieldLabel htmlFor={`${fieldIds}-title`}>Matter Title *</FieldLabel>
              <TextInput
                id={`${fieldIds}-title`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a title"
              />
              <DuplicateNameWarning duplicateName={duplicateMatter?.label} entityLabel="matter" />
            </div>

            {/* matter number */}
            <div>
              <FieldLabel htmlFor={`${fieldIds}-matternumber`}>Matter Number</FieldLabel>
              <TextInput
                id={`${fieldIds}-matternumber`}
                value={matterNumber}
                onChange={(e) => setMatterNumber(e.target.value)}
                placeholder="Enter a matter number (e.g., 2024-001)"
              />
            </div>

            {/* description */}
            <div>
              <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
              <Textarea
                id={`${fieldIds}-description`}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
              />
            </div>

            {/* practice area */}
            <MatterPracticeAreaField
              value={practiceAreaId}
              onChange={setPracticeAreaId}
              practiceAreas={practiceAreas}
              loading={paLoading}
              createPracticeArea={createPracticeArea}
              firmId={firmId}
              disabled={firmMissing}
            />

            {/* court */}
            <MatterCourtField
              value={courtId}
              onChange={setCourtId}
              courts={courts}
              loading={courtsLoading}
              createCourt={createCourt}
              firmId={firmId}
              disabled={firmMissing}
            />

            {/* category */}
            <div>
              <FieldLabel>Category</FieldLabel>
              <CategoryTreeSelect
                value={category}
                onChange={setCategory}
                placeholder="Select or create a category"
                disabled={firmMissing}
                lawFirmId={firmId}
              />
              <p className="text-xs text-on-surface-secondary mt-1">
                First, type a category name to search. Then select a matching category, or choose Create to add it if no match exists. To add a subcategory, use the <span className="text-accent-emphasis">+</span> next to its parent category.
              </p>
            </div>

            </>}

            {/* Members */}
            {currentStep === 3 && (
            <MatterMemberPicker
              users={users}
              memberUserIds={memberUserIds}
              leadUserIds={leadUserIds}
              currentUserId={currentUser?.uid}
              onAdd={addMember}
              onRemove={removeMember}
              onToggleLead={toggleLead}
              onToggleAll={toggleAllMembers}
              disabled={firmMissing}
              subtitle="Toggle Lead to mark responsible attorneys. You are set as the default lead."
              emptyState={
                <div className="rounded-lg border-2 border-dashed border-outline p-3 text-center bg-surface-alt">
                  <div className="w-8 h-8 mx-auto mb-2 bg-surface-alt rounded-full flex items-center justify-center">
                    <Users size={16} className="text-on-surface-muted" aria-hidden="true" />
                  </div>
                  <p className="text-xs text-on-surface-secondary mb-1">All team members have been deselected</p>
                  <p className="text-xs text-on-surface-muted">Use &quot;Select All&quot; to add all members, or use the dropdown to add specific members</p>
                </div>
              }
            />
            )}
            {currentStep === 1 && (
            <div className="rounded-lg border border-outline p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-on-surface">Clients</h3>
                {!showNewClientForm && (
                  <Button type="secondary" size="small" onClick={openNewClientForm}>
                    + New Client
                  </Button>
                )}
              </div>

              {/* Existing client search */}
              {!showNewClientForm && (
                <div>
                  <FieldLabel>
                    Select Existing Client
                  </FieldLabel>
                  <MatterClientPicker lawFirmId={firmId} excludeIds={addedClientIds} onSelect={addExistingClient} />
                </div>
              )}

              {/* New client form */}
              {showNewClientForm && (
                <div className="rounded-md border border-outline p-4 bg-surface-alt space-y-3">
                  <h4 className="text-sm font-medium text-on-surface">New Client</h4>
                  <ErrorNotification error={newClientError} onClose={() => setNewClientError(null)} />
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <ClientFields lawFirmId={firmId} idPrefix={fieldIds} values={newClient}
                      nameId={`${fieldIds}-newclient`} addressId={`${fieldIds}-street-city-state-zip`}
                      organizationId={`${fieldIds}-company-org`} addressClassName="md:col-span-2"
                      duplicateName={duplicateNewClient?.label}
                      onChange={(field, value) => setNewClient((p) => ({ ...p, [field]: value }))} />
                  </div>
                  {newClient.email?.trim() && (
                    <div className="space-y-1">
                      <Checkbox
                        checked={newClient.inviteToPortal === true}
                        onChange={(checked) => setNewClient((p) => ({ ...p, inviteToPortal: checked }))}
                        label="Invite to client portal"
                      />
                      {newClient.inviteToPortal && (
                        <p className="text-xs text-on-surface-muted pl-6">
                          An email will be sent to {newClient.email?.trim()} inviting them to create a Paralegix client portal account.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex justify-end gap-2 pt-1">
                    <Button type="secondary" size="small" onClick={cancelNewClientForm} disabled={savingNewClient}>
                      Cancel
                    </Button>
                    <Button type="primary" size="small" onClick={saveNewClient} loading={savingNewClient} disabled={savingNewClient}>
                      {savingNewClient ? "Saving..." : "Save Client"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Selected clients list */}
              {clients.length === 0 && !showNewClientForm && (
                <div className="rounded border border-dashed border-outline p-4 text-center text-sm text-on-surface-secondary">
                  No clients added yet.
                </div>
              )}

              {clients.length > 0 && (
                <div className="space-y-2">
                  {clients.map((c, idx) => (
                    <div key={c.id || `client-${idx}`} className="group flex items-center justify-between p-3 rounded-lg border border-outline bg-surface-alt">
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0">
                          <span className="text-white text-xs font-semibold">
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-on-surface truncate">{c.name}</p>
                          {c.email && (
                            <p className="text-xs text-on-surface-secondary truncate">{c.email}</p>
                          )}
                        </div>
                      </div>
                      <Button
                        type="danger"
                        size="small"
                        onClick={() => removeClient(idx)}
                        className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-200 shrink-0 ml-2"
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Conflict of interest check */}
              {clients.length > 0 && (
                <ConflictCheckBanner lawFirmId={firmId} clients={clients} excludeClientIds={addedClientIds} />
              )}
            </div>
            )}

          </div>
    </Modal>
    {teamNotice && <ErrorToast message={teamNotice} onDismiss={() => setTeamNotice(null)} duration={8000} />}
    <UpgradePrompt
      open={!!planLimitDetails}
      onClose={() => setPlanLimitDetails(null)}
      details={planLimitDetails}
      lawFirmId={lawFirmId}
    />
    </>
  );
}
