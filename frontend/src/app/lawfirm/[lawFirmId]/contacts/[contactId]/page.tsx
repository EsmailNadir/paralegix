"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  Building2, Mail, Phone, MapPin, Globe, StickyNote, Briefcase,
  Landmark, IdCard, Pencil, UserRound,
} from "lucide-react";
import { useContactById } from "@/hooks/contactHooks/useContacts";
import BackButton from "@/components/ui/BackButton";
import ContactFormModal from "@/components/contactsComp/ContactFormModal";
import ContactCategoryBadge from "@/components/ui/ContactCategoryBadge";
import ErrorNotification from "@/components/ErrorNotification";
import ListEmptyState from "@/components/ui/ListEmptyState";
import LoadingSpinner from "@/components/LoadingSpinner";
import PageHeader from "@/components/ui/PageHeader";
import RequirePermission from "@/components/ui/RequirePermission";
import StatusBadge from "@/components/ui/StatusBadge";
import TagChip from "@/components/ui/TagChip";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import Button from "@/components/ui/Button";

const CARD_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm";

/** One label + value line in the details card. Renders nothing without a value. */
function DetailLine({
  icon, label, children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <span className="text-on-surface-muted shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-on-surface-muted">{label}</p>
        <div className="text-sm text-on-surface break-words">{children}</div>
      </div>
    </div>
  );
}

function ContactDetail({ lawFirmId, contactId }: { lawFirmId: string; contactId: string }) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("contacts.manage");
  const { contact, matters, loading, error, refresh } = useContactById(lawFirmId, contactId);
  const [editOpen, setEditOpen] = useState(false);

  if (loading) return <LoadingSpinner fullPage />;

  if (!contact) {
    return (
      <div className="min-h-screen bg-page">
        <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
          <ErrorNotification error={error || "Contact not found."} />
        </div>
      </div>
    );
  }

  const hasDetails = Boolean(
    contact.organization || contact.title || contact.barNumber || contact.email
      || contact.phone || contact.phoneAlt || contact.address || contact.website
      || contact.courtName || contact.notes
  );

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification error={error} />

        <BackButton href={`/lawfirm/${lawFirmId}/contacts`} label="Back to contacts" variant="link" />

        <PageHeader
          eyebrow={contact.contactType === "company" ? "Organization" : "Contact"}
          title={contact.name}
          description={[contact.title, contact.organization].filter(Boolean).join(" · ") || undefined}
          actions={
            canManage && (
              <Button
                type="secondary"
                size="compact"
                onClick={() => setEditOpen(true)}
                icon={<Pencil size={14} />}
              >
                Edit Contact
              </Button>
            )
          }
        >
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <ContactCategoryBadge category={contact.category} />
            {contact.isArchived && <StatusBadge variant="neutral">Archived</StatusBadge>}
            {contact.tags.map((tag) => (
              <TagChip key={tag} label={tag} />
            ))}
          </div>
        </PageHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={`${CARD_CLASS} lg:col-span-1 space-y-4`}>
            <h2 className="text-sm font-semibold text-on-surface">Details</h2>

            {hasDetails ? (
              <>
                <DetailLine icon={<Building2 size={15} />} label="Organization">
                  {contact.organization}
                </DetailLine>
                <DetailLine icon={<UserRound size={15} />} label="Title">
                  {contact.title}
                </DetailLine>
                <DetailLine icon={<IdCard size={15} />} label="Bar number">
                  {contact.barNumber}
                </DetailLine>
                <DetailLine icon={<Mail size={15} />} label="Email">
                  {contact.email && (
                    <a href={`mailto:${contact.email}`} className="text-accent-emphasis hover:underline">
                      {contact.email}
                    </a>
                  )}
                </DetailLine>
                <DetailLine icon={<Phone size={15} />} label="Phone">
                  {contact.phone && (
                    <a href={`tel:${contact.phone}`} className="hover:underline">{contact.phone}</a>
                  )}
                </DetailLine>
                <DetailLine icon={<Phone size={15} />} label="Alternate phone">
                  {contact.phoneAlt && (
                    <a href={`tel:${contact.phoneAlt}`} className="hover:underline">{contact.phoneAlt}</a>
                  )}
                </DetailLine>
                <DetailLine icon={<MapPin size={15} />} label="Address">
                  {contact.address}
                </DetailLine>
                <DetailLine icon={<Globe size={15} />} label="Website">
                  {contact.website}
                </DetailLine>
                <DetailLine icon={<Landmark size={15} />} label="Court">
                  {contact.courtName}
                </DetailLine>
                <DetailLine icon={<StickyNote size={15} />} label="Notes">
                  {contact.notes}
                </DetailLine>
              </>
            ) : (
              <p className="text-sm text-on-surface-muted">No additional details on file.</p>
            )}
          </div>

          <div className={`${CARD_CLASS} lg:col-span-2 space-y-4`}>
            <div>
              <h2 className="text-sm font-semibold text-on-surface">Related Matters</h2>
              <p className="text-xs text-on-surface-secondary mt-0.5">
                Every matter this contact is on, and the role they play there.
              </p>
            </div>

            {matters.length === 0 ? (
              <ListEmptyState
                compact
                icon={<Briefcase size={32} />}
                title="Not on any matters yet"
                message="Add this contact from a matter's Contacts tab to link them."
              />
            ) : (
              <div className="space-y-2">
                {matters.map((link) => (
                  <button
                    key={link.linkId}
                    type="button"
                    onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${link.matterId}`)}
                    className="w-full flex items-center justify-between gap-3 rounded-lg border border-outline-subtle bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover cursor-pointer min-w-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-on-surface truncate">
                        {link.matterName}
                        {link.matterNumber && (
                          <span className="ml-1.5 font-normal text-on-surface-muted">#{link.matterNumber}</span>
                        )}
                      </p>
                      {link.notes && (
                        <p className="text-xs text-on-surface-secondary truncate mt-0.5">{link.notes}</p>
                      )}
                    </div>
                    <ContactCategoryBadge category={link.role} className="shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <ContactFormModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={() => { refresh(); }}
          lawFirmId={lawFirmId}
          editing={contact}
        />
      </div>
    </div>
  );
}

export default function ContactDetailPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const contactId = (Array.isArray(params?.contactId) ? params.contactId[0] : params?.contactId) || "";
  if (!lawFirmId || !contactId) return null;

  return (
    <RequirePermission permission="contacts.view" page>
      <ContactDetail lawFirmId={lawFirmId} contactId={contactId} />
    </RequirePermission>
  );
}
