"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import Checkbox from "@/components/ui/Checkbox";
import DatePicker from "@/components/ui/DatePicker";
import TextInput from "@/components/ui/TextInput";
import Dropdown from "@/components/ui/Dropdown";
import Button from "@/components/ui/Button";
import FieldLabel, { fieldLabelClass } from "@/components/ui/FieldLabel";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import cardFeesService from "@/services/cardFees.service";
import lawFirmService from "@/services/lawfirm.service";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { US_STATE_NAMES } from "@/lib/constants/usStates";
import CardFeeCopyText from "@/components/billingComp/CardFeeCopyText";
import { CARD_FEE_SETTINGS, cardFeeUnavailableReason } from "@/lib/payments/cardFeeCopy";
import type { CardAcceptance, CardFeeIneligibleReason, CardFeeSettingsState, CardFeeSettingsUpdate } from "@/types/cardFees";

/**
 * The credit card fee half of Payments settings' "Online Payment Fees": whether
 * clients pay a fee on credit cards, what happens to debit and non-US cards,
 * the firm's Stripe rate, and the two confirmations the fee needs before it can
 * be switched on. It saves through its own route, which refuses the fee for a
 * firm that may not use it, so it has a Save button rather than saving on
 * change like the rest of the page. A firm with no state on record picks it
 * here first, since the fee's rules depend on it.
 */
export default function CardFeeSettings({ lawFirmId, canEdit }: { lawFirmId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = ["cardFeeSettings", lawFirmId];
  const { data, error, isLoading } = useQuery({
    queryKey,
    queryFn: () => cardFeesService.getCardFees(lawFirmId),
    enabled: !!lawFirmId,
  });

  if (isLoading) return <PanelLoadingSpinner label="Loading card fee settings" />;
  if (!data) return <ErrorNotification error={error instanceof Error ? error : null} compact />;
  return (
    <CardFeeForm
      // A save hands back the stored setting; remounting on it restarts the
      // form from what the server now holds.
      key={JSON.stringify(data)}
      lawFirmId={lawFirmId}
      canEdit={canEdit}
      saved={data}
      onSaved={(next) => {
        queryClient.setQueryData(queryKey, next);
        // A request's fee choice starts from this setting.
        queryClient.invalidateQueries({ queryKey: ["paymentFeeQuote", lawFirmId] });
      }}
      // The firm's state decides eligibility, so a new one means reading the
      // setting again; the request dialog's quote carries the same eligibility.
      onStateSaved={() => Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ["paymentFeeQuote", lawFirmId] }),
      ])}
    />
  );
}

const STATE_OPTIONS = US_STATE_NAMES.map((name) => ({ label: name, value: name }));

/**
 * The firm's state, picked from the card fee section when none is on record.
 * Picking one saves it onto the firm at once, refreshes the shared firm record
 * so other pages see it, and has the card fee setting read again. A member who
 * cannot change firm information is asked to get an admin to do it.
 */
