import React from 'react';
import Spinner from './Spinner';

/**
 * Any other native `<button>` attribute passes through, so a wrapper that clones
 * its child with event handlers (`<Tooltip>`) works on a `<Button>` too.
 */
type NativeButtonProps = Omit<
  React.ComponentPropsWithRef<'button'>,
  'type' | 'onClick' | 'disabled' | 'className' | 'children'
>;

interface ButtonProps extends NativeButtonProps {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Visual variant. This is NOT the HTML button type - see `htmlType`. */
  type?: 'primary' | 'secondary' | 'danger' | 'success';
  /**
   * The underlying HTML `type`. Defaults to `button` so a button placed inside a
   * form never submits it by accident; pass `submit` for the button that is
   * meant to submit.
   */
  htmlType?: 'button' | 'submit' | 'reset';
  /**
   * `compact` is the page / panel header action ("New role", "Add court"):
   * `text-xs` on a `rounded-xl` pill. The other three are the form and modal
   * footer scale on a `rounded-md` edge. Never mix the two scales in one row.
   */
  size?: 'compact' | 'small' | 'medium' | 'large';
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
  loading?: boolean;
  'aria-label'?: string;
}

const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  type = 'primary',
  htmlType = 'button',
  size = 'medium',
  disabled = false,
  className = '',
  icon,
  loading = false,
  'aria-label': ariaLabel,
  ...rest
}) => {
  // `focus-visible:` (not `focus:`) so the ring only appears for keyboard
  // navigation. On the filled `primary` variant especially, a ring that also
  // fired on mouse click read as a second outline drawn around the button
  const hasCustomScale = className.includes('active:scale-');
  const scaleClass = hasCustomScale
    ? ''
    : className.includes('w-full')
      ? 'active:scale-[0.99]'
      : 'active:scale-[0.985]';
  const baseClasses = `inline-flex items-center justify-center font-medium transition-[background-color,border-color,color,transform] duration-100 ${scaleClass} motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface)]`;

  const typeClasses = {
    primary: 'bg-accent-solid text-accent-foreground border border-transparent shadow-sm dark:shadow-none hover:bg-accent-solid-hover focus-visible:ring-accent-control-ring',
    secondary: 'bg-surface text-on-surface border border-control-border hover:bg-surface-hover focus-visible:ring-focus-ring',
    danger: 'bg-surface text-red-600 dark:text-red-400 border border-red-600 dark:border-red-800/60 hover:bg-red-50 dark:hover:bg-red-950/20 focus-visible:ring-red-500 dark:focus-visible:ring-red-600/40',
    success: 'bg-surface text-green-600 dark:text-green-400 border border-green-600 dark:border-green-500 hover:bg-green-50 dark:hover:bg-green-900/30 focus-visible:ring-green-500 dark:focus-visible:ring-green-400',
  };

  const sizeClasses = {
    compact: 'shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl',
    small: 'px-3 py-1.5 text-xs rounded-md',
    medium: 'px-4 py-2 text-sm rounded-md',
    large: 'px-6 py-3 text-base rounded-md',
  };

  const disabledClasses = disabled || loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer';

  const classes = `${baseClasses} ${typeClasses[type]} ${sizeClasses[size]} ${disabledClasses} ${className}`;

  return (
    <button
      {...rest}
      type={htmlType}
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
    >
      {loading && (
        <span className={`inline-flex ${size === 'compact' ? '' : '-ml-1 mr-2'}`}>
          <Spinner size={size === 'compact' ? 14 : 16} />
        </span>
      )}
      {!loading && icon && <span className={`inline-flex ${size === 'compact' ? '' : 'mr-2'}`}>{icon}</span>}
      {children}
    </button>
  );
};

export default Button;
