"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardList, Copy, Eye, Settings2 } from "lucide-react";
import ErrorNotification from "@/components/ErrorNotification";
import Dropdown from "@/components/ui/Dropdown";
import Spinner from "@/components/ui/Spinner";
import { useNavigation } from "@/contexts/NavigationContext";
import useIntakeForms from "@/hooks/leadHooks/useIntakeForms";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { publicIntakeUrl } from "@/lib/intakeForms";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { IntakeFormTemplate } from "@/types/lead";
import IntakeFormPreviewModal from "./IntakeFormPreviewModal";
import Button from "@/components/ui/Button";

type Props = {
  lawFirmId: string;
};

export default function IntakeFormsQuickAccess({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const { templates, loading, error, refetch } = useIntakeForms(lawFirmId);
  const [selectedId, setSelectedId] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<IntakeFormTemplate | null>(null);

  const activeTemplates = useMemo(
    () =>
      templates
        .filter((template) => template.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [templates],
  );
  const selected =
    activeTemplates.find((template) => template.id === selectedId) ?? activeTemplates[0];
  const manageUrl = `/lawfirm/${lawFirmId}/settings/matter-config?tab=intakeForms`;
  const heldPreviewTemplate = useLastOpenValue(!!previewTemplate, previewTemplate);

  const handleCopy = async () => {
    if (!selected) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(publicIntakeUrl(selected.publicToken));
      setCopiedId(selected.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopyError("Could not copy the intake form link. Open Manage forms to copy it manually.");
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-alt text-on-surface-secondary">
            <ClipboardList size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-on-surface">Share an intake form</h2>
            <p className="mt-1 text-sm text-on-surface-secondary">
              Copy a public form link to send to a prospective client.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end lg:shrink-0">
          {loading ? (
            <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-on-surface-muted">
              <Spinner size={14} /> Loading forms…
            </div>
          ) : activeTemplates.length > 0 && selected ? (
            <>
              <Dropdown
                value={selected.id}
                onChange={setSelectedId}
                options={activeTemplates.map((template) => ({
                  label: template.name,
                  value: template.id,
                }))}
                ariaLabel="Intake form"
                className="min-w-0 sm:w-56"
                buttonClassName="!rounded-xl !border-outline-subtle !bg-surface !px-3.5 !py-2 !text-xs !font-medium"
              />
              <Button
                size="compact"
                onClick={handleCopy}
                icon={copiedId === selected.id ? <Check size={14} /> : <Copy size={14} />}
              >
                {copiedId === selected.id ? "Copied" : "Copy link"}
              </Button>
              <Button
                type="secondary"
                size="compact"
                onClick={() => setPreviewTemplate(selected)}
                icon={<Eye size={14} />}
              >
                Preview
              </Button>
            </>
          ) : (
            <p className="self-center text-xs text-on-surface-muted">No active forms</p>
          )}

          <Button
            type="secondary"
            size="compact"
            onClick={() => navigate(manageUrl)}
            icon={<Settings2 size={14} />}
          >
            Manage forms
          </Button>
        </div>
      </div>

      <ErrorNotification
        error={copyError || (error ? getErrorMessage(error) : null)}
        onClose={copyError ? () => setCopyError(null) : undefined}
        onRetry={!copyError && error ? () => void refetch() : undefined}
        compact
        className="mt-4"
      />

      <IntakeFormPreviewModal
        open={!!previewTemplate}
        url={heldPreviewTemplate ? publicIntakeUrl(heldPreviewTemplate.publicToken) : null}
        name={heldPreviewTemplate?.name ?? ""}
        onClose={() => setPreviewTemplate(null)}
      />
    </div>
  );
}