function FirmStatePicker({ lawFirmId, onSaved }: { lawFirmId: string; onSaved: () => Promise<unknown> }) {
  const helpId = useId();
  const { hasPermission } = usePermissions();
  const { refetchLawFirm } = useLawFirm();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (!hasPermission("firm.update")) {
    return <p className="text-sm text-on-surface-secondary">{CARD_FEE_SETTINGS.stateAskAdmin}</p>;
  }

  const save = async (state: string) => {
    setValue(state);
    setSaving(true);
    setError(null);
    try {
      await lawFirmService.updateLawFirm(lawFirmId, { state });
      await Promise.all([refetchLawFirm(), onSaved()]);
    } catch (err) {
      setValue("");
      setError(err instanceof Error ? err : new Error("Failed to save your firm's state"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Dropdown
        label={CARD_FEE_SETTINGS.stateLabel}
        value={value}
        onChange={save}
        options={STATE_OPTIONS}
        busy={saving}
        ariaDescribedBy={helpId}
        className="sm:max-w-xs"
      />
      <p id={helpId} className="mt-1 text-xs text-on-surface-muted">{CARD_FEE_SETTINGS.stateHelp}</p>
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
    </div>
  );
}

function CardFeeForm({
  lawFirmId,
  canEdit,
  saved,
  onSaved,
  onStateSaved,
}: {
  lawFirmId: string;
  canEdit: boolean;
  saved: CardFeeSettingsState;
  onSaved: (next: CardFeeSettingsState) => void;
  onStateSaved: () => Promise<unknown>;
}) {
  const ids = useId();
  const [clientPays, setClientPays] = useState(saved.clientPays);
  const [debitCards, setDebitCards] = useState<CardAcceptance>(saved.debitCards);
  const [internationalCards, setInternationalCards] = useState<CardAcceptance>(saved.internationalCards);
  const [percentInput, setPercentInput] = useState(String(saved.ratePercent));
  const [centsInput, setCentsInput] = useState(String(saved.fixedCents));
  const [notifiedOn, setNotifiedOn] = useState("");
  const [lettersConfirmed, setLettersConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  const { eligibility } = saved;
  // The confirmation and the firm's state are what this form collects, not
  // reasons to show; a missing state is asked for with its own picker.
  const stateMissing = eligibility.reasons.includes("state_missing");
  const blocking = eligibility.reasons.filter(
    (reason): reason is Exclude<CardFeeIneligibleReason, "not_confirmed" | "state_missing"> =>
      reason !== "not_confirmed" && reason !== "state_missing",
  );
  // A firm that has the fee on keeps the switch, so it can always turn it off.
  const showSwitch = (blocking.length === 0 && !stateMissing) || saved.clientPays;
  const askConfirmation = clientPays && !saved.clientPays && !saved.confirmation;

  const ratePercent = Number(percentInput);
  const fixedCents = Number(centsInput);
  const rateValid = percentInput.trim() !== "" && Number.isFinite(ratePercent)
    && centsInput.trim() !== "" && Number.isInteger(fixedCents);
  const confirmed = !askConfirmation || (!!notifiedOn && lettersConfirmed);
  const dirty = clientPays !== saved.clientPays
    || debitCards !== saved.debitCards
    || internationalCards !== saved.internationalCards
    || ratePercent !== saved.ratePercent
    || fixedCents !== saved.fixedCents;
  const locked = !canEdit || saving;

  const save = async () => {
    const body: CardFeeSettingsUpdate = {
      clientPays,
      debitCards,
      internationalCards,
      ratePercent,
      fixedCents,
      ...(askConfirmation ? { stripeNotifiedOn: notifiedOn, engagementLetterConfirmed: true } : {}),
    };
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await cardFeesService.updateCardFees(lawFirmId, body));
    } catch (err) {
      setSaveError(err instanceof Error ? err : new Error("Failed to save card fee settings"));
      setSaving(false);
    }
  };

  const choice = (
    legend: string,
    name: string,
    value: CardAcceptance,
    onChange: (next: CardAcceptance) => void,
    labels: { absorb: string; decline: string },
  ) => (
    <fieldset className="space-y-2" disabled={locked}>
      <legend className={fieldLabelClass({})}>{legend}</legend>
      {(["absorb", "decline"] as const).map((option) => (
        <label key={option} className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={name}
            checked={value === option}
            onChange={() => onChange(option)}
            className="mt-1 accent-blue-600"
          />
          <span className="text-sm text-on-surface">{labels[option]}</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="space-y-4">
      {stateMissing && <FirmStatePicker lawFirmId={lawFirmId} onSaved={onStateSaved} />}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">{CARD_FEE_SETTINGS.toggleLabel}</p>
          <p className="text-xs text-on-surface-muted">{CARD_FEE_SETTINGS.toggleDescription}</p>
        </div>
        {showSwitch && (
          <ToggleSwitch
            checked={clientPays}
            onChange={() => setClientPays(!clientPays)}
            disabled={locked}
            ariaLabel={CARD_FEE_SETTINGS.toggleLabel}
          />
        )}
      </div>

      {blocking.length > 0 && (
        <ul className="space-y-1">
          {blocking.map((reason) => (
            <li key={reason} className="text-sm text-on-surface-secondary">
              <CardFeeCopyText parts={cardFeeUnavailableReason(reason, eligibility)} lawFirmId={lawFirmId} />
            </li>
          ))}
        </ul>
      )}

      <div>
        <p id={`${ids}-how`} className="text-xs font-medium text-on-surface">{CARD_FEE_SETTINGS.howItWorksHeading}</p>
        <ul aria-labelledby={`${ids}-how`} className="mt-1 list-disc pl-4 space-y-0.5 text-xs text-on-surface-secondary">
          {CARD_FEE_SETTINGS.howItWorks.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {clientPays && (
        <div className="pt-4 border-t border-outline-subtle space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {choice(CARD_FEE_SETTINGS.debitLabel, `${ids}-debit`, debitCards, setDebitCards, CARD_FEE_SETTINGS.debitOptions)}
            {choice(
              CARD_FEE_SETTINGS.internationalLabel,
              `${ids}-international`,
              internationalCards,
              setInternationalCards,
              CARD_FEE_SETTINGS.internationalOptions,
            )}
          </div>

          <fieldset className="space-y-1.5" disabled={locked} aria-describedby={`${ids}-rate-help`}>
            <legend className={fieldLabelClass({})}>{CARD_FEE_SETTINGS.rateLabel}</legend>
            <div className="flex items-center gap-2">
              <div className="relative w-28">
                <TextInput
                  type="number"
                  min="0"
                  max="3.5"
                  step="0.01"
                  value={percentInput}
                  onChange={(e) => setPercentInput(e.target.value)}
                  aria-label={CARD_FEE_SETTINGS.ratePercentLabel}
                  className="pr-8 disabled:opacity-50"
                />
                <span aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">%</span>
              </div>
              <span aria-hidden className="text-sm text-on-surface-muted">+</span>
              <div className="relative w-32">
                <TextInput
                  type="number"
                  min="0"
                  max="50"
                  step="1"
                  value={centsInput}
                  onChange={(e) => setCentsInput(e.target.value)}
                  aria-label={CARD_FEE_SETTINGS.rateFixedLabel}
                  className="pr-14 disabled:opacity-50"
                />
                <span aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">cents</span>
              </div>
            </div>
            <p id={`${ids}-rate-help`} className="text-xs text-on-surface-muted">{CARD_FEE_SETTINGS.rateHelp}</p>
          </fieldset>

          {askConfirmation && (
            <div className="pt-4 border-t border-outline-subtle space-y-4">
              <div>
                <FieldLabel id={`${ids}-notified`}>{CARD_FEE_SETTINGS.notifiedOnLabel}</FieldLabel>
                <DatePicker value={notifiedOn} onChange={setNotifiedOn} disabled={locked} ariaLabelledBy={`${ids}-notified`} className="sm:max-w-xs" />
                <p className="mt-1 text-xs text-on-surface-muted">
                  <CardFeeCopyText parts={CARD_FEE_SETTINGS.notifiedOnHelp} lawFirmId={lawFirmId} />
                </p>
              </div>
              <Checkbox
                checked={lettersConfirmed}
                onChange={setLettersConfirmed}
                disabled={locked}
                label={CARD_FEE_SETTINGS.engagementLetter}
              />
            </div>
          )}
        </div>
      )}

      <ErrorNotification error={saveError} onClose={() => setSaveError(null)} compact />

      {canEdit && showSwitch && (
        <div className="flex justify-end">
          <Button type="primary" onClick={save} loading={saving} disabled={!dirty || !rateValid || !confirmed}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
