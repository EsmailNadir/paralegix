import Spinner from "@/components/ui/Spinner";

interface PanelLoadingSpinnerProps {
  label: string;
  className?: string;
}

/** Centers the standard small spinner while a settings panel has no content to show yet. */
export default function PanelLoadingSpinner({ label, className = "" }: PanelLoadingSpinnerProps) {
  return (
    <div className={`flex items-center justify-center px-6 py-8 ${className}`}>
      <Spinner size={20} className="text-on-surface-muted" label={label} />
    </div>
  );
}
