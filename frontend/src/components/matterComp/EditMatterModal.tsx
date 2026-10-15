"use client";

import MatterBillingFields from "./MatterBillingFields";
import { getMatterLeadNames } from '@/lib/matters/leadNames';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Mail, MapPin, Phone, User as UserIcon } from "lucide-react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import CategoryTreeSelect from "@/components/ui/CategoryTreeSelect";
import DatePicker from "@/components/ui/DatePicker";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import StatusBadge from "@/components/ui/StatusBadge";
import type { Matter, MatterClient } from "@/types";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import useCourts from "@/hooks/courtHooks/useCourts";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/contexts/PermissionsContext";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { validateRequiredFields, ValidationField } from "@/utils/formValidation";
import MattersService from "@/services/matters.service";
import MatterPracticeAreaField from "@/components/matterComp/matterForm/MatterPracticeAreaField";
import MatterCourtField from "@/components/matterComp/matterForm/MatterCourtField";
import MatterMemberPicker from "@/components/matterComp/matterForm/MatterMemberPicker";
import MatterClientPicker from "@/components/matterComp/matterForm/MatterClientPicker";

import { useResetAfterClose } from "@/hooks/useMountTransition";
import type { User } from "@/types";
import { TERMINAL_MATTER_STATUSES } from "@/lib/constants/matterStatus";
import EditClientModal from "./EditClientModal";
import RemoveMemberConfirm from "./RemoveMemberConfirm";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { MemberRemovalPreview } from "@/services/matters.service";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";
import FormStepIndicator from "@/components/ui/FormStepIndicator";
import FieldLabel from "@/components/ui/FieldLabel";
import ClientFields from "@/components/clientComp/ClientFields";
import TextInput from "@/components/ui/TextInput";
import Textarea from "@/components/ui/Textarea";
import StepModalFooter from "@/components/ui/StepModalFooter";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  users: User[];
  matterItem: Matter | null;
  onAfter?: () => Promise<void> | void;
};

type ClientInput = {
  /** The firm client this row links, when it was picked from the search. */
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
  preferredContactMethod?: string | null;
  sendInvite?: boolean;
};

// Statuses that mean a matter is functionally done. The "payment ongoing" toggle
// is only meaningful (and only shown) for these: on an active matter, money still
// owing is expected and carries no signal.
const TERMINAL_STATUSES = TERMINAL_MATTER_STATUSES;

type StepKey = "clients" | "details" | "team";

// Which steps a viewer gets. Matter Details is always there; Clients and Team are
// writes of their own (`matters.manageClients`, `matters.manageMembers`) that a
// role with only `matters.update` does not hold, so those steps are left out
// rather than shown and refused at save.
const ALL_STEPS: Array<{ key: StepKey; label: string }> = [
  { key: "clients", label: "Clients" },
  { key: "details", label: "Matter Details" },
  { key: "team", label: "Team" },
];

