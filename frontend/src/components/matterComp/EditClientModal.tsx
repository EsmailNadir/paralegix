"use client";

import { useId, useState, useEffect } from "react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Modal from "@/components/ui/Modal";
import MattersService from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import type { MatterClient } from "@/types";
import ErrorNotification from "@/components/ErrorNotification";

import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";
import { getErrorMessage } from "@/lib/utils/apiErrors";

import FieldLabel from "@/components/ui/FieldLabel";
import ClientFields from "@/components/clientComp/ClientFields";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  client: MatterClient | null;
  onAfter?: () => Promise<void> | void;
};

export default function EditClientModal({ open, onClose, lawFirmId, client, onAfter }: Props) {
  const fieldIds = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [address, setAddress] = useState("");
  const [preferredContactMethod, setPreferredContactMethod] = useState("none");
  const [sendInvite, setSendInvite] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { duplicate: duplicateClient } = useDuplicateNameCheck("clients", lawFirmId, name, {
    enabled: open,
    excludeId: client?.id,
  });

  useEffect(() => {
    if (open && client) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the client when the modal opens
      setName(client.name || "");
      setEmail(client.email || "");
      setPhone(client.phone || "");
      setOrganization(client.organization || "");
      setAddress(client.address || "");
      setPreferredContactMethod(client.preferredContactMethod || "none");
      setSendInvite(false);
      setError(null);
    }
  }, [open, client]);

  const handleSubmit = async () => {
    if (!client) return;
    if (!name.trim()) {
      setError("Client name is required");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      // "None" is a UI-only sentinel the backend enum does not carry. It goes
      // out as null, which clears a stored preference, like a blanked input.
      const preferredMethod =
        preferredContactMethod && preferredContactMethod !== "none"
          ? preferredContactMethod
          : null;

      const clientPayload = {
        name: name.trim(),
        // null, not undefined: the server leaves an omitted field alone, so a
        // blanked input could never clear what is stored.
        email: email.trim() || null,
        phone: phone.trim() || null,
        organization: organization.trim() || null,
        address: address.trim() || null,
        preferredContactMethod: preferredMethod,
      };

      // `clients.id` is the canonical key. The portal `userId` is a Firebase uid
      // and is not addressable here: the route resolves a uuid.
      await MattersService.updateClientProfile({
        lawFirmId,
        clientId: client.id,
        client: clientPayload,
      });

      // The profile is saved either way, so a refused invite does not undo it.
      // It is reported and the dialog stays open, rather than closing as
      // though the email went out; saving again retries the invite.
      let inviteFailure: string | null = null;
      if (sendInvite && !client.userId && email.trim()) {
        try {
          await clientsService.inviteClientToLawFirm(email.trim(), lawFirmId);
        } catch (inviteErr) {
          inviteFailure = getErrorMessage(inviteErr, "Failed to send the invite");
        }
      }

      await onAfter?.();
      if (inviteFailure) {
        setError(`The client was updated, but the portal invite email could not be sent: ${inviteFailure}`);
        return;
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message || "Failed to update client" : "Failed to update client";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!submitting}
      title="Edit Client"
      showClose={false}
      size="md"
      bodyClassName="px-6 py-4 space-y-4"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !name.trim()}
          >
            {submitting ? "Updating..." : "Update Client"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

            {/* Immutable after creation (DB trigger). Never offer a control to
                change it, just say what it is. */}
            <div>
              <FieldLabel>Client Type</FieldLabel>
              <p className="text-sm text-on-surface-secondary">
                {client?.clientType === "company" ? "Organization" : "Person"}
              </p>
            </div>

            <ClientFields lawFirmId={lawFirmId} idPrefix={fieldIds} clientType={client?.clientType === "company" ? "company" : "person"}
              values={{ name, email, phone, organization, address, preferredContactMethod }}
              nameRequired typedContactInputs explicitTextType duplicateName={duplicateClient?.label}
              onChange={(field, value) => {
                const setters = { name: setName, email: setEmail, phone: setPhone, organization: setOrganization, address: setAddress, preferredContactMethod: setPreferredContactMethod };
                setters[field](value);
              }} />

            {/* An organization can't carry a portal login directly. Its contacts
                are invited individually from the client's Contacts tab instead. */}
            {client?.clientType === "company" ? (
              <p className="text-xs text-on-surface-muted">
                Portal access for an organization is granted per contact, from the client&apos;s Contacts tab.
              </p>
            ) : (
              !client?.userId && (
                email.trim() ? (
                  <Checkbox
                    checked={sendInvite}
                    onChange={setSendInvite}
                    label="Invite to client portal"
                    description="Send an email invite so they can log in and view their matter."
                  />
                ) : (
                  <p className="text-xs text-on-surface-muted">
                    Add an email above to invite this client to the portal.
                  </p>
                )
              )
            )}
    </Modal>
  );
}
