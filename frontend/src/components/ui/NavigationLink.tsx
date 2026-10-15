"use client";

import { useNavigation } from "@/contexts/NavigationContext";

/** Keep native link behavior while ordinary activation uses the app shell. */
export default function NavigationLink({
  href,
  onClick,
  target,
  ...props
}: React.ComponentPropsWithRef<"a"> & { href: string }) {
  const { navigate } = useNavigation();
  return (
    <a
      {...props}
      href={href}
      target={target}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          event.button !== 0 || (target && target !== "_self") ||
          (props.download != null && props.download !== false)
        ) return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}