export default function EditMatterModal({ open, onClose, lawFirmId, users, matterItem, onAfter }: Props) {
  const fieldIds = useId();
  const firmId = (lawFirmId ?? "").trim();
  const { hasPermission } = usePermissions();
  const canManageMembers = hasPermission("matters.manageMembers");
  const canManageClients = hasPermission("matters.manageClients");
  const steps = useMemo(
    () => ALL_STEPS.filter((step) => (step.key === "clients" ? canManageClients : step.key === "team" ? canManageMembers : true)),
    [canManageClients, canManageMembers],
  );
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(steps.length);
  const stepKey = steps[currentStep - 1]?.key;

  // data
  // Mounted closed wherever it is offered, so the practice area picker's list
  // loads when the modal first opens (the cache key is shared).
  const { practiceAreas, loading: paLoading, error: paError, createPracticeArea } = usePracticeAreas(firmId, open);
  // Mounted closed on every page that offers it, so the court picker's list
  // loads when the modal first opens (the cache key is shared).
  const { courts, loading: courtsLoading, createCourt } = useCourts(firmId, open);
  const { user: currentUser } = useAuth();

  // local state
  const [title, setTitle] = useState(matterItem?.name || "");
  const [matterNumber, setMatterNumber] = useState(matterItem?.matterNumber || "");
  const [description, setDescription] = useState(matterItem?.description || "");
  const [status, setStatus] = useState<string>(matterItem?.status || "active");
  const [paymentOngoing, setPaymentOngoing] = useState<boolean>(matterItem?.paymentOngoingManual ?? false);
  // Billing preferences + key dates
  const [billingMethod, setBillingMethod] = useState<string>(matterItem?.billingMethod || "hourly");
  const [isBillable, setIsBillable] = useState<boolean>(matterItem?.isBillable !== false);
  const [budget, setBudget] = useState<string>(matterItem?.budget != null ? String(matterItem.budget) : "");
  const [budgetIncludesExpenses, setBudgetIncludesExpenses] = useState<boolean>(matterItem?.budgetIncludesExpenses !== false);
  const [contingencyPercent, setContingencyPercent] = useState<string>(matterItem?.contingencyPercent != null ? String(matterItem.contingencyPercent) : "");
  const [openDate, setOpenDate] = useState<string>(matterItem?.openDate || "");
  const [closeDate, setCloseDate] = useState<string>(matterItem?.closeDate || "");
  const [statuteOfLimitationsDate, setStatuteOfLimitationsDate] = useState<string>(matterItem?.statuteOfLimitationsDate || "");
  const [practiceAreaId, setPracticeAreaId] = useState<string>(matterItem?.practiceAreaId || "");
  const [category, setCategory] = useState(matterItem?.category || "");
  const [courtId, setCourtId] = useState<string>(matterItem?.courtId || "");
  const [leadUserIds, setLeadUserIds] = useState<string[]>(
    matterItem?.leadUserIds ?? (matterItem?.leadUserId ? [matterItem.leadUserId] : [])
  );
  const [memberUserIds, setMemberUserIds] = useState<string[]>(matterItem?.members?.map(m => m.userId).filter((id): id is string => !!id) || []);

  // client management
  const [clients, setClients] = useState<MatterClient[]>([]);
  const [loadingMatterClients, setLoadingMatterClients] = useState(false);
  const [newClients, setNewClients] = useState<ClientInput[]>([]);
  const [editingClient, setEditingClient] = useState<MatterClient | null>(null);
  const [removingClientId, setRemovingClientId] = useState<string | null>(null);
  const [clientToRemove, setClientToRemove] = useState<MatterClient | null>(null);
  const [clientRemovalError, setClientRemovalError] = useState<string | null>(null);
  const [editClientModalOpen, setEditClientModalOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  useResetAfterClose(open, () => setInlineError(null));
  useResetAfterClose(open, () => setClientToRemove(null));
  const { duplicate: duplicateMatter } = useDuplicateNameCheck("matters", firmId, title, {
    enabled: open,
    excludeId: matterItem?.id,
  });

  const statusOptions: DropdownOption[] = [
    { label: "Active", value: "active" },
    { label: "Paused", value: "on_hold" },
    { label: "Pending", value: "pending" },
    { label: "Completed", value: "completed" },
    { label: "Blocked", value: "blocked" },
    { label: "Closed", value: "closed" },
    { label: "Archived (permanently stored)", value: "archived" },
  ];

  const leadNames = getMatterLeadNames(matterItem, users).join(', ');

  // Seeds the form when the modal opens, or when it is pointed at a different
  // matter while open. A fresh object for the SAME matter (the page reloading it
  // in `onAfter` after a partly failed save) must not re-seed: that would empty
  // the queue of clients that could not be added and the message naming them.
  const matterItemRef = useRef(matterItem);
  matterItemRef.current = matterItem;
  const matterItemId = matterItem?.id;
  useEffect(() => {
    if (!open) return;
    const matterItem = matterItemRef.current;
    setTitle(matterItem?.name || "");
    setMatterNumber(matterItem?.matterNumber || "");
    setDescription(matterItem?.description || "");
    setStatus(matterItem?.status || "active");
    setPaymentOngoing(matterItem?.paymentOngoingManual ?? false);
    setBillingMethod(matterItem?.billingMethod || "hourly");
    setIsBillable(matterItem?.isBillable !== false);
    setBudget(matterItem?.budget != null ? String(matterItem.budget) : "");
    setBudgetIncludesExpenses(matterItem?.budgetIncludesExpenses !== false);
    setContingencyPercent(matterItem?.contingencyPercent != null ? String(matterItem.contingencyPercent) : "");
    setOpenDate(matterItem?.openDate || "");
    setCloseDate(matterItem?.closeDate || "");
    setStatuteOfLimitationsDate(matterItem?.statuteOfLimitationsDate || "");
    setPracticeAreaId(matterItem?.practiceAreaId || "");
    setCategory(matterItem?.category || "");
    setCourtId(matterItem?.courtId || "");
    setLeadUserIds(matterItem?.leadUserIds ?? (matterItem?.leadUserId ? [matterItem.leadUserId] : []));
    setMemberUserIds(matterItem?.members?.map(m => m.userId).filter((id): id is string => !!id) || []);
    setInlineError(null);
    setNewClients([]);
  }, [open, matterItemId]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- returns the wizard to the first step each time the modal opens
      setCurrentStep(1);
      // Editing an existing matter: every step already has valid data, so all steps are reachable immediately.
      setMaxStepReached(steps.length);
    }
  }, [open, steps.length]);

  // Team member management functions
  const addMember = (userId: string) => {
    if (!memberUserIds.includes(userId)) {
      setMemberUserIds((prev) => [...prev, userId]);
    }
  };

  const removeMember = (userId: string) => {
    // The current user always stays on the team. Removing anyone else also clears
    // their lead status so a lead can't linger without being a member.
    if (userId === currentUser?.uid) return;
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
      // Select all users
      setMemberUserIds(users.map(user => user.uid));
    }
  };

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memoization is intentional
  const loadClients = useCallback(async () => {
    if (!matterItem?.id) return;
    
    setLoadingMatterClients(true);
    try {
      const clientList = await MattersService.listClients(firmId, matterItem.id);
      setClients(clientList || []);
    } catch (error) {
      console.warn("Could not load matter clients:", error);
      setClients([]);
    } finally {
      setLoadingMatterClients(false);
    }
  }, [matterItem?.id, firmId]);

  // load clients when matter changes
  useEffect(() => {
    if (open && matterItem?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers an async data fetch when the modal opens for a matter
      loadClients();
    }
  }, [open, matterItem?.id, loadClients]);

  const addNewClient = () => {
    setNewClients((prev) => [
      ...prev,
      { name: "", email: "", phone: "", organization: "", address: "", preferredContactMethod: "none", sendInvite: false },
    ]);
  };

  const addedClientIds = [
    ...clients.map((client) => client.id),
    ...newClients.map((client) => client.clientId).filter((id): id is string => !!id),
  ];

  const addExistingClient = (existing: { id: string; name: string; email: string; clientType?: 'person' | 'company' | null }) => {
    setNewClients((prev) => [
      ...prev,
      {
        clientId: existing.id,
        clientType: existing.clientType ?? undefined,
        name: existing.name,
        email: existing.email,
        phone: "",
        organization: "",
        address: "",
        preferredContactMethod: "none",
        sendInvite: false,
      },
    ]);
  };

  const updateNewClient = (index: number, field: keyof ClientInput, value: string) => {
    setNewClients((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const updateNewClientInvite = (index: number, sendInvite: boolean) => {
    setNewClients((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], sendInvite };
      return copy;
    });
  };

  const removeNewClient = (index: number) => {
    setNewClients((prev) => prev.filter((_, i) => i !== index));
  };

  const addClientToMatter = async (clientData: ClientInput) => {
    if (!matterItem?.id) return;

    await MattersService.addClient({
      lawFirmId: firmId,
      matterId: matterItem.id,
      client: clientData,
    });

    // Reload clients to get the updated list
    await loadClients();
  };

  const removeClient = async (clientId: string) => {
    if (!matterItem?.id || removingClientId) return;

    setClientRemovalError(null);
    setRemovingClientId(clientId);
    try {
      await MattersService.removeClient({
        lawFirmId: firmId,
        matterId: matterItem.id,
        clientId,
      });

      // Reload clients to get the updated list
      await loadClients();
      setClientToRemove(null);
    } catch (error) {
      setClientRemovalError(getErrorMessage(error, "Failed to remove client"));
    } finally {
      setRemovingClientId(null);
    }
  };

  const originalMemberIds = matterItem?.members?.map((m) => m.userId).filter((id): id is string => !!id) || [];

  // What a removal asks the user to confirm: the members who would leave, the
  // ones who stay, and what the server says is still assigned to the leavers.
  const [removalConfirm, setRemovalConfirm] = useState<{ preview: MemberRemovalPreview } | null>(null);
  const [checkingRemoval, setCheckingRemoval] = useState(false);

  const memberLabel = useCallback(
    (userId: string) => {
      const u = users.find((x) => x.uid === userId);
      return { userId, name: u?.name, email: u?.email };
    },
    [users],
  );

  // The members this save would remove from the matter. Empty for a viewer who
  // cannot manage members, whose team is never edited here.
  const membersToRemove = (() => {
    if (!canManageMembers) return [];
    // Mirrors the save: the editor stays on the team if they were already on it.
    const kept = new Set(memberUserIds);
    if (currentUser?.uid && originalMemberIds.includes(currentUser.uid)) kept.add(currentUser.uid);
    return originalMemberIds.filter((id) => !kept.has(id));
  })();

  const validateBeforeSave = (): boolean => {
    // Validate required fields
    const validationFields: ValidationField[] = [
      { name: 'title', value: title, required: true, label: 'Title' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setInlineError(validationError);
      return false;
    }

    for (const client of newClients) {
      if (!client.name.trim()) {
        setInlineError("Every queued client needs a name, or remove the row");
        return false;
      }
      if (client.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email.trim())) {
        setInlineError(`Please enter a valid email address for ${client.name.trim()}`);
        return false;
      }
    }
    return true;
  };

  /**
   * The Save button. A removal is confirmed first, with what is still assigned to
   * the leaving members on this matter, so the preview is read before anything is
   * written; with no removal it goes straight to the save.
   */
  const submit = async () => {
    if (!matterItem) return;
    if (!validateBeforeSave()) return;

    if (membersToRemove.length === 0) {
      await save(null);
      return;
    }

    try {
      setCheckingRemoval(true);
      setInlineError(null);
      const preview = await MattersService.previewRemoveMembers({
        lawFirmId: firmId,
        matterId: matterItem.id,
        targetUserIds: membersToRemove,
      });
      setRemovalConfirm({ preview });
    } catch (e) {
      // Nothing was written, so nobody is removed and the form is as the user left it.
      setInlineError(getErrorMessage(e, "Could not check what removing these members affects"));
    } finally {
      setCheckingRemoval(false);
    }
  };

  /**
   * Writes the matter. The matter's own fields are the part the user cannot do
   * without, so a refused team, practice area or client call is collected and
   * reported instead of abandoning the rest: the modal stays open, names what was
   * not saved, and the page behind it is refreshed with what was.
   */
  const save = async (reassignTo: string | null) => {
    if (!matterItem) return;
    const notSaved: string[] = [];

    try {
      setSubmitting(true);
      setInlineError(null);

      // Build update payload without undefined
      const updatePayload: any = {
        matterId: matterItem.id,
        lawFirmId: firmId,
        name: title.trim(),
        // Sent even when blank: an empty number clears the stored one.
        matterNumber: matterNumber.trim(),
        description: description.trim(),
        status,
        // Only carries a signal on terminal statuses; clear it otherwise so a
        // stale override doesn't linger if the matter is reopened.
        paymentOngoing: TERMINAL_STATUSES.includes(status) ? paymentOngoing : false,
        category: category.trim() || undefined,
        // Billing preferences + key dates
        billingMethod,
        isBillable,
        budget: budget.trim() === "" ? null : Number(budget),
        budgetIncludesExpenses,
        contingencyPercent: billingMethod === "contingency" && contingencyPercent.trim() !== "" ? Number(contingencyPercent) : null,
        openDate: openDate || null,
        closeDate: closeDate || null,
        statuteOfLimitationsDate: statuteOfLimitationsDate || null,
      };

      // include court if changed
      const originalCourt = matterItem.courtId || "";
      if (courtId !== originalCourt) {
        updatePayload.courtId = courtId || null;
      }

      // include the full lead set only if it changed. `leadUserIds` REPLACES the
      // matter's leads on the backend (an empty array clears them all).
      const originalLeads =
        matterItem.leadUserIds ?? (matterItem.leadUserId ? [matterItem.leadUserId] : []);
      const leadsChanged =
        JSON.stringify([...leadUserIds].sort()) !== JSON.stringify([...originalLeads].sort());

      // Team members FIRST, before the matter/lead update: a newly-promoted lead
      // must already be a matter member, because updateMatter validates that leads
      // are members and no longer grants membership itself.
      const membersChanged =
        canManageMembers &&
        JSON.stringify([...memberUserIds].sort()) !== JSON.stringify([...originalMemberIds].sort());
      let teamSaved = true;

      if (membersChanged) {
        try {
          // Keep the editor on the team, but only if they were already on it: a firm
          // owner or admin may edit a matter they do not belong to, and staffing it
          // must not quietly add them to it.
          const allMemberIds = [...memberUserIds];
          if (currentUser?.uid && originalMemberIds.includes(currentUser.uid) && !allMemberIds.includes(currentUser.uid)) {
            allMemberIds.push(currentUser.uid);
          }

          await MattersService.addMembers({
            lawFirmId: firmId,
            matterId: matterItem.id,
            targetUserIds: allMemberIds,
            role: 'member',
          });

          // Persist removals too: members present originally but deselected now.
          // removeMember already dropped a removed member's lead status, so the lead
          // set sent below never names a removed member.
          const removedMembers = originalMemberIds.filter((id) => !allMemberIds.includes(id));
          if (removedMembers.length) {
            await MattersService.removeMembers({
              lawFirmId: firmId,
              matterId: matterItem.id,
              targetUserIds: removedMembers,
              ...(reassignTo ? { reassignTo } : {}),
            });
          }
        } catch (teamErr) {
          teamSaved = false;
          notSaved.push(`Team changes were not saved: ${getErrorMessage(teamErr, "Failed to update the team")}.`);
        }
      }

      // The lead set rides with the matter update only when the team change it
      // depends on went through; otherwise it could name a non-member.
      if (leadsChanged && teamSaved) {
        updatePayload.leadUserIds = leadUserIds;
      }

      // Matter fields + lead set. A refusal here aborts: nothing else is worth
      // reporting on top of "the matter itself was not saved".
      await MattersService.updateMatter(updatePayload);

      // practice area uses its own endpoint; only call if changed
      if ((practiceAreaId || "") !== (matterItem.practiceAreaId || "")) {
        try {
          await MattersService.updatePracticeArea({
            lawFirmId: firmId,
            matterId: matterItem.id,
            // "None" is an empty value in the dropdown; null clears the practice area.
            practiceAreaId: practiceAreaId || null,
          });
        } catch (paErr) {
          notSaved.push(`The practice area was not saved: ${getErrorMessage(paErr, "Failed to update the practice area")}.`);
        }
      }

      // Add any new clients, keeping the ones that failed so they can be retried.
      const failedClients: ClientInput[] = [];
      if (canManageClients) {
        for (const client of newClients) {
          if (!client.name.trim()) continue;
          const email = client.email?.trim() || "";
          try {
            await addClientToMatter({
              // A client picked from the search is linked by its id; without it
              // the server finds nothing to reuse and creates a duplicate.
              ...(client.clientId ? { clientId: client.clientId, clientType: client.clientType } : {}),
              name: client.name.trim(),
              email,
              phone: client.phone?.trim() || "",
              organization: client.organization?.trim() || "",
              address: client.address?.trim() || "",
              // "None" is a UI-only sentinel: the backend enum has no such value.
              // It goes out as null so the client is stored with no preference;
              // leaving the field out would take the server's 'email' default.
              preferredContactMethod:
                client.preferredContactMethod && client.preferredContactMethod !== "none"
                  ? client.preferredContactMethod
                  : null,
            });
          } catch (clientErr) {
            failedClients.push(client);
            notSaved.push(`${client.name.trim()} was not added: ${getErrorMessage(clientErr, "Failed to add client")}.`);
            continue;
          }

          if (client.sendInvite && email) {
            try {
              const { default: clientsService } = await import("@/services/clients.service");
              await clientsService.inviteClientToLawFirm(email, firmId);
            } catch (inviteErr) {
              notSaved.push(`${client.name.trim()} was added, but the portal invite was not sent: ${getErrorMessage(inviteErr, "Failed to send the invite")}.`);
            }
          }
        }
        setNewClients(failedClients);
      }

      await onAfter?.();
      if (notSaved.length > 0) {
        setInlineError(notSaved.join(" "));
        return;
      }
      onClose();
    } catch (e) {
      setInlineError(e instanceof Error ? e.message : "failed to update matter");
    } finally {
      setSubmitting(false);
    }
  };

  const continueToNextStep = () => {
    setInlineError(null);

    if (stepKey === "details") {
      const validationError = validateRequiredFields([
        { name: "title", value: title, required: true, label: "Title" },
      ]);
      if (validationError) {
        setInlineError(validationError);
        return;
      }
    }

    setCurrentStep((step) => {
      const next = Math.min(step + 1, steps.length);
      setMaxStepReached((max) => Math.max(max, next));
      return next;
    });
  };

  const handleStepClick = (targetStep: number) => {
    if (stepKey === "details" && steps[targetStep - 1]?.key !== "details") {
      const validationError = validateRequiredFields([
        { name: "title", value: title, required: true, label: "Title" },
      ]);
      if (validationError) {
        setInlineError(validationError);
        return;
      }
    }
    setInlineError(null);
    setCurrentStep(targetStep);
  };

  return (
    <>
    <Modal
      isOpen={open}
      onClose={() => { if (!clientToRemove) onClose(); }}
      dismissible={!submitting && !checkingRemoval}
      title="Edit Matter"
      showClose={false}
      size="2xl"
      height="steps"
      footerAlign="between"
      lockScroll
      bodyClassName={null}
      footer={
        // The banners sit directly above the buttons, as in the create wizard,
        // so a failed save is read where the user just clicked.
        <div className="w-full">
          <ErrorNotification
            error={paError}
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
              stepCount={steps.length}
              onCancel={onClose}
              onBack={() => setCurrentStep((step) => step - 1)}
              onContinue={continueToNextStep}
              continueDisabled={stepKey === "details" && !title.trim()}
              busy={submitting || checkingRemoval}
              submit={{
                onClick: submit,
                loading: submitting || checkingRemoval,
                disabled: submitting || checkingRemoval || !title.trim(),
                label: submitting ? "Saving..." : "Save Changes",
              }}
            />
          </div>
        </div>
      }
    >
      <FormStepIndicator
        steps={steps}
        currentStep={currentStep}
        maxStepReached={maxStepReached}
        onStepClick={handleStepClick}
        disabled={submitting || checkingRemoval}
      />

      <div className="flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar px-6 py-5 space-y-5">
            {/* info strip */}
            <div className="rounded-md bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary border border-outline">
              <div>
                <span className="font-medium">{leadNames.includes(",") ? "Current Leads:" : "Current Lead:"}</span>{" "}
                {leadNames || "-"}
              </div>
              <div className="mt-1">
                <span className="font-medium">Current Status:</span>{" "}
                {matterItem?.status || "active"}
              </div>
            </div>

            {stepKey === "details" && <>
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

              {/* practice area - keyed on the matter so switching which matter is
                  edited (without closing) resets any open quick-create panel */}
              <MatterPracticeAreaField
                key={`pa-${matterItem?.id ?? "new"}`}
                value={practiceAreaId}
                onChange={setPracticeAreaId}
                practiceAreas={practiceAreas}
                loading={paLoading}
                createPracticeArea={createPracticeArea}
                firmId={firmId}
              />

              {/* court */}
              <MatterCourtField
                key={`court-${matterItem?.id ?? "new"}`}
                value={courtId}
                onChange={setCourtId}
                courts={courts}
                loading={courtsLoading}
                createCourt={createCourt}
                firmId={firmId}
              />

              {/* category */}
              <div>
                <FieldLabel>Category</FieldLabel>
                <CategoryTreeSelect
                  value={category}
                  onChange={setCategory}
                  placeholder="Select or create a category"
                  lawFirmId={firmId}
                />
                <p className="text-xs text-on-surface-secondary mt-1">
                  Start typing to find a category. If there isn&apos;t a match, select Create to make one.
                </p>
                <p className="text-xs text-accent-emphasis mt-1 font-medium">
                  To create nested categories, type: &quot;Parent Category {'>'} Subcategory&quot; (e.g., &quot;Corporate {'>'} M&A {'>'} Mergers&quot;)
                </p>
              </div>

              {/* status */}
              <Dropdown
                label="Status"
                value={status}
                onChange={setStatus}
                options={statusOptions}
                portal
              />

              {/* payment ongoing - only meaningful once the matter is done */}
              {TERMINAL_STATUSES.includes(status) && (
                <Checkbox
                  checked={paymentOngoing}
                  onChange={setPaymentOngoing}
                  size="md"
                  label={<span className="font-medium">Payment still outstanding</span>}
                  description={
                    <>
                      Flag this closed matter as still owing (e.g. a payment plan, or a balance
                      expected later). It shows a &quot;Payment ongoing&quot; badge and can be filtered
                      in the matters list. Matters with an unpaid invoice are flagged automatically.
                    </>
                  }
                  className="items-start rounded-md border border-outline bg-surface-alt px-3 py-2.5"
                />
              )}

              {/* Billing preferences + key dates */}
              <div className="rounded-lg border border-outline p-4 space-y-4">
                <h3 className="text-sm font-semibold text-on-surface">Billing &amp; Key Dates</h3>
                <MatterBillingFields layout="grid" fieldIds={fieldIds} billingMethod={billingMethod} setBillingMethod={setBillingMethod}
                  budget={budget} setBudget={setBudget} contingencyPercent={contingencyPercent} setContingencyPercent={setContingencyPercent}
                  isBillable={isBillable} setIsBillable={setIsBillable} budgetIncludesExpenses={budgetIncludesExpenses} setBudgetIncludesExpenses={setBudgetIncludesExpenses}>
                  <div>
                    <FieldLabel id={`${fieldIds}-opened-label`}>Opened</FieldLabel>
                    <DatePicker
                      ariaLabelledBy={`${fieldIds}-opened-label`}
                      value={openDate} onChange={setOpenDate} />
                  </div>
                  <div>
                    <FieldLabel id={`${fieldIds}-statute-of-limitations-label`}>Statute of Limitations</FieldLabel>
                    <DatePicker
                      ariaLabelledBy={`${fieldIds}-statute-of-limitations-label`}
                      value={statuteOfLimitationsDate} onChange={setStatuteOfLimitationsDate} />
                  </div>
                  <div>
                    <FieldLabel id={`${fieldIds}-closed-label`}>Closed</FieldLabel>
                    <DatePicker
                      ariaLabelledBy={`${fieldIds}-closed-label`}
                      value={closeDate} onChange={setCloseDate} />
                  </div>
                </MatterBillingFields>
              </div>
            </>}

            {/* Team Members */}
            {stepKey === "team" && (
              <MatterMemberPicker
                users={users}
                memberUserIds={memberUserIds}
                leadUserIds={leadUserIds}
                currentUserId={currentUser?.uid}
                onAdd={addMember}
                onRemove={removeMember}
                onToggleLead={toggleLead}
                onToggleAll={toggleAllMembers}
                subtitle="Toggle Lead to mark responsible attorneys."
                emptyState={
                  <div className="rounded-lg border-2 border-dashed border-outline p-3 text-center bg-surface-alt">
                    <div className="w-8 h-8 mx-auto mb-2 bg-surface-hover rounded-full flex items-center justify-between">
                      <UserIcon size={16} className="text-on-surface-muted mx-auto" aria-hidden="true" />
                    </div>
                    <p className="text-xs text-on-surface-secondary">No team members selected</p>
                  </div>
                }
              />
            )}

            {stepKey === "clients" && <>
              {/* Existing Clients */}
              <div className="rounded-lg border border-outline p-4 space-y-3">
                <h3 className="text-sm font-semibold text-on-surface">Existing Clients</h3>

                {loadingMatterClients ? (
                  <ListSkeleton rows={3} label="Loading matter clients" bordered={false} />
                ) : clients.length === 0 ? (
                  <div className="rounded border border-dashed border-outline p-4 text-center text-sm text-on-surface-secondary">
                    No clients associated with this matter.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {clients.map((client) => (
                      <div key={client.id} className="rounded-md border border-outline p-4 bg-surface-alt">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium text-on-surface mb-2 break-words">
                              {client.name}
                            </h4>

                            <div className="space-y-1 text-sm text-on-surface-secondary">
                              {client.email && (
                                <div className="flex items-center gap-2 min-w-0">
                                  <Mail size={16} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
                                  <span className="min-w-0 break-all">{client.email}</span>
                                </div>
                              )}

                              {client.phone && (
                                <div className="flex items-center gap-2 min-w-0">
                                  <Phone size={16} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
                                  <span className="min-w-0 break-words">{client.phone}</span>
                                </div>
                              )}

                              {client.organization && (
                                <div className="flex items-center gap-2 min-w-0">
                                  <Building2 size={16} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
                                  <span className="min-w-0 break-words">{client.organization}</span>
                                </div>
                              )}

                              {client.address && (
                                <div className="flex items-center gap-2 min-w-0">
                                  <MapPin size={16} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
                                  <span className="min-w-0 break-words">{client.address}</span>
                                </div>
                              )}

                            </div>
                          </div>

                          <div className="flex gap-2 shrink-0 self-end sm:self-start">
                            <Button
                              type="secondary"
                              size="small"
                              onClick={() => {
                                setEditingClient(client);
                                setEditClientModalOpen(true);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              type="danger"
                              size="small"
                              onClick={() => {
                                setClientRemovalError(null);
                                setClientToRemove(client);
                              }}
                              loading={removingClientId === client.id}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add New Clients */}
              <div className="rounded-lg border border-outline p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-on-surface">Add Clients</h3>
                  <Button type="secondary" size="small" onClick={addNewClient}>
                    + New Client
                  </Button>
                </div>

                <div>
                  <FieldLabel>
                    Select Existing Client
                  </FieldLabel>
                  <MatterClientPicker lawFirmId={firmId} excludeIds={addedClientIds} onSelect={addExistingClient} />
                </div>

                {newClients.length === 0 && (
                  <div className="rounded border border-dashed border-outline p-4 text-center text-sm text-on-surface-secondary">
                    No clients queued yet.
                  </div>
                )}

                {newClients.map((c, idx) => (
                  <div key={c.clientId ?? `new-${idx}`} className="rounded-md border border-outline p-4 bg-surface-alt">
                    {c.clientId ? (
                      // A picked client is linked as it is; its record is edited
                      // from its own page, so no fields are offered for it here.
                      <div className="min-w-0">
                        <StatusBadge variant="info" className="mb-3">Existing client</StatusBadge>
                        <h4 className="text-sm font-medium text-on-surface break-words">{c.name}</h4>
                        {c.email && (
                          <div className="mt-1 flex items-center gap-2 min-w-0 text-sm text-on-surface-secondary">
                            <Mail size={16} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
                            <span className="min-w-0 break-all">{c.email}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <ClientFields lawFirmId={firmId} idPrefix={`${fieldIds}-${idx}`} values={c}
                        nameRequired organizationId={`${fieldIds}-${idx}-organization`} addressClassName="md:col-span-2"
                        onChange={(field, value) => updateNewClient(idx, field, value)} />
                    </div>
                    )}

                    {c.email?.trim() && (
                      <div className="mt-3">
                        <Checkbox
                          checked={!!c.sendInvite}
                          onChange={(checked) => updateNewClientInvite(idx, checked)}
                          label="Invite to client portal"
                          description="Send an email invite so they can log in and view their matter."
                        />
                      </div>
                    )}

                    <div className="mt-3 flex justify-end">
                      <Button type="danger" size="small" onClick={() => removeNewClient(idx)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>}
      </div>
    </Modal>

      <ConfirmModal
        isOpen={open && clientToRemove !== null}
        onClose={() => { if (!removingClientId) setClientToRemove(null); }}
        onConfirm={() => { if (clientToRemove) void removeClient(clientToRemove.id); }}
        title="Remove Client"
        message={`Are you sure you want to remove "${clientToRemove?.name ?? ""}" from this matter? The client will remain in your client list.`}
        confirmText="Remove"
        loading={removingClientId !== null}
        stacked
        extra={<ErrorNotification error={clientRemovalError} onClose={() => setClientRemovalError(null)} />}
      />

      {/* Confirm the members who leave on save, with what is assigned to them. */}
      <RemoveMemberConfirm
        isOpen={removalConfirm !== null}
        onClose={() => setRemovalConfirm(null)}
        onConfirm={(reassignTo) => {
          setRemovalConfirm(null);
          void save(reassignTo);
        }}
        members={membersToRemove.map(memberLabel)}
        remainingMembers={memberUserIds.map(memberLabel)}
        preview={removalConfirm?.preview ?? null}
        stacked
      />

      {/* Edit Client Modal */}
      <EditClientModal
        open={editClientModalOpen}
        onClose={() => {
          setEditClientModalOpen(false);
        }}
        lawFirmId={firmId}
        client={editingClient}
        onAfter={async () => {
          await loadClients();
        }}
      />
    </>
  );
}
