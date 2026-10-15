"use client";

import { useCallback, useState } from "react";
import dayjs from "dayjs";
import { EMPTY_PAYMENT_PLAN, type PaymentPlanFormValues } from "@/components/billingComp/PaymentPlanFields";

/** Shared editable invoice metadata and payment setup for a loaded billing target. */
export default function useInvoiceDraft() {
  const [invoiceName, setInvoiceName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [dueDate, setDueDate] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [remitTo, setRemitTo] = useState({
    name: "",
    address: "",
    city: "",
    state: "",
    zip: "",
  });

  const [prePayments, setPrePayments] = useState<Array<{
    id: string;
    amount: string;
    date: string;
    invoiceNumber: string;
    note: string;
  }>>([]);
  const [editingPrePayments, setEditingPrePayments] = useState<Set<string>>(new Set());

  const [paymentPlanOpen, setPaymentPlanOpen] = useState(false);
  const [paymentPlanEnabled, setPaymentPlanEnabled] = useState(false);
  const [paymentPlan, setPaymentPlan] = useState<PaymentPlanFormValues>({
    ...EMPTY_PAYMENT_PLAN,
    startDate: dayjs().format("YYYY-MM-DD"),
  });
  const updatePaymentPlan = useCallback((patch: Partial<PaymentPlanFormValues>) => {
    setPaymentPlan((prev) => ({ ...prev, ...patch }));
  }, []);

  return {
    invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate,
    dueDate, setDueDate, billingEmail, setBillingEmail, notes, setNotes, remitTo, setRemitTo,
    prePayments, setPrePayments, editingPrePayments, setEditingPrePayments,
    paymentPlanOpen, setPaymentPlanOpen, paymentPlanEnabled, setPaymentPlanEnabled,
    paymentPlan, setPaymentPlan, updatePaymentPlan,
  };
}
