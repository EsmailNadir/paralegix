import CourtField from "@/components/courtsComp/CourtField";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof CourtField>, "value" | "onChange" | "loading"> & {
  courtId: string;
  setCourtId: (value: string) => void;
  loading?: boolean;
};

export default function TaskCourtField({ courtId, setCourtId, loading = false, ...props }: Props) {
  return <CourtField {...props} value={courtId} onChange={setCourtId} loading={loading} />;
}
